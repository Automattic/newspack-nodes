<?php
/**
 * Newspack Nodes runtime configuration.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

if ( ! \defined( 'ABSPATH' ) ) {
	exit;
}

class Config {

	/**
	 * Action fired while deriving the declared set; consumer plugins declare their keys here.
	 *
	 * Contract for a callback: call `Config::register_keys()` and nothing else. It runs
	 * from INSIDE a config read (any request, any process), so config reads, option
	 * writes, or I/O from a callback fire at an unpredictable point in the request —
	 * and a read of a still-undeclared key from here is re-entrant (bounded by the
	 * declaring guard, but it will not see keys a later callback declares).
	 */
	public const DECLARE_ACTION = 'newspack_nodes/declare_config_keys';

	/** Action fired from reset() so dependent Configs can invalidate their caches. */
	public const RESET_ACTION = 'newspack_nodes/config_reset';

	/** @var array<string,mixed>|null Cached config (file defaults + WordPress options). */
	private static $config = null;

	/** @var array<string,mixed>|null Cached config defaults from files. */
	private static $config_defaults = null;

	/**
	 * Keys the shipped config named that no Field declares. Reported, never
	 * thrown — see `note_unrecognized_keys()`.
	 *
	 * @var list<string>
	 */
	private static array $unrecognized = [];

	/**
	 * Shipped-config read seam. Tests reassign to inject a file that is not on
	 * disk, which is the only way to exercise an operator's stale key.
	 * Signature: `function (array $base): array`
	 *
	 * @var \Closure(array<string,mixed>): array<string,mixed>|null
	 */
	public static ?\Closure $read_shipped_config = null;

	/** @var bool Inside declare_keys(): a DECLARE_ACTION callback that reads config can't re-enter. */
	private static bool $declaring = false;

	/** @var bool declare_keys() ran; reset() clears it so a reload re-derives. */
	private static bool $keys_declared = false;

	/** @var array<string,bool> Declared config keys; only these may be read via value(). */
	private static array $registered_keys = [];

	/** @var string|null */
	private static ?string $validated_base_directory = null;

	/** @var array<string,string> Memoized base-relative subdirs (logs/locks/offsets); cleared by reset(). */
	private static array $validated_subdirs = [];

	/**
	 * Get the logs directory path ({base}/logs).
	 *
	 * @api
	 * @return string
	 * @throws \RuntimeException If base or logs directory cannot be created or realpath doesn't match.
	 */
	public static function get_logs_directory(): string {
		return self::validated_subdir( 'logs' );
	}

	/**
	 * Refuse a storage path outside the runtime tree. `/command` is full graph
	 * construction at manage_options, so on a stock install this crosses no
	 * boundary — but where administrator file writes are deliberately disabled
	 * (DISALLOW_FILE_MODS, VIP-style installs) an unconstrained partition path
	 * restores an arbitrary write. Empty is unconfigured, not an escape. Tail is
	 * deliberately NOT constrained: reading /var/log/... is its whole job.
	 *
	 * @throws \RuntimeException When the path escapes the base directory.
	 */
	public static function assert_within_base( string $path ): void {
		if ( '' === $path || self::within_base( $path ) ) {
			return;
		}
		throw new \RuntimeException(
			\esc_html( \sprintf( 'storage path %s is outside the runtime base directory', $path ) )
		);
	}

	/**
	 * Whether a path lies inside the runtime base directory.
	 *
	 * Lexical, not realpath: a partition directory is created lazily, so the
	 * path usually does not exist yet at validation time. `..` and `.` are
	 * resolved first so traversal cannot walk out.
	 */
	public static function within_base( string $path ): bool {
		$base = \rtrim( self::get_base_directory(), '/' );
		$norm = self::lexical_path( $path );
		return $norm === $base || \str_starts_with( $norm, $base . '/' );
	}

	/** Collapse `.`/`..` segments without touching the filesystem. */
	private static function lexical_path( string $path ): string {
		$out = [];
		foreach ( \explode( '/', $path ) as $seg ) {
			if ( '' === $seg || '.' === $seg ) {
				continue;
			}
			if ( '..' === $seg ) {
				\array_pop( $out );
				continue;
			}
			$out[] = $seg;
		}
		$prefix = \str_starts_with( $path, '/' ) ? '/' : '';
		return $prefix . \implode( '/', $out );
	}

	/**
	 * Get the locks directory path ({base}/locks).
	 *
	 * @return string
	 * @throws \RuntimeException If base or locks directory cannot be created or realpath doesn't match.
	 */
	public static function get_locks_directory(): string {
		return self::validated_subdir( 'locks' );
	}

	/**
	 * Get the offsets directory path ({base}/offsets).
	 *
	 * @return string
	 * @throws \RuntimeException If base or offsets directory cannot be created or realpath doesn't match.
	 */
	public static function get_offsets_directory(): string {
		return self::validated_subdir( 'offsets' );
	}

	/**
	 * Memoized `{base}/{sub}` path (created + realpath-checked via ensure_path).
	 *
	 * @throws \RuntimeException If base or the subdir cannot be created or realpath doesn't match.
	 */
	private static function validated_subdir( string $sub ): string {
		return self::$validated_subdirs[ $sub ] ??= self::ensure_path( self::get_base_directory() . '/' . $sub );
	}

	public static function get_base_directory(): string {
		if ( null !== self::$validated_base_directory ) {
			return self::$validated_base_directory;
		}

		$config   = self::load_config();
		$base_dir = $config['base_directory'] ?? null;
		if ( empty( $base_dir ) || ! \is_scalar( $base_dir ) ) {
			throw new \RuntimeException( 'base_directory not configured' );
		}

		self::$validated_base_directory = self::ensure_path( (string) $base_dir );
		return self::$validated_base_directory;
	}

	/**
	 * Ensure a directory path exists and is canonical (realpath must match input — detects symlink attacks).
	 *
	 * @param string $path Directory path to ensure.
	 * @return string Validated canonical path.
	 * @throws \RuntimeException If path cannot be created or is not canonical.
	 */
	public static function ensure_path( string $path ): string {
		if ( false !== \strpos( $path, "\0" ) ) {
			throw new \RuntimeException( 'Path contains null byte' );
		}

		$path = \rtrim( $path, '/' );

		if ( ! \is_dir( $path ) ) {
			// phpcs:ignore WordPressVIPMinimum.Functions.RestrictedFunctions.directory_mkdir
			@\mkdir( $path, 0700, true );
		}

		$real = \realpath( $path );
		if ( false === $real ) {
			throw new \RuntimeException(
				\sprintf( 'Failed to create directory: %s', \esc_html( $path ) )
			);
		}

		// @longform The plantable attack is a symlink AT the leaf redirecting
		// writes; symlinked ANCESTORS (macOS /tmp, /var -> /private/...) are
		// OS facts. So: leaf must be a real dir, and the whole path must
		// equal its parent-resolved expectation (catches `..` traversal too).
		$parent = \realpath( \dirname( $path ) );
		if ( \is_link( $path ) || false === $parent || \rtrim( $parent, '/' ) . '/' . \basename( $path ) !== $real ) {
			throw new \RuntimeException(
				\sprintf(
					'Path %s resolves to %s - symlink or path traversal detected',
					\esc_html( $path ),
					\esc_html( $real )
				)
			);
		}

		self::assert_private_to_us( $real );

		return $real;
	}

	/**
	 * Refuse a runtime directory this process does not privately own.
	 *
	 * ensure_path() skips mkdir when the directory already exists, so the tree
	 * is ADOPTED as readily as created. Whoever wins the race to a predictable
	 * base path owns every log, lock, offset and topology beneath it — and a
	 * planted topology executes with full interpreter authority on the next
	 * worker spawn. `wp nodes doctor` computes the same comparison advisorily.
	 *
	 * Skipped without posix (no uid to compare); the symlink and traversal
	 * checks stand on their own there.
	 *
	 * Root is exempt from the refusal. The gate defends against a LOWER-
	 * privileged adopter racing a predictable path, and root already owns the
	 * box — refusing to boot buys nothing. Root's real hazard is the opposite
	 * direction: files it writes here are root-owned, and the workers run as
	 * the web user, so they are the ones left unable to write. That warns.
	 *
	 * @throws \RuntimeException When another NON-ROOT uid owns it, or group/other can write.
	 */
	private static function assert_private_to_us( string $real ): void {
		$uid   = CLI::uid();
		$owner = @\fileowner( $real ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		if ( $uid < 0 || false === $owner ) {
			return;
		}
		if ( 0 === $uid ) {
			self::warn_root_writes( $real );
		} elseif ( $owner !== $uid ) {
			throw new \RuntimeException(
				\esc_html(
					\sprintf(
						'Runtime directory %s is owned by uid %d, but this process runs as uid %d',
						$real,
						$owner,
						$uid
					)
				)
			);
		}
		$perms = @\fileperms( $real ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
		if ( false !== $perms && 0 !== ( $perms & 0022 ) ) {
			throw new \RuntimeException(
				\esc_html(
					\sprintf(
						'Runtime directory %s is writable by group or other (mode %o)',
						$real,
						$perms & 0777
					)
				)
			);
		}
	}

	/**
	 * Rate-limited notice that this root process may strand the workers.
	 *
	 * @param string $real Resolved runtime directory.
	 */
	private static function warn_root_writes( string $real ): void {
		Core::print_less_often(
			'WARNING: running as root; refusing writes under ',
			$real,
			' - they would be root-owned and unwritable by the workers'
		);
	}

	/**
	 * Fail-loud single-key config read: an undeclared key throws instead of
	 * limping on a `?? default` — that's the guard that catches a renamed or
	 * typo'd key. A declared key resolves to load_config()[$key] (option overlay
	 * or file default); declared-but-unset returns null.
	 *
	 * @api
	 * @return mixed
	 * @throws \RuntimeException If $key is not in the registered set.
	 */
	public static function value( string $key ): mixed {
		if ( ! self::is_declared( $key ) ) {
			throw new \RuntimeException(
				\sprintf( "unknown config key '%s' — not declared by any registered schema", \esc_html( $key ) )
			);
		}
		$config = self::load_config();
		return \array_key_exists( $key, $config ) ? $config[ $key ] : null;
	}

	/**
	 * Whether $key is in the registered set. This is the primitive a consumer
	 * plugin's own value() accessor calls to validate a key against the shared
	 * substrate registry before reading its own merged config.
	 *
	 * A miss re-fires DECLARE_ACTION before it answers false: a consumer plugin
	 * that loads AFTER the first read (this plugin's own file scope reads
	 * memcache_servers on an admin request) hooks the action too late for that
	 * pull, and a one-shot derive would deny its keys for the rest of the
	 * request. Only the action re-fires — the substrate's own keys are already
	 * registered (declarations are monotone) — and only on a miss, which
	 * otherwise ends in a throw anyway.
	 *
	 * @api
	 */
	public static function is_declared( string $key ): bool {
		self::declare_keys();
		if ( isset( self::$registered_keys[ $key ] ) ) {
			return true;
		}
		if ( \function_exists( 'do_action' ) && ! self::$declaring ) {
			self::$declaring = true;
			try {
				\do_action( self::DECLARE_ACTION );
			} finally {
				self::$declaring = false;
			}
		}
		return isset( self::$registered_keys[ $key ] );
	}

	/**
	 * Derive the declared set on first read: the substrate's own keys (the
	 * Settings_Schema overlay keys, which is every Field with a key), then
	 * DECLARE_ACTION so every consumer plugin declares its own. NOT the config
	 * file's keys — deriving from the file makes an operator's typo
	 * self-declaring, and leaves an install whose file predates a key unable to
	 * read it at all.
	 *
	 * Declaration is PULLED, not pushed, because push has no safe moment to happen:
	 * Bootstrap wiring runs on diagnostic and storage-backed entry points only (never
	 * a frontend page view), and a consumer sorting before newspack-nodes can't touch
	 * this class at its own file scope — so both hung declaration off something that
	 * fires AFTER the first read (the firehose reads num_partitions at
	 * plugins_loaded:-10001) and the fail-loud value() gate threw on a real key.
	 * Pulling it here means the keys exist by construction whenever anyone asks.
	 *
	 * Costs nothing on the hot path: load_config() already builds the schema on
	 * any request that reads config.
	 */
	private static function declare_keys(): void {
		if ( self::$keys_declared || self::$declaring ) {
			return;
		}
		self::$keys_declared = true;
		self::$declaring     = true;
		try {
			self::register_keys( Settings_Schema::get()->overlay_keys() );
			if ( \function_exists( 'do_action' ) ) {
				\do_action( self::DECLARE_ACTION );
			}
		} finally {
			self::$declaring = false;
		}
	}

	/**
	 * Declare config keys that value() may read. Idempotent; accumulates across
	 * calls and never pruned — a declaration is monotone, so a dropped
	 * DECLARE_ACTION callback can't un-declare keys that already resolve.
	 *
	 * @api
	 * @param array<int,string> $keys Unprefixed config keys.
	 */
	public static function register_keys( array $keys ): void {
		foreach ( $keys as $key ) {
			if ( '' !== $key ) {
				self::$registered_keys[ $key ] = true;
			}
		}
	}

	/**
	 * The configured base path, unvalidated — '' when unset. `wp nodes doctor`
	 * needs the path ensure_path() REFUSED in order to explain the refusal.
	 */
	public static function configured_base_directory(): string {
		$base_dir = self::load_config()['base_directory'] ?? null;
		return \is_scalar( $base_dir ) ? (string) $base_dir : '';
	}

	/**
	 * Load configuration from disk + WordPress options.
	 *
	 * @return array<string,mixed>
	 * @throws \RuntimeException If an explicit local config path or value tree is invalid.
	 */
	public static function load_config(): array {
		if ( null !== self::$config ) {
			return self::$config;
		}

		// Presence overlay: any stored option wins; only absent falls back.
		$schema = Settings_Schema::get();
		$config = Config_System\Options_Overlay::apply(
			self::load_config_defaults(),
			$schema->overlay_keys(),
			$schema->prefix()
		);

		self::$config = $config;
		return $config;
	}

	/**
	 * Stray keys the last config load ignored, for Site Health and doctor.
	 *
	 * @return list<string>
	 */
	public static function unrecognized_keys(): array {
		self::load_config_defaults();
		return self::$unrecognized;
	}

	/**
	 * Configuration WITHOUT the WordPress option overlay: the schema's code
	 * defaults, overridden by the shipped config file, then by an operator's
	 * LOCAL_NEWSPACK_NODES_CONF. The schema is the definition; both files are
	 * override surfaces.
	 *
	 * @return array<string,mixed>
	 * @throws \RuntimeException If an explicit local config path or value tree is invalid.
	 */
	public static function load_config_defaults(): array {
		if ( null !== self::$config_defaults ) {
			return self::$config_defaults;
		}

		// Code defaults first; a file only overrides values it names.
		$read   = self::$read_shipped_config ?? self::shipped_config_reader();
		$config = $read( Settings_Schema::get()->defaults() );
		self::note_unrecognized_keys( $config );
		// Operator-controlled local override (CLI/testing).
		$local_config_file = \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		if ( false !== $local_config_file && '' !== $local_config_file ) {
			$validated_path = Config_Utils::validate_config_path(
				$local_config_file,
				'Newspack_Nodes\\Config'
			);
			if ( null === $validated_path ) {
				throw new \RuntimeException(
					'LOCAL_NEWSPACK_NODES_CONF does not name a canonical readable PHP config file'
				);
			}
			$config = Config_Utils::load_config_file(
				$config,
				$validated_path,
				'Newspack_Nodes\\Config'
			);
		}

		self::$config_defaults = $config;

		return self::$config_defaults;
	}

	/**
	 * Record and log an operator's stray key WITHOUT throwing.
	 *
	 * `setup/newspack-nodes.sh` copies the deployment's own config over the
	 * shipped path, so this file belongs to the operator. Throwing runs at
	 * `plugins_loaded:-10001` and would take down every request, wp-admin
	 * included, the day a key is renamed — recoverable only over SSH. Loud
	 * means visible: stderr once per key set, plus Site Health and doctor.
	 *
	 * @param array<string,mixed> $config Schema defaults + config-file contents.
	 */
	private static function note_unrecognized_keys( array $config ): void {
		self::$unrecognized = self::unknown_keys( $config );
		if ( [] === self::$unrecognized ) {
			return;
		}
		Core::print_less_often(
			'newspack-nodes: unrecognized config key(s) ignored: ' . \implode( ', ', self::$unrecognized )
		);
	}

	/**
	 * Keys in $config that no Field declares.
	 *
	 * A stray key is an operator typo: 'base_directroy' leaves the real
	 * base_directory on its default and the runtime writes its tree somewhere
	 * else. LOCAL_NEWSPACK_NODES_CONF is deliberately free-form, and `value()`
	 * refuses an undeclared key — but that is not a total barrier, because
	 * `register_token_namespace()` resolves `<config:key>` off `load_config()`
	 * directly, so an undeclared local key IS reachable from a TSL token. The
	 * hatch is operator-owned and CLI-scoped, which is why it stays open.
	 *
	 * @param array<string,mixed> $config Any config array.
	 * @return list<string>
	 */
	public static function unknown_keys( array $config ): array {
		return \array_values(
			\array_diff( \array_keys( $config ), Settings_Schema::get()->overlay_keys() )
		);
	}

	/**
	 * The real shipped-config read the `$read_shipped_config` seam replaces.
	 *
	 * @return \Closure(array<string,mixed>): array<string,mixed>
	 */
	private static function shipped_config_reader(): \Closure {
		return static function ( array $base ): array {
			/** @var array<string,mixed> $base */
			return Config_Utils::load_config_file(
				$base,
				\dirname( __DIR__ ) . '/newspack-nodes-config.php',
				'Newspack_Nodes\\Config'
			);
		};
	}

	/**
	 * Register the substrate's `config` topology-token namespace.
	 *
	 * Resolves `<config:logs_dir>` / `<config:offsets_dir>` (derived from the
	 * base directory) and every other key straight off load_config(). Called
	 * once at boot; the app registers its own namespaces for its own keys.
	 */
	public static function register_token_namespace(): void {
		Core::register_config_namespace(
			'config',
			static function ( string $key ) {
				// Dirs derived from base dir; every other key reads config.
				$derived = [
					'logs_dir'       => 'logs',
					'offsets_dir'    => 'offsets',
					'deadletter_dir' => 'deadletter',
				];
				if ( isset( $derived[ $key ] ) ) {
					return \rtrim( self::get_base_directory(), '/' ) . '/' . $derived[ $key ];
				}
				// Credential store; the Vault API is the only way in.
				if ( Vault::CONFIG_KEY === $key ) {
					Core::print_less_often( 'newspack-nodes: <config:vault> refused; use the Vault API' );
					return null;
				}
				$cfg = self::load_config();
				return $cfg[ $key ] ?? null;
			}
		);
	}

	/**
	 * True when this process must not write under the runtime directory.
	 *
	 * Root may read and administer freely — it already owns the box, so the
	 * adoption gate above buys nothing against it. What root must never do is
	 * CREATE a file here: the workers run as the web user, so every root-owned
	 * lock, offset or segment is one they can no longer write, and the failure
	 * surfaces much later as a worker that cannot claim its IPC directory.
	 *
	 * Denial is non-fatal by design. A caller skips the write and carries on,
	 * so read-only root commands (`status`, `types`, `doctor`) keep working
	 * and a write-shaped one reports doing nothing instead of half-doing it.
	 *
	 * @param string $what Short description of the skipped write, for the log.
	 * @return bool True when the caller must skip its write.
	 */
	public static function write_denied( string $what = 'write' ): bool {
		if ( 0 !== CLI::uid() ) {
			return false;
		}
		Core::print_less_often(
			'WARNING: running as root; skipping ',
			$what,
			' - a root-owned file would be unwritable by the workers'
		);
		return true;
	}

	/** Reset cached config; fires `newspack_nodes/config_reset` so dependent Configs invalidate too. */
	public static function reset(): void {
		self::$config                   = null;
		self::$config_defaults          = null;
		self::$unrecognized             = [];
		self::$keys_declared            = false;
		self::$validated_base_directory = null;
		self::$validated_subdirs        = [];
		if ( \function_exists( 'do_action' ) ) {
			\do_action( self::RESET_ACTION );
		}
	}

	/**
	 * Drop WP's per-process option snapshots so workers see fresh writes. Pair
	 * with (and run before) Config::reset(), which reads through get_option.
	 *
	 * Purges the two aggregate groups AND each schema key's own cache entry —
	 * WP core caches an option under its own key in addition to alloptions/
	 * notoptions, so a long-running process (a draining worker) that read
	 * a key once would otherwise keep serving that stale value even after this
	 * runs, no matter how often it's called.
	 */
	public static function invalidate_options_cache(): void {
		if ( ! \function_exists( 'wp_cache_delete' ) ) {
			return;
		}
		\wp_cache_delete( 'alloptions', 'options' );
		\wp_cache_delete( 'notoptions', 'options' );
		$schema = Settings_Schema::get();
		foreach ( $schema->overlay_keys() as $key ) {
			\wp_cache_delete( $schema->prefix() . $key, 'options' );
		}
	}
}
