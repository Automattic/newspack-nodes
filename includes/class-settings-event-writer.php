<?php
/**
 * Settings_Event_Writer — the producer end of the settings-sync node graph.
 *
 * On a watched WP-option change (admin request), appends an event to
 * `settings.p0`. A worker Consumer tails it; Settings_Sync_Node looks the option
 * up and pushes its CURRENT value at consume time.
 *
 * The audit model, three rules: the option NAME is recorded ALWAYS; bounded
 * OLD/NEW value excerpts ride ONLY for options on an explicit allowlist
 * (`newspack_nodes/settings_audit_values_allowlist`, defaulting to the
 * substrate's own Settings_Schema option names); the encrypted vault option is
 * hard-excluded from values FOREVER — a fail-closed security invariant, not a
 * denylist. A name-only record is always <= PIPE_BUF (an atomic lockless append,
 * firehose discipline); a values record is packed-fit under PIPE_BUF and, if
 * unfittable, drops to name-only rather than dropping the event.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Appends settings-change events (name always, values only by allowlist) to settings.p0.
 */
class Settings_Event_Writer {

	public const SETTINGS_LOG_DIR      = 'settings.p0';
	public const SETTINGS_MAX_LIFETIME = 86400;
	public const SETTINGS_MAX_SEGMENTS = 2;
	public const SETTINGS_MIN_LIFETIME = 0;
	public const SETTINGS_MIN_SEGMENTS = 2;
	public const SETTINGS_SEGMENT_SIZE = 5242880;

	/** Per-side character cap on a value excerpt, applied before the packed-fit. */
	private const EXCERPT_MAX_CHARS = 200;

	/** The filter that overrides the values allowlist (defaults to Settings_Schema options). */
	private const ALLOWLIST_FILTER = 'newspack_nodes/settings_audit_values_allowlist';

	/** Only options whose name starts with this prefix are watched. */
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
	 * Emit a TM_STRUCT settings-change event: name always, old/new only when the
	 * option is allowlisted, and only after the packed record fits under PIPE_BUF.
	 *
	 * @param string               $option Option name.
	 * @param array<string, mixed> $values Raw old/new values keyed 'old'/'new' (either may be absent).
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
	 * The record for an event: `[ 'option' => name ]` always, plus bounded 'old'/'new'
	 * excerpts when the option is allowlisted (each side present only if supplied).
	 *
	 * @param string               $option Option name.
	 * @param array<string, mixed> $values Raw old/new values keyed 'old'/'new'.
	 * @return array<string, string>
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
	 * Whether an option may carry value excerpts: on the Settings_Schema-derived
	 * allowlist (filter-overridable), minus the vault option (hard security exclude).
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
	 * A bounded, human-readable excerpt of a value: its JSON encoding (unicode kept
	 * legible) truncated to EXCERPT_MAX_CHARS characters. Multibyte chars re-escape
	 * larger when the whole record is packed — fit_to_line enforces the byte cap.
	 *
	 * @param mixed $value Raw option value.
	 */
	private static function excerpt( $value ): string {
		$json = \wp_json_encode( $value, \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE );
		if ( ! \is_string( $json ) ) {
			return '';
		}
		return \mb_substr( $json, 0, self::EXCERPT_MAX_CHARS );
	}

	/**
	 * Fit the packed record under the settings log's PIPE_BUF line. Mirrors
	 * Job_Probe_Node::fit_to_line — the char cap is a proxy (a multibyte char JSON-
	 * packs to up to 12 bytes), so measure packed_size and halve the old/new excerpts
	 * until the line fits. When nothing's left to trim, drop to name-only (always
	 * emits): the change still records, only its values are dropped.
	 *
	 * @param array<int, mixed> $message The minted record message.
	 * @param string            $option  Option name, for the name-only fallback.
	 * @return array<int, mixed>
	 */
	private static function fit_to_line( array $message, string $option ): array {
		while ( Message::packed_size( $message ) + 1 > Partition_Node::MAX_LINE_SIZE ) {
			$value = $message[ Message::VALUE ];
			if ( ! \is_array( $value ) ) {
				return $message; // VALUE is always our record; guard narrows the type.
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
	 * Default atomic append: a transient `settings:writer` Partition fills + flushes
	 * + tears down. A named node registers in Core, so without teardown a 2nd option
	 * update in the same request would collide + leak; flush() forces the batched
	 * bytes to disk while the handle is open; remove_node() deregisters (try/finally
	 * guarantees teardown even if fill/flush throws).
	 *
	 * @param array<int, mixed> $message The 7-field positional message array.
	 */
	private static function default_append( array $message ): void {
		$writer = new Partition_Node();
		$writer->name( 'settings:writer' );
		$writer->arguments( self::partition_args( Config::get_logs_directory() . '/' . self::SETTINGS_LOG_DIR ) );
		try {
			$writer->fill( $message );
			$writer->flush();
		} finally {
			$writer->remove_node();
		}
	}

	/**
	 * Full six-axis geometry for the settings log. This used to pass `2 86400` —
	 * a LIFETIME in the max_segments slot, licensing 86400 segments. The day is
	 * an AGE rule; the count is 2.
	 *
	 * @param string $dir Segment directory.
	 * @return list<string>
	 */
	public static function partition_args( string $dir ): array {
		return \array_map( '\strval', [
			$dir,
			self::SETTINGS_SEGMENT_SIZE,
			self::SETTINGS_MIN_SEGMENTS,
			self::SETTINGS_MAX_SEGMENTS,
			self::SETTINGS_MIN_LIFETIME,
			self::SETTINGS_MAX_LIFETIME,
		] );
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
	 * the option row (Reset_Gate short-circuits update_option), so without this
	 * the reset-to-default never propagates to spokes — the downstream push then
	 * reads the now-absent option and the value-resolver ships the file default.
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
	 * Register the option hooks once.
	 *
	 * @api Bootstrap entrypoint — called from the substrate wiring block.
	 */
	public static function init(): void {
		if ( self::$initialized ) {
			return;
		}
		self::$initialized = true;
		\add_action( 'update_option', [ self::class, 'on_update' ], 10, 3 );
		\add_action( 'add_option', [ self::class, 'on_add' ], 10, 2 );
		\add_action( 'delete_option', [ self::class, 'on_delete' ], 10, 1 );
	}
}
