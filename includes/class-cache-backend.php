<?php
/**
 * Cache_Backend
 *
 * The tier resolver behind every non-durable shared-state surface, and the
 * key grammar every one of them writes through. Each ordering picks ONE live
 * backend — a claim must never straddle tiers:
 *
 * - `local_first()`  — APCu, else memcached. For same-host hot surfaces: the
 *   command-auth nonce claim, and `Bootstrap::on_demand_wake_map()`, whose
 *   inputs are this host's own `.tsl` files. The web pool rides shared memory,
 *   and a CLI process (its own APCu segment, usually disabled) falls through
 *   to memcached.
 * - `shared_first()` — memcached, else APCu. For cross-process sources of
 *   truth (command sessions, SSE slots, tables, batch counters, spawn
 *   throttles): configured memcached keeps its scope; a host without it
 *   (stock Atomic posture) stays FUNCTIONAL on APCu instead of failing
 *   closed, trading CLI visibility.
 *
 * Both return null when neither backend is available, and each caller decides
 * what that means: a Table refuses to construct and the command-auth nonce
 * refuses to claim, while the spawn throttle falls back to a transient and the
 * on-demand wake map recomputes. The operations mirror the `\Memcached` subset
 * the substrate uses, and the APCu arm matches memcached semantics: false on a
 * miss, a counter clamped at zero, and increment and decrement refusing a key
 * that does not exist.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * An instance is one arm, and the instance half is the contract every arm
 * keeps. `local_first()` and `shared_first()` select a volatile arm,
 * `Memcache_Arm` or `Apcu_Arm`; a durable arm, `Sqlite_Arm` or `Wpdb_Arm`
 * over the shared `Durable_Arm`, is never selected here but built by a Table.
 *
 * The static half selects a tier and owns the key grammar — `site_key()`,
 * `host_key()` and the `key()` they both compose through — so every surface
 * spells a key the same way and `wp nodes memcache get` can rebuild one from a
 * logical name.
 */
abstract class Cache_Backend {

	/** `read()` status: the backend returned a stored value. */
	public const READ_HIT = 'hit';

	/** `read()` status: the backend confirmed the key is absent. */
	public const READ_MISS = 'miss';

	/**
	 * `read()` status: the backend failed, so absence is unproven. The
	 * memcached and durable arms report it — APCu cannot tell a failure from a
	 * miss.
	 */
	public const READ_ERROR = 'error';

	/**
	 * Key-schema version. Bumping it in code orphans every key on every
	 * install at once, which a grammar change requires; `SALT_OPTION` is the
	 * per-install equivalent an operator turns.
	 */
	public const KEY_VERSION = 'v3';

	/**
	 * Option holding this install's rotatable salt.
	 *
	 * ONE salt for the whole install, never one per plugin: a per-plugin salt
	 * flushes only that plugin's keys and leaves its neighbours serving stale
	 * ones for state they share.
	 */
	public const SALT_OPTION = 'newspack_nodes_cache_salt';

	/**
	 * Memoized install scope; empty until `site()` derives it. `Core::reset()`
	 * clears it, and so does `rotate_salt()`, which moves what it is built from.
	 */
	public static string $site = '';

	/**
	 * Memoized install salt; null until `salt()` reads the option. Null
	 * rather than '' as the unset marker, because an install with no salt
	 * stored legitimately holds the empty string. `Core::reset()` clears it.
	 */
	public static ?string $salt = null;

	/**
	 * Memoized machine half; empty until `machine()` resolves it. `Core::reset()`
	 * clears it.
	 */
	public static string $machine = '';

	/**
	 * APCu-usability seam. Lazily-defaulted to the real `apcu_enabled()`
	 * check (a PHP_INI_SYSTEM fact tests can't flip at runtime); the test
	 * harness pins it false so memcached-seeded tests stay deterministic,
	 * and CacheBackendTest restores it to exercise the real APCu arm.
	 * Signature: `function (): bool`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $apcu_usable = null;

	/**
	 * APCu cache-info seam. Production calls `apcu_cache_info( true )`; tests
	 * provide deterministic aggregate statistics without populating APCu.
	 *
	 * @var \Closure(bool): (array<string,mixed>|false)|null
	 */
	public static ?\Closure $apcu_cache_info = null;

