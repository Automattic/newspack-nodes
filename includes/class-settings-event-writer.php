<?php
/**
 * Settings_Event_Writer — the producer end of the settings-sync node graph.
 *
 * On a watched WP-option change, appends an event to `settings.p0`. A worker
 * Consumer tails that log, and Settings_Sync_Node looks the option up and pushes
 * its CURRENT value at consume time — so the excerpts recorded here are an audit
 * trail, never the payload a spoke receives.
 *
 * The audit model has three rules. The option NAME is recorded ALWAYS. Bounded
 * OLD/NEW value excerpts ride ONLY for options on an explicit allowlist
 * (`newspack_nodes/settings_audit_values_allowlist`, defaulting to the
 * substrate's own Settings_Schema option names). The encrypted vault option is
 * refused before that filter is consulted, so nothing can opt it back in —
 * fail-closed, not a denylist.
 *
 * A name-only record fits under PIPE_BUF, which is what keeps the append atomic
 * and lockless (ADR-4); WordPress caps `option_name` at 191 characters, so in
 * practice the name alone cannot overflow the line. A values record is fitted to
 * that same cap and, when nothing is left to trim, drops to name-only rather
 * than dropping the event.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Appends settings-change events (name always, values only by allowlist) to settings.p0.
 *
 * Static throughout, and not a Node: the option hooks fire inside whatever
 * request changed the setting, where no event loop and no node graph are
 * running, so each append builds a Partition, writes through it and tears it
 * down within the callback.
 */
class Settings_Event_Writer {

	/** Age rule: prune segments older than a day, down to SETTINGS_MIN_SEGMENTS. */
	public const SETTINGS_LIFETIME     = 86400;

	/** Segment directory under the logs dir; Log_Cleaner declares it for retention. */
	public const SETTINGS_LOG_DIR      = 'settings.p0';

	/** Hard cap: 0 derives it as 2 × num_segments. Spelled out because two slots follow it. */
	public const SETTINGS_MAX_SEGMENTS = 0;

	/** Count-rule floor: 0 protects nothing, so the count rule prunes at num_segments. */
	public const SETTINGS_MIN_LIFETIME = 0;

	/** Age-rule floor: keep two segments however old they are. */
	public const SETTINGS_MIN_SEGMENTS = 2;

	/** Count-rule target: prune the oldest back to two segments. */
	public const SETTINGS_NUM_SEGMENTS = 2;

	/** Rotation threshold: a write that would pass 5 MiB starts a new segment. */
	public const SETTINGS_SEGMENT_SIZE = 5242880;

	/** Per-side character cap on a value excerpt; fit_to_line enforces the byte cap. */
	private const EXCERPT_MAX_CHARS = 200;

	/** The filter that overrides the values allowlist (defaults to Settings_Schema options). */
	private const ALLOWLIST_FILTER = 'newspack_nodes/settings_audit_values_allowlist';

	/** Watch gate: an option whose name lacks this prefix emits nothing at all. */
	private const WATCH_PREFIX = 'newspack_';

	/**
	 * Atomic-append seam. Lazily-defaulted to a closure that constructs a
	 * transient `settings:writer` Partition, appends, flushes, and tears it down.
	 * Tests reassign in setUp to capture the Message without touching the
	 * filesystem; leaving it null exercises the real append path.
	 *
	 * Signature: `function ( array $m ): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $append_seam = null;

	/** Idempotency guard for init(). */
	private static bool $initialized = false;

	/**
	 * `update_option` hook callback. An allowlisted option carries both sides.
	 *
	 * @api Registered dynamically via add_action by init().
	 * @param string $option Option name.
	 * @param mixed  $old    Old value (excerpted only for allowlisted options).
	 * @param mixed  $new    New value (excerpted only for allowlisted options).
	 */
	public static function on_update( string $option, $old, $new ): void {
		self::maybe_emit( $option, [ 'old' => $old, 'new' => $new ] );
	}

	/**
	 * `add_option` hook callback. A brand-new option carries a NEW value only.
	 *
	 * @api Registered dynamically via add_action by init().
	 * @param string $option Option name.
	 * @param mixed  $value  New value (excerpted only for allowlisted options).
	 */
	public static function on_add( string $option, $value ): void {
		self::maybe_emit( $option, [ 'new' => $value ] );
	}

