<?php
/**
 * Apcu_Arm: the Cache_Backend arm over this host's APCu segment, held to
 * memcached's semantics: false on a miss, counters that refuse an absent
 * key and clamp at zero.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * APCu, matched to memcached.
 */
final class Apcu_Arm extends Cache_Backend {

	public function increment( string $key ): int|false {
		return $this->has( $key ) ? \apcu_inc( $key ) : false;
	}

	public function decrement( string $key ): int|false {
		if ( ! $this->has( $key ) ) {
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
	 * Whether APCu holds the key: `apcu_inc` would create a missing one, where
	 * memcached refuses, and a decrement of an evicted batch counter must not
	 * read as a completed fan-in.
	 *
	 * @param string $key The cache key.
	 * @return bool True when the key exists.
	 */
	private function has( string $key ): bool {
		\apcu_fetch( $key, $hit );
		return (bool) $hit;
	}

	public function get( string $key ): mixed {
		return \apcu_fetch( $key );
	}

	public function read( string $key ): array {
		$value = \apcu_fetch( $key, $hit );
		return $hit ? [ 'status' => self::READ_HIT, 'value' => $value ] : [ 'status' => self::READ_MISS, 'value' => null ];
	}

	public function set( string $key, mixed $value, int $ttl ): bool {
		return ! self::refuses_key( $key ) && \apcu_store( $key, $value, $ttl );
	}

	public function write_multi( array $items, int $ttl ): bool {
		return [] === $items || ( ! self::refuses_any( $items ) && [] === \apcu_store( $items, null, $ttl ) );
	}

	public function add( string $key, mixed $value, int $ttl ): bool {
		return ! self::refuses_key( $key ) && \apcu_add( $key, $value, $ttl );
	}

	public function delete( string $key ): bool {
		return true === \apcu_delete( $key );
	}

	public function touch( string $key, int $ttl ): ?bool {
		$value = \apcu_fetch( $key, $hit );
		if ( ! $hit ) {
			return false;
		}
		return \apcu_store( $key, $value, $ttl ) ? true : null;
	}

	public function compare_and_swap( string $key, int $expected, int $replacement ): bool {
		$current = \apcu_fetch( $key, $hit );
		if ( ! $hit || ! \is_int( $current ) || $expected !== $current || ! \apcu_cas( $key, $expected, $replacement ) ) {
			return false;
		}
		$current = \apcu_fetch( $key, $hit );
		return $hit && $replacement === $current;
	}

	public function last_failure(): string {
		return 'APCu';
	}

	public function diagnostic_metadata(): array {
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

	public function backend_name(): string {
		return 'apcu';
	}

	protected function fetch_multi( array $keys ): array|false {
		$found = \apcu_fetch( $keys );
		return \is_array( $found ) ? $found : false;
	}
}