	/**
	 * APCu shared-memory seam. Production calls `apcu_sma_info( true )`; tests
	 * feed the `avail_mem` figure without populating APCu.
	 *
	 * @var \Closure(bool): (array<string,mixed>|false)|null
	 */
	public static ?\Closure $apcu_sma_info = null;

	/**
	 * Key for state one INSTALL owns, shared by every container serving it —
	 * tables, batch counters, unique-enqueue claims, spawn throttles, command
	 * nonces.
	 *
	 * The site half is the discriminator because it is the half that varies
	 * where installs collide: co-tenants share a database (separate table
	 * prefixes), and every container runs as the same unix user, so neither
	 * `DB_NAME` nor the username tells two installs apart.
	 *
	 * @param string $logical Logical name, as the writing surface spells it.
	 * @return string The install-scoped cache key.
	 */
	public static function site_key( string $logical ): string {
		return self::key( self::site(), $logical );
	}

	/**
	 * Key for a per-MACHINE budget, where the machine is the resource being
	 * rationed. SSE connection slots are the only such surface, and they
	 * compose the scope themselves through `SSE_Slot_Pool::namespace_key()`
	 * (the tests inject two machines to prove the pools are independent).
	 * This builds the same scope for a reader holding only a logical name —
	 * `wp nodes memcache get --host`.
	 *
	 * @param string $logical Logical name, as the writing surface spells it.
	 * @return string The machine-scoped cache key.
	 */
	public static function host_key( string $logical ): string {
		return self::key( self::machine() . ':' . self::site(), $logical );
	}

	/**
	 * Per-install half: the database plus the NETWORK's base table prefix,
	 * which is exactly what distinguishes co-tenants — one database with
	 * separate prefixes (the dndocker second-docroot posture) or separate
	 * databases (Atomic).
	 *
	 * Two identifiers this deliberately is NOT. Not `home_url()`: that is
	 * per-REQUEST — forced to https under `is_ssl()`, filtered by
	 * domain-mapping plugins, moved by `switch_to_blog()`. Not `$wpdb->prefix`:
	 * that is per-BLOG, while the fleet is network-global (`fleet_site()` turns
	 * subsites away, and locks/IPC/logs carry no blog namespace). Either would
	 * split ONE install's keyspace — a batch counter seeded by a subsite or a
	 * web request, then invisible to the CLI worker that decrements it, so
	 * fan-in never completes. `base_prefix` is invariant across both.
	 *
	 * The rotatable salt folds in here, so one rotation moves the keyspace for
	 * every plugin on this install at once.
	 *
	 * @return string Twelve hex characters, or 'unscoped' when neither
	 *                `DB_NAME` nor `$wpdb` identifies the install.
	 */
	public static function site(): string {
		if ( '' !== self::$site ) {
			return self::$site;
		}
		$db     = \defined( 'DB_NAME' ) ? Core::as_string( \constant( 'DB_NAME' ), '' ) : '';
		$prefix = '';
		if ( isset( $GLOBALS['wpdb'] ) && \is_object( $GLOBALS['wpdb'] ) ) {
			// base_prefix is the network half; the blog's is a last resort.
			$prefix = Core::as_string( $GLOBALS['wpdb']->base_prefix ?? ( $GLOBALS['wpdb']->prefix ?? '' ), '' );
		}
		if ( '' === $db && '' === $prefix ) {
			// Memoized last resort; co-tenants SHARE it — hence the warning.
			Core::print_less_often( 'ERROR: cache scope unresolvable (no DB_NAME, no $wpdb): keys are NOT install-scoped' );
			return self::$site = 'unscoped';
		}
		return self::$site = \substr( \md5( $db . ':' . $prefix . ':' . self::salt() ), 0, 12 );
	}

