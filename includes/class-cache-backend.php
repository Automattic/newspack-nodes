<?php
/**
 * CacheBackend
 *
 * The two-ordering tier resolver behind every non-durable shared-state
 * surface. Each ordering picks ONE live backend — a claim must never
 * straddle tiers:
 *
 * - `local_first()`  — APCu, else memcached. For same-host hot surfaces
 *   (nonce claims, SSE slots, metadata tiers): the web pool rides shared
 *   memory; a CLI process (own APCu segment, usually disabled) falls
 *   through to memcached automatically.
 * - `shared_first()` — memcached, else APCu. For cross-process sources of
 *   truth (tables, batch counters, stats): configured memcached keeps its
 *   scope; a host without it (stock Atomic posture) stays FUNCTIONAL on
 *   APCu instead of failing closed, trading CLI visibility.
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

	private function __construct( private readonly ?\Memcached $memd ) {}

	/** APCu → memcached → null. */
	public static function local_first(): ?self {
		if ( self::apcu() ) {
			return new self( null );
		}
		return null !== Core::$memd ? new self( Core::$memd ) : null;
	}

	private static function apcu(): bool {
		$check = self::$apcu_usable ?? static fn (): bool => \function_exists( 'apcu_enabled' ) && \apcu_enabled();
		return (bool) $check();
	}

	/** Memcached → APCu → null. */
	public static function shared_first(): ?self {
		if ( null !== Core::$memd ) {
			return new self( Core::$memd );
		}
		return self::apcu() ? new self( null ) : null;
	}

	/** Atomic claim: false when the key already exists. */
	public function add( string $key, mixed $value, int $ttl ): bool {
		return null !== $this->memd ? $this->memd->add( $key, $value, $ttl ) : \apcu_add( $key, $value, $ttl );
	}

	/** False on miss (memcached parity). */
	public function get( string $key ): mixed {
		return null !== $this->memd ? $this->memd->get( $key ) : \apcu_fetch( $key );
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

	public function increment( string $key ): int|false {
		return null !== $this->memd ? $this->memd->increment( $key ) : \apcu_inc( $key );
	}

	/** Memcached clamps at zero; mirror that on the APCu arm (apcu_dec goes negative). */
	public function decrement( string $key ): int|false {
		if ( null !== $this->memd ) {
			return $this->memd->decrement( $key );
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
}