	/**
	 * `delete_option` hook callback. Resetting a setting to its default deletes
	 * the option row — Reset_Gate short-circuits `update_option` — so without this
	 * hook a reset never reaches the spokes. The downstream push then reads the
	 * absent option and the value resolver ships the file default.
	 *
	 * @api Registered dynamically via add_action by init().
	 * @param string $option Option name.
	 */
	public static function on_delete( string $option ): void {
		// @longform delete_option fires pre-delete, so get_option still
		// returns the OLD value — but only fetch it for allowlisted names;
		// the common name-only path pays no extra get_option.
		$values = self::is_allowlisted( $option ) ? [ 'old' => \get_option( $option ) ] : [];
		self::maybe_emit( $option, $values );
	}

	/**
	 * Emit a TM_STRUCT settings-change event for a watched option: the name
	 * always, old/new only when the option is allowlisted, and only once the
	 * packed record fits under PIPE_BUF. An option outside WATCH_PREFIX emits
	 * nothing, which is what keeps every other WordPress option off this log.
	 *
	 * @param string              $option Option name.
	 * @param array<string,mixed> $values Raw old/new values keyed 'old'/'new' (either may be absent).
	 */
	private static function maybe_emit( string $option, array $values ): void {
		if ( 0 !== \strpos( $option, self::WATCH_PREFIX ) ) {
			return;
		}

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = self::build_record( $option, $values );
		$message                   = self::fit_to_line( $message, $option );

		$seam = self::$append_seam;
		if ( null !== $seam ) {
			$seam( $message );
			return;
		}
		self::default_append( $message );
	}

	/**
	 * Default atomic append: build a transient `settings:writer` Partition, fill
	 * it, flush it and tear it down.
	 *
	 * A named node registers itself in Core, so a second option update in the
	 * same request would collide on that name and leak the first Partition;
	 * `remove_node()` in the `finally` deregisters it even when the fill or the
	 * flush throws. `flush()` forces the batched bytes to disk while the handle
	 * is still open.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 * @throws Worker_Should_Stop When a cooperative stop lands mid-append.
	 */
	private static function default_append( array $message ): void {
		// Runs on EVERY update_option; never fatal the caller we observe.
		$writer = null;
		try {
			$dir    = Config::get_logs_directory() . '/' . self::SETTINGS_LOG_DIR;
			$writer = new Partition_Node();
			$writer->name( 'settings:writer' );
			$writer->arguments( self::partition_args( $dir ) );
			$writer->fill( $message );
			$writer->flush();
		} catch ( Worker_Should_Stop $e ) {
			throw $e; // ADR-14: a cooperative stop is not a write failure.
		} catch ( \Throwable $e ) {
			Core::print_less_often( 'settings-writer: ' . $e->getMessage() );
		} finally {
			$writer?->remove_node();
		}
	}

	/**
	 * Retention geometry for the settings log, in Partition's positional order:
	 * directory, segment size, min_segments, num_segments, max_segments,
	 * min_lifetime, lifetime.
	 *
	 * The day is an AGE rule (lifetime) and the count target is 2. The two are a
	 * slot apart, and 86400 landing in the num_segments slot licenses 86400
	 * segments rather than a day of them, which is why every slot here is a named
	 * constant. The hard cap passes 0 to derive as 2 × num_segments and never
	 * binds, because min_lifetime is 0 and the count rule prunes to 2 first.
	 *
	 * @param string $dir Segment directory.
	 * @return list<string>
	 */
	public static function partition_args( string $dir ): array {
		return \array_map( '\strval', [
			$dir,
			self::SETTINGS_SEGMENT_SIZE,
			self::SETTINGS_MIN_SEGMENTS,
			self::SETTINGS_NUM_SEGMENTS,
			self::SETTINGS_MAX_SEGMENTS,
			self::SETTINGS_MIN_LIFETIME,
			self::SETTINGS_LIFETIME,
		] );
	}