	/**
	 * Machine half, for the one scope that rations a per-MACHINE resource:
	 * SSE connection slots compose `machine():site()` in
	 * `SSE_Slot_Pool::namespace_key()`. Nothing else should — the hostname
	 * fragments exactly the state a fleet spanning containers must agree on.
	 *
	 * Falls back to 'unknown' so a gethostname() failure can never pass false
	 * to a string-typed callee. Deliberately NOT `SERVER_NAME`: that is
	 * caller-controllable, and a rate-limit namespace the caller chooses is
	 * not a rate limit.
	 *
	 * @return string The hostname, or 'unknown'.
	 */
	public static function machine(): string {
		return self::$machine ?: ( self::$machine = \gethostname() ?: 'unknown' );
	}

	/**
	 * THE key grammar: `newspack_nodes:{version}:{scope}:{logical}`.
	 *
	 * One shape for every surface, scope always ahead of the logical name, so a
	 * reader holding a logical name can rebuild the key without knowing which
	 * surface wrote it — that is what `wp nodes memcache get` reverses. A
	 * surface that orders its parts differently is unreachable from the CLI, so
	 * build here rather than concatenating your own.
	 *
	 * @param string $scope   Scope half, from `site()` or `machine():site()`.
	 * @param string $logical Logical name, as the writing surface spells it.
	 * @return string The composed cache key.
	 */
	public static function key( string $scope, string $logical ): string {
		return 'newspack_nodes:' . self::KEY_VERSION . ':' . $scope . ':' . $logical;
	}

	/**
	 * Select APCu, falling back to memcached: what a same-host hot surface
	 * wants, since a CLI process with no APCu segment still reaches memcached.
	 *
	 * @return self|null The selected tier, or null when neither is usable.
	 */
	public static function local_first(): ?self {
		return self::apcu_arm() ?? self::memcache_arm();
	}

	/**
	 * Select memcached, falling back to APCu: what a cross-process source of
	 * truth wants, staying functional on one host rather than failing closed
	 * where memcached is absent.
	 *
	 * @return self|null The selected tier, or null when neither is usable.
	 */
	public static function shared_first(): ?self {
		return self::memcache_arm() ?? self::apcu_arm();
	}

	/**
	 * The APCu arm.
	 *
	 * @return self|null The arm, or null where APCu is unusable.
	 */
	public static function apcu_arm(): ?self {
		return self::apcu() ? new Apcu_Arm() : null;
	}

	/**
	 * Whether APCu is usable, asked through the seam so tests pin the answer.
	 *
	 * @return bool True when the extension is loaded and enabled.
	 */
	private static function apcu(): bool {
		$check = self::$apcu_usable ?? static fn (): bool => \function_exists( 'apcu_enabled' ) && \apcu_enabled();
		return (bool) $check();
	}

	/**
	 * The memcached arm over the shared handle.
	 *
	 * @return self|null The arm, or null without a handle.
	 */
	public static function memcache_arm(): ?self {
		$memd = Core::memd();
		return null !== $memd ? new Memcache_Arm( $memd ) : null;
	}

	/**
	 * Read many keys in one round trip, found-only, keyed by cache key.
	 *
	 * Deliberately without read()'s per-key miss/error distinction: `getMulti`
	 * reports ONE result code for the whole batch, so a per-key status would be
	 * a fiction. A caller that must tell a confirmed miss from a broken backend
	 * asks key by key through read().
	 *
	 * A batch that fails outright is logged rather than swallowed, because the
	 * empty array it returns reads as "nothing stored" downstream: silently, a
	 * reset connection renders a whole page of rows as absent. A caller that
	 * merges onto what it read passes `$failed` to tell the two apart.
	 *
	 * @param list<string> $keys   Cache keys.
	 * @param ?bool        $failed Set true when the batch failed outright,
	 *                             false when it answered, misses included.
	 * @param-out bool     $failed
	 * @return array<string,mixed> Values for the keys that were present.
	 */
	public function read_multi( array $keys, ?bool &$failed = null ): array {
		$failed = false;
		if ( [] === $keys ) {
			return [];
		}
		$found = $this->fetch_multi( $keys );
		if ( ! \is_array( $found ) ) {
			Core::print_less_often( 'Cache_Backend: batch read error from ', $this->last_failure() );
			$failed = true;
			return [];
		}
		$out = [];
		foreach ( $found as $key => $value ) {
			// An all-digit key comes back an int from a PHP array.
			$out[ (string) $key ] = $value;
		}
		return $out;
	}

