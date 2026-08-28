<?php
/**
 * CacheBackend
 *
 * The tier resolver behind every non-durable shared-state surface. Each
 * ordering picks ONE live backend — a claim must never straddle tiers:
 *
 * - `local_first()`  — APCu, else memcached. For same-host hot surfaces
 *   (nonce claims, metadata tiers): the web pool rides shared
 *   memory; a CLI process (own APCu segment, usually disabled) falls
 *   through to memcached automatically.
 * - `shared_first()` — memcached, else APCu. For cross-process sources of
 *   truth (command sessions, SSE slots, tables, batch counters, stats):
 *   configured memcached keeps its scope; a host without it (stock Atomic
 *   posture) stays FUNCTIONAL on APCu instead of failing closed, trading
 *   CLI visibility.
 *
 * Null = nothing available; callers keep their fail-closed behavior.
 * Ops mirror the \Memcached subset the substrate uses; the APCu arm
 * matches memcached semantics (false on miss, decrement clamps at zero).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * CacheBackend resolver.
 */
final class Cache_Backend {

	public const READ_HIT = 'hit';

	public const READ_MISS = 'miss';

	public const READ_ERROR = 'error';

	/**
	 * Key-schema version — the one rotatable salt. Bumping it orphans every
	 * key at once, which is the point: a per-plugin salt only ever flushed
	 * that plugin's keys while its neighbours kept serving stale ones.
	 */
	public const KEY_VERSION = 'v3';

	/** Option holding the rotatable salt; rotating it orphans every key. */
	public const SALT_OPTION = 'newspack_nodes_cache_salt';

	/** Memoized install scope, salt and machine half; `Core::reset()` clears them. */
	public static string $site = '';

	public static ?string $salt = null;

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
	 * APCu shared-memory seam. Production calls `apcu_sma_info( true )`.
	 *
	 * @var \Closure(bool): (array<string,mixed>|false)|null
	 */
	public static ?\Closure $apcu_sma_info = null;

	private function __construct( private readonly ?\Memcached $memd ) {}

	/**
	 * Key for state one INSTALL owns, shared by every container serving it —
	 * tables, batch counters, unique-enqueue claims, stats, render caches.
	 *
	 * The site half is the discriminator because it is the half that varies
	 * where installs collide: co-tenants share a database (separate table
	 * prefixes), and every container runs as the same unix user, so neither
	 * `DB_NAME` nor the username tells two installs apart.
	 */
	public static function site_key( string $logical ): string {
		return self::key( self::site(), $logical );
	}

	/**
	 * Key for a per-MACHINE budget, where the machine is the resource being
	 * rationed. SSE connection slots are the only one, and they pass their
	 * scope explicitly (the tests inject two machines to prove the pools are
	 * independent) — this is the same scope, for a reader that has to rebuild
	 * such a key without one.
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
	 */
	public static function site(): string {
		if ( '' !== self::$site ) {
			return self::$site;
		}
		$db     = \defined( 'DB_NAME' ) ? Core::as_string( \constant( 'DB_NAME' ), '' ) : '';
		$prefix = '';
		if ( isset( $GLOBALS['wpdb'] ) && \is_object( $GLOBALS['wpdb'] ) ) {
			// base_prefix is the network half; prefix alone is this blog's.
			$prefix = Core::as_string( $GLOBALS['wpdb']->base_prefix ?? ( $GLOBALS['wpdb']->prefix ?? '' ), '' );
		}
		if ( '' === $db && '' === $prefix ) {
			// Last resort, and co-tenants SHARE it — hence the warning.
			Core::print_less_often( 'ERROR: cache scope unresolvable (no DB_NAME, no $wpdb): keys are NOT install-scoped' );
			return self::$site = 'unscoped';
		}
		return self::$site = \substr( \md5( $db . ':' . $prefix . ':' . self::salt() ), 0, 12 );
	}