	/**
	 * Fit the packed record under the settings log's PIPE_BUF line (ADR-4). The
	 * character cap is only a proxy, since a multibyte character JSON-packs to as
	 * much as 12 bytes, so this measures `packed_size()` and halves both excerpts
	 * until the line fits. When nothing is left to trim, the record drops to
	 * name-only: the change still records, only its values are lost.
	 *
	 * This deliberately avoids `Line_Fitter::fit()`, which drains one field
	 * before opening the next. An option's `old` and `new` usually have the same
	 * shape, and at equal sizes that sacrifice order empties `old` entirely,
	 * where halving both together keeps a sample of each. The record exists to
	 * show what a setting changed from and to, so a policy that reliably discards
	 * one side is the wrong one here. Line_Fitter is better on a
	 * LOPSIDED pair — it leaves a short `new` intact instead of halving it for no
	 * size win — and that trade is accepted deliberately.
	 *
	 * @param array<int,mixed> $message The minted record message.
	 * @param string           $option  Option name, for the name-only fallback.
	 * @return array<int,mixed>
	 */
	private static function fit_to_line( array $message, string $option ): array {
		while ( Message::packed_size( $message ) + 1 > Partition_Node::MAX_LINE_SIZE ) {
			$value = $message[ Message::VALUE ];
			if ( ! \is_array( $value ) ) {
				return $message; // Narrows the type: VALUE is our record.
			}
			$trimmed = false;
			foreach ( [ 'old', 'new' ] as $side ) {
				$excerpt = Core::as_string( $value[ $side ] ?? '' );
				if ( '' !== $excerpt ) {
					$value[ $side ] = \mb_substr( $excerpt, 0, \intdiv( \mb_strlen( $excerpt ), 2 ) );
					$trimmed        = true;
				}
			}
			if ( ! $trimmed ) {
				$message[ Message::VALUE ] = [ 'option' => $option ];
				return $message;
			}
			$message[ Message::VALUE ] = $value;
		}
		return $message;
	}

	/**
	 * The record for an event: `[ 'option' => name ]` always, plus bounded 'old'/'new'
	 * excerpts when the option is allowlisted (each side present only if supplied).
	 *
	 * @param string              $option Option name.
	 * @param array<string,mixed> $values Raw old/new values keyed 'old'/'new'.
	 * @return array<string,string>
	 */
	private static function build_record( string $option, array $values ): array {
		$record = [ 'option' => $option ];
		if ( ! self::is_allowlisted( $option ) ) {
			return $record;
		}
		foreach ( [ 'old', 'new' ] as $side ) {
			if ( \array_key_exists( $side, $values ) ) {
				$record[ $side ] = self::excerpt( $values[ $side ] );
			}
		}
		return $record;
	}

	/**
	 * A bounded, human-readable excerpt of a value: its JSON encoding (unicode
	 * kept legible) truncated to EXCERPT_MAX_CHARS characters, or an empty string
	 * when the value will not encode. Multibyte characters re-escape larger once
	 * the whole record is packed, so fit_to_line enforces the byte cap.
	 *
	 * A numeric string normalizes to its number first: `update_option()`'s $old
	 * always comes back from the options table as a string (WP options are text
	 * columns; every scalar round-trips as one), while an int-typed
	 * Settings_Schema field's sanitizer hands $new a genuine PHP int — so an
	 * unchanged value would otherwise excerpt as `"900"` on one side and `900`
	 * on the other, a type artifact with no bearing on the setting's actual value.
	 *
	 * @param mixed $value Raw option value.
	 */
	private static function excerpt( $value ): string {
		if ( \is_string( $value ) && \is_numeric( $value ) ) {
			$value += 0;
		}
		$json = \wp_json_encode( $value, \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE );
		if ( ! \is_string( $json ) ) {
			return '';
		}
		return \mb_substr( $json, 0, self::EXCERPT_MAX_CHARS );
	}

	/**
	 * Whether an option may carry value excerpts: it is on the
	 * Settings_Schema-derived allowlist, which ALLOWLIST_FILTER may replace. The
	 * vault option is refused before that filter is consulted, so no filter can
	 * opt the encrypted credential store back in.
	 *
	 * @param string $option Option name.
	 */
	private static function is_allowlisted( string $option ): bool {
		if ( Vault::OPTION_KEY === $option ) {
			return false;
		}
		$defaults = Settings_Schema::get()->setting_option_names();
		$list     = \apply_filters( self::ALLOWLIST_FILTER, $defaults );
		return \is_array( $list ) && \in_array( $option, $list, true );
	}

	/**
	 * Register the `update_option`, `add_option` and `delete_option` hooks once.
	 *
	 * @api Bootstrap entrypoint — called from the substrate wiring block.
	 */
	public static function init(): void {
		if ( self::$initialized ) {
			return;
		}
		self::$initialized = true;
		// @longform
		// Arming the hooks arms what resolving their args needs. The
		// writer builds a Partition per change, and Partition's schema
		// defaults carry `<config:*>` tokens resolved STRICTLY — with no
		// namespace the construction throws and the event is dropped.
		// ensure_runtime_wired() registers it too, but it is lazy and an
		// option change beats it. Registering twice costs nothing: the
		// namespace is one closure in a map.
		Config::register_token_namespace();
		\add_action( 'update_option', [ self::class, 'on_update' ], 10, 3 );
		\add_action( 'add_option', [ self::class, 'on_add' ], 10, 2 );
		\add_action( 'delete_option', [ self::class, 'on_delete' ], 10, 1 );
	}
}