	/**
	 * The last operation's failure, for a log line: memcached's own result
	 * code and message, which name the cause — a timeout, a server marked
	 * dead, a refused connection. APCu reports no cause, so it names itself.
	 *
	 * Read it straight after the failed call: the result is the handle's LAST,
	 * and any operation in between replaces it. Pass it to `print_less_often()`
	 * as an extra rather than in the key, so varying text shares one limit.
	 *
	 * @return string `memcached result <code>: <message>`, `APCu`,
	 *                `sqlite <path>: <message>` or `wpdb <table>: <message>`.
	 */
	abstract public function last_failure(): string;

	/**
	 * The arm's one batch read: the found keys' values, or false when the batch
	 * failed outright. `read_multi()` owns the empty guard, the failure log and
	 * the key normalising, so an arm chunks or batches however its store needs.
	 *
	 * @param non-empty-list<string> $keys Cache keys.
	 * @return array<array-key,mixed>|false Key => value for the keys present.
	 */
	abstract protected function fetch_multi( array $keys ): array|false;

	/**
	 * Seed the salt if this install has none, and leave a live one alone.
	 *
	 * Without it the scope is `md5( DB_NAME . ':' . base_prefix . ':' . '' )` —
	 * every ingredient computable by anyone who can reach the same memcached,
	 * which is what makes a shared cache injectable rather than merely
	 * readable. Activation is the moment to close that, because it is the one
	 * point where orphaning the keyspace costs nothing: there are no keys yet.
	 *
	 * Idempotent BY DESIGN, and that is the whole difference from
	 * `rotate_salt()`: activation runs again on every plugin update, and a
	 * rotation there would orphan a live install's keys on each one.
	 *
	 * The seed asks every live worker to restart, as a rotation does, since a
	 * worker running before it holds the unsalted scope. Activation and the
	 * admin_init self-heal seed before anything resolves the runtime base, so
	 * a configured base that does not exist — where no worker can hold a lock
	 * — is logged under `Bootstrap::RUNTIME_UNAVAILABLE` and the seed stands.
	 * A base that exists can hold live lock dirs, so any refusal of it throws.
	 *
	 * @api Called by `Bootstrap::activate()`.
	 * @return string The salt in force afterwards.
	 * @throws \Throwable What refusing the salt write, resolving an existing
	 *                    base or flagging the fleet threw.
	 */
	public static function ensure_salt(): string {
		$salt = self::salt();
		if ( '' !== $salt ) {
			return $salt;
		}
		$salt = self::move_salt();
		$base = Config::value( 'base_directory' );
		if ( ! \is_string( $base ) || ! \is_dir( $base ) ) {
			Core::print_less_often( Bootstrap::RUNTIME_UNAVAILABLE, 'cache salt seeded; no runtime base to restart workers under: ', Core::as_string( $base, '' ) );
			return $salt;
		}
		self::restart_fleet();
		return $salt;
	}

	/**
	 * The install's cache salt. Empty until something rotates it.
	 *
	 * @return string The stored salt, or '' when no option holds one.
	 */
	public static function salt(): string {
		if ( null !== self::$salt ) {
			return self::$salt;
		}
		return self::$salt = Core::as_string( \get_option( self::SALT_OPTION, '' ), '' );
	}