	/**
	 * The install's cache salt. Empty until something rotates it.
	 *
	 * Read through `$wpdb` rather than `get_option()` because pyrobase's
	 * `bin/pyrate` runs under SHORTINIT, where the option API is stubbed to
	 * return defaults — and pyrate warms the SAME caches the web serves.
	 * Reading the row directly is what keeps one rotation coherent across both.
	 */
	public static function salt(): string {
		if ( null !== self::$salt ) {
			return self::$salt;
		}
		$wpdb = $GLOBALS['wpdb'] ?? null;
		if ( ! $wpdb instanceof \wpdb ) {
			return self::$salt = '';
		}
		// %i keeps the query a literal string with the table as an identifier.
		$sql = $wpdb->prepare(
			'SELECT option_value FROM %i WHERE option_name = %s LIMIT 1',
			$wpdb->options,
			self::SALT_OPTION
		);
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching, WordPress.DB.PreparedSQL.NotPrepared
		return self::$salt = Core::as_string( $wpdb->get_var( $sql ), '' );
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
	 */
	public static function key( string $scope, string $logical ): string {
		return 'newspack_nodes:' . self::KEY_VERSION . ':' . $scope . ':' . $logical;
	}

	/** APCu → memcached → null. */
	public static function local_first(): ?self {
		if ( self::apcu() ) {
			return new self( null );
		}
		return null !== Core::$memd ? new self( Core::$memd ) : null;
	}

	/** Memcached → APCu → null. */
	public static function shared_first(): ?self {
		if ( null !== Core::$memd ) {
			return new self( Core::$memd );
		}
		return self::apcu() ? new self( null ) : null;
	}

	private static function apcu(): bool {
		$check = self::$apcu_usable ?? static fn (): bool => \function_exists( 'apcu_enabled' ) && \apcu_enabled();
		return (bool) $check();
	}

	/**
	 * Atomically replace one exact, non-expiring integer value with another.
	 *
	 * This deliberately has no TTL parameter: callers use it for permanent,
	 * bounded identity pointers. A failed comparison is a lost race and must
	 * never fall back to set().
	 */
	public function compare_and_swap( string $key, int $expected, int $replacement ): bool {
		if ( null !== $this->memd ) {
			$entry = $this->memd->get( $key, null, \Memcached::GET_EXTENDED );
			if (
				! \is_array( $entry )
				|| ! \array_key_exists( 'value', $entry )
				|| $expected !== $entry['value']
				|| ! \array_key_exists( 'cas', $entry )
				|| ( ! \is_string( $entry['cas'] ) && ! \is_int( $entry['cas'] ) && ! \is_float( $entry['cas'] ) )
			) {
				return false;
			}
			return self::invoke_memcached_cas( [ $this->memd, 'cas' ], $entry['cas'], $key, $replacement );
		}

		$current = \apcu_fetch( $key, $hit );
		if ( ! $hit || ! \is_int( $current ) || $expected !== $current || ! \apcu_cas( $key, $expected, $replacement ) ) {
			return false;
		}
		$current = \apcu_fetch( $key, $hit );
		return $hit && $replacement === $current;
	}

	/**
	 * Invoke Memcached CAS without coercing its opaque token.
	 *
	 * Extension releases expose float-only or string|int|float signatures.
	 * Calling through the native callable preserves the exact token returned by
	 * GET_EXTENDED; converting a 64-bit integer token to float can lose it.
	 */
	private static function invoke_memcached_cas( callable $cas, string|int|float $token, string $key, int $replacement ): bool {
		return true === $cas( $token, $key, $replacement );
	}

	public function increment( string $key ): int|false {
		if ( null !== $this->memd ) {
			return $this->memd->increment( $key );
		}
		if ( ! $this->apcu_has( $key ) ) {
			return false;
		}
		return \apcu_inc( $key );
	}

	/** Memcached clamps at zero; mirror that on the APCu arm (apcu_dec goes negative). */
	public function decrement( string $key ): int|false {
		if ( null !== $this->memd ) {
			return $this->memd->decrement( $key );
		}
		if ( ! $this->apcu_has( $key ) ) {
			return false;
		}
		$value = \apcu_dec( $key, 1, $ok );
		if ( false === $ok ) {
			return false;
		}
		if ( $value < 0 ) {
			\apcu_store( $key, 0 );
			return 0;
		}
		return $value;
	}

	/**
	 * Whether APCu currently holds the key.
	 *
	 * `apcu_inc`/`apcu_dec` CREATE a missing key — that is what their `$ttl`
	 * parameter is for — while `Memcached::increment`/`decrement` return false
	 * and set RES_NOTFOUND. Counters are the one place the two arms disagreed,
	 * and the disagreement was load-bearing: a decrement of an evicted batch
	 * counter clamped to a stored 0, which `Job_Worker_Node::settle_batch()`
	 * reads as a completed fan-in. Gate both on existence so a miss is a miss.
	 *
	 * @param string $key The cache key.
	 * @return bool True when the key exists.
	 */
	private function apcu_has( string $key ): bool {
		\apcu_fetch( $key, $hit );
		return (bool) $hit;
	}

	/**
	 * Read many keys in one round trip, found-only, keyed by cache key.
	 *
	 * Deliberately without read()'s per-key miss/error distinction: `getMulti`
	 * reports ONE result code for the whole batch, so a per-key status would be
	 * a fiction. A caller that must tell a confirmed miss from a broken backend
	 * asks key by key through read().
	 *
	 * A batch that fails outright still says so here, because empty reads as
	 * "nothing stored" downstream — silently, a reset connection renders a
	 * whole page of rows as absent.
	 *
	 * @param list<string> $keys Cache keys.
	 * @return array<string,mixed> Values for the keys that were present.
	 */
	public function read_multi( array $keys ): array {
		if ( [] === $keys ) {
			return [];
		}
		$found = null !== $this->memd ? $this->memd->getMulti( $keys ) : \apcu_fetch( $keys );
		if ( ! \is_array( $found ) ) {
			Core::print_less_often( 'Cache_Backend: batch read error from ', $this->backend_name() );
			return [];
		}
		$out = [];
		foreach ( $found as $key => $value ) {
			// An all-digit key comes back an int from a PHP array.
			$out[ (string) $key ] = $value;
		}
		return $out;
	}

	/** Selected backend name for failure diagnostics. */
	public function backend_name(): string {
		return null !== $this->memd ? 'memcached' : 'apcu';
	}

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
	 * @return bool True when the whole set landed. Neither backend reports per
	 *              KEY — memcached's `setMulti` is one bool and apcu returns the
	 *              failures — so a caller needing to know WHICH key was refused
	 *              re-sends that batch one key at a time.
	 */
	public function write_multi( array $items, int $ttl ): bool {
		if ( [] === $items ) {
			return true;
		}
		if ( null !== $this->memd ) {
			return $this->memd->setMulti( $items, $ttl );
		}
		return [] === \apcu_store( $items, null, $ttl );
	}

	/**
	 * Rotate the salt: every key on this install is orphaned at once, and no
	 * co-tenant's is touched. THE flush — plugins do not keep their own.
	 */
	public static function rotate_salt(): string {
		$salt = \function_exists( 'wp_generate_password' ) ? \wp_generate_password( 12, false ) : (string) \time();
		if ( \function_exists( 'update_option' ) ) {
			\update_option( self::SALT_OPTION, $salt, true );
		}
		self::$salt = $salt;
		self::$site = '';
		return $salt;
	}

	/** Atomic claim: false when the key already exists. */
	public function add( string $key, mixed $value, int $ttl ): bool {
		return null !== $this->memd ? $this->memd->add( $key, $value, $ttl ) : \apcu_add( $key, $value, $ttl );
	}

	/** False on miss (memcached parity). */
	public function get( string $key ): mixed {
		return null !== $this->memd ? $this->memd->get( $key ) : \apcu_fetch( $key );
	}

	/**
	 * Read without collapsing a confirmed miss and a backend failure.
	 *
	 * @return array{status:'hit'|'miss'|'error',value:mixed}
	 */
	public function read( string $key ): array {
		if ( null !== $this->memd ) {
			$value       = $this->memd->get( $key );
			$result_code = $this->memd->getResultCode();
			if ( \Memcached::RES_SUCCESS === $result_code ) {
				return [ 'status' => self::READ_HIT, 'value' => $value ];
			}
			if ( \Memcached::RES_NOTFOUND === $result_code ) {
				return [ 'status' => self::READ_MISS, 'value' => null ];
			}
			return [ 'status' => self::READ_ERROR, 'value' => null ];
		}

		$value = \apcu_fetch( $key, $hit );
		return $hit
			? [ 'status' => self::READ_HIT, 'value' => $value ]
			: [ 'status' => self::READ_MISS, 'value' => null ];
	}

	/**
	 * Safe aggregate facts for a failed cache-backed operation.
	 *
	 * @return array<string,int|string>
	 */
	public function diagnostic_metadata(): array {
		if ( null !== $this->memd ) {
			return [
				'memcached_result_code'    => $this->memd->getResultCode(),
				'memcached_result_message' => $this->memd->getResultMessage(),
			];
		}

		$metadata   = [];
		$cache_info = ( self::$apcu_cache_info ?? static fn ( bool $limited ) => \apcu_cache_info( $limited ) )( true );
		if ( \is_array( $cache_info ) && isset( $cache_info['expunges'] ) && \is_numeric( $cache_info['expunges'] ) ) {
			$metadata['apcu_expunges'] = (int) $cache_info['expunges'];
		}
		$sma_info = ( self::$apcu_sma_info ?? static fn ( bool $limited ) => \apcu_sma_info( $limited ) )( true );
		if ( \is_array( $sma_info ) && isset( $sma_info['avail_mem'] ) && \is_numeric( $sma_info['avail_mem'] ) ) {
			$metadata['apcu_available_memory_bytes'] = (int) $sma_info['avail_mem'];
		}
		return $metadata;
	}

	public function set( string $key, mixed $value, int $ttl ): bool {
		return null !== $this->memd ? $this->memd->set( $key, $value, $ttl ) : \apcu_store( $key, $value, $ttl );
	}

	public function delete( string $key ): bool {
		return null !== $this->memd ? $this->memd->delete( $key ) : \apcu_delete( $key );
	}

	/** APCu has no native touch; re-store under the new ttl. */
	public function touch( string $key, int $ttl ): bool {
		if ( null !== $this->memd ) {
			return $this->memd->touch( $key, $ttl );
		}
		$value = \apcu_fetch( $key, $hit );
		return $hit && \apcu_store( $key, $value, $ttl );
	}
}
