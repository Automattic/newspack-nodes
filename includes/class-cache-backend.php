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

	/** Selected backend name for failure diagnostics. */
	public function backend_name(): string {
		return null !== $this->memd ? 'memcached' : 'apcu';
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