	/**
	 * Rotate the salt: every key on this install is orphaned at once, and no
	 * co-tenant's is touched. THE flush — plugins do not keep their own.
	 *
	 * Clearing the memoized `$site` is half the work, since the salt folds
	 * into it; a process that kept the old scope would keep the old keys. Every
	 * live worker memoizes its scope too, so every rotation asks every active
	 * worker to restart, as `wp nodes restart all` does.
	 *
	 * @return string The new salt.
	 * @throws \Throwable What refusing the salt write threw, or, after the salt
	 *                    moved, what resolving the base or flagging the fleet
	 *                    threw.
	 */
	public static function rotate_salt(): string {
		$salt = self::move_salt();
		self::restart_fleet();
		return $salt;
	}

	/**
	 * Ask every active worker to restart, as `wp nodes restart all` does,
	 * flagging lock dirs through the base the settings writers resolve.
	 *
	 * @throws \Throwable What resolving the base or flagging the fleet threw.
	 */
	private static function restart_fleet(): void {
		( new CLI( Config::get_base_directory_with_locks() ) )->restart_workers( Bootstrap::expand_workers() );
	}

	/**
	 * Store a fresh salt and drop the scope memoized from the old one. A write
	 * the database refused moves nothing, so no process holds a salt the
	 * others never see.
	 *
	 * @return string The new salt.
	 * @throws \RuntimeException When the option write is refused.
	 */
	private static function move_salt(): string {
		$salt = \function_exists( 'wp_generate_password' ) ? \wp_generate_password( 12, false ) : (string) \time();
		if ( ! \update_option( self::SALT_OPTION, $salt, true ) ) {
			throw new \RuntimeException( 'cache salt write refused' );
		}
		self::$salt = $salt;
		self::$site = '';
		return $salt;
	}

	/**
	 * Selected backend name, for failure diagnostics.
	 *
	 * @return string 'memcached', 'apcu', 'sqlite' or 'wpdb'.
	 */
	abstract public function backend_name(): string;

	/**
	 * Whether a failed `write_multi()` landed nothing, so a per-key retry is
	 * pointless.
	 *
	 * @return bool True when a batch is all or nothing.
	 */
	public function batch_is_atomic(): bool {
		return false;
	}

	/**
	 * Atomically replace one exact, non-expiring integer value with another.
	 *
	 * This deliberately has no TTL parameter: callers use it for permanent,
	 * bounded identity pointers. A failed comparison is a lost race and must
	 * never fall back to set().
	 *
	 * The APCu arm re-reads after the swap, so a true return there means the
	 * read-back saw the replacement.
	 *
	 * @param string $key         The cache key.
	 * @param int    $expected    Value the key must currently hold.
	 * @param int    $replacement Value to write when the comparison holds.
	 * @return bool True when this caller won the swap.
	 */
	abstract public function compare_and_swap( string $key, int $expected, int $replacement ): bool;

	/**
	 * Add one to a counter, refusing a key that does not exist.
	 *
	 * @param string $key The cache key.
	 * @return int|false The new value, or false on an absent key or a failure.
	 */
	abstract public function increment( string $key ): int|false;

	/**
	 * Subtract one from a counter, refusing a key that does not exist.
	 *
	 * Memcached clamps at zero. `apcu_dec` goes negative, so that arm stores
	 * the clamped zero back and the two agree on what a floor looks like.
	 *
	 * @param string $key The cache key.
	 * @return int|false The new value, or false on an absent key or a failure.
	 */
	abstract public function decrement( string $key ): int|false;

	/**
	 * Aggregate facts about the selected backend, for a failed cache-backed
	 * operation. Never a key name or a stored value, so a caller can log the
	 * whole array or hand it to a dashboard.
	 *
	 * The memcached arm reports the last result code and message, and a durable
	 * arm its last error message under `<backend>_error`. The APCu arm
	 * reports expunges and free shared memory, the two numbers that say
	 * whether the segment is thrashing, and is empty when APCu declines both
	 * info calls.
	 *
	 * @return array<string,int|string> Diagnostic facts, possibly empty.
	 */
	abstract public function diagnostic_metadata(): array;

	/**
	 * Write many entries under ONE ttl in a single round trip — the write-side
	 * counterpart of `read_multi()`, for a caller that just resolved a page of
	 * misses and would otherwise pay a round trip per key.
	 *
	 * One TTL per call because both backends take it that way; a caller with
	 * mixed lifetimes groups by TTL and calls once per group.
	 *
	 * @param array<string,mixed> $items Cache key => value.
	 * @param int                 $ttl   Expiry in seconds; 0 = no expiry.
	 * @return bool True when the whole set landed. Memcached's `setMulti`
	 *              answers one bool, and this collapses APCu's failure list to
	 *              match, so a caller needing to know WHICH key was refused
	 *              re-sends that batch one key at a time.
	 */
	abstract public function write_multi( array $items, int $ttl ): bool;

	/**
	 * Claim a key atomically: false when it already exists. This is what a
	 * caller uses where a lost race must not displace the winner's value.
	 *
	 * @param string $key   The cache key.
	 * @param mixed  $value Value to store.
	 * @param int    $ttl   Expiry in seconds; 0 = no expiry.
	 * @return bool True when this caller created the key.
	 */
	abstract public function add( string $key, mixed $value, int $ttl ): bool;

	/**
	 * Read one value, false on a miss (memcached parity). A stored false reads
	 * the same as a miss, and a backend failure reads the same again; `read()`
	 * is what tells the three apart.
	 *
	 * @param string $key The cache key.
	 * @return mixed The stored value, or false.
	 */
	abstract public function get( string $key ): mixed;

	/**
	 * Read without collapsing a confirmed miss and a backend failure.
	 *
	 * @param string $key The cache key.
	 * @return array{status:'hit'|'miss'|'error',value:mixed}
	 */
	abstract public function read( string $key ): array;

	/**
	 * Store a value, replacing whatever the key holds.
	 *
	 * @param string $key   The cache key.
	 * @param mixed  $value Value to store.
	 * @param int    $ttl   Expiry in seconds; 0 = no expiry.
	 * @return bool True when the write landed.
	 */
	abstract public function set( string $key, mixed $value, int $ttl ): bool;

	/**
	 * Remove a key.
	 *
	 * @param string $key The cache key.
	 * @return bool True when the key existed and is now gone.
	 */
	abstract public function delete( string $key ): bool;

	/**
	 * Extend a key's expiry without rewriting its value.
	 *
	 * Three answers, as `read()` gives three: a confirmed miss is false, and
	 * a backend that did not answer — any memcached result but NOTFOUND, or
	 * an APCu store refused after its fetch hit — is null, so a caller never
	 * mistakes a timeout for an evicted key.
	 *
	 * APCu has no native touch, so that arm fetches and re-stores under the
	 * new ttl. Those are two operations, and a write landing between them is
	 * overwritten with the older value — use it where the value is a lease the
	 * holder alone refreshes, as `SSE_Slot_Pool::touch()` does.
	 *
	 * @param string $key The cache key.
	 * @param int    $ttl New expiry in seconds; 0 = no expiry.
	 * @return bool|null True when the key existed and its expiry moved, false
	 *                   when it is confirmed absent, null when the backend
	 *                   did not answer.
	 */
	abstract public function touch( string $key, int $ttl ): ?bool;

	/**
	 * Whether any key of a batch is refused; a refused batch writes nothing.
	 *
	 * @param array<array-key,mixed> $items Key => value.
	 * @return bool True when any key is refused.
	 */
	protected static function refuses_any( array $items ): bool {
		foreach ( \array_keys( $items ) as $key ) {
			if ( self::refuses_key( (string) $key ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Whether a key cannot be named in a string request: empty, or holding
	 * whitespace. Every write refuses one, so every stored key is nameable.
	 *
	 * @param string $key The cache key.
	 * @return bool True when a write must refuse the key.
	 */
	public static function refuses_key( string $key ): bool {
		return '' === $key || 1 === \preg_match( '/\s/', $key );
	}
}
