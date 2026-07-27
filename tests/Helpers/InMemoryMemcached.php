<?php
/**
 * InMemoryMemcached: a real `\Memcached` subclass backed by a PHP array.
 *
 * The substrate's `Sse_Slot_Pool` and `Core::$memd` are typed `\Memcached`,
 * so tests can't substitute a bare duck-type — the value must be-a
 * `\Memcached`. This subclass overrides only the methods the slot pool
 * touches (add/get/delete/touch) with exact native signatures, keeping
 * everything in memory so slot tests stay deterministic without a server.
 *
 * `add()` keeps the real atomic-claim semantics (fails if the key exists),
 * which is the property the slot-acquire loop relies on.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Helpers;

class InMemoryMemcached extends \Memcached {
	/** @var array<string,array{value:mixed,expires:int}> */
	private array $store = [];

	private int $result_code = \Memcached::RES_SUCCESS;

	public function get( string $key, ?callable $cache_cb = null, int $get_flags = 0 ): mixed {
		$entry = $this->store[ $key ] ?? null;
		if ( null === $entry ) {
			$this->result_code = \Memcached::RES_NOTFOUND;
			return false;
		}
		if ( $entry['expires'] > 0 && \time() >= $entry['expires'] ) {
			unset( $this->store[ $key ] );
			$this->result_code = \Memcached::RES_NOTFOUND;
			return false;
		}
		$this->result_code = \Memcached::RES_SUCCESS;
		return $entry['value'];
	}

	/**
	 * Test-only: absolute expiry stamps by key, so a test can assert which TTL
	 * a caller actually applied (not merely that the key exists).
	 *
	 * @return array<string,int>
	 */
	public function expiries(): array {
		return \array_map( static fn ( array $e ): int => $e['expires'], $this->store );
	}

	public function getResultCode(): int {
		return $this->result_code;
	}

	public function set( string $key, mixed $value, int $expiration = 0 ): bool {
		$this->store[ $key ] = [
			'value'   => $value,
			'expires' => $expiration > 0 ? \time() + $expiration : 0,
		];
		return true;
	}

	public function add( string $key, mixed $value, int $expiration = 0 ): bool {
		if ( false !== $this->get( $key ) ) {
			return false;
		}
		return $this->set( $key, $value, $expiration );
	}

	public function delete( string $key, int $time = 0 ): bool {
		if ( ! \array_key_exists( $key, $this->store ) ) {
			return false;
		}
		unset( $this->store[ $key ] );
		return true;
	}

	public function touch( string $key, int $expiration = 0 ): bool {
		$value = $this->get( $key );
		if ( false === $value ) {
			return false;
		}
		return $this->set( $key, $value, $expiration );
	}

	public function getMulti( array $keys, int $get_flags = 0 ): array|false {
		$out = [];
		foreach ( $keys as $key ) {
			$val = $this->get( $key );
			if ( false !== $val ) {
				$out[ $key ] = $val;
			}
		}
		return $out;
	}

	public function increment( string $key, int $offset = 1, int $initial_value = 0, int $expiry = 0 ): int|false {
		$value = $this->get( $key );
		if ( false === $value || ! \is_int( $value ) ) {
			return false;
		}
		$value += $offset;
		$this->set( $key, $value, $this->store[ $key ]['expires'] );
		return $value;
	}

	public function decrement( string $key, int $offset = 1, int $initial_value = 0, int $expiry = 0 ): int|false {
		$value = $this->get( $key );
		if ( false === $value || ! \is_int( $value ) ) {
			return false;
		}
		// Real memcached clamps decrement at zero; keep that property.
		$value = \max( 0, $value - $offset );
		$this->set( $key, $value, $this->store[ $key ]['expires'] );
		return $value;
	}

	/** Test helper: live (non-expired) keys, sorted. */
	public function keys(): array {
		$now  = \time();
		$live = [];
		foreach ( $this->store as $k => $entry ) {
			if ( 0 === $entry['expires'] || $now < $entry['expires'] ) {
				$live[] = $k;
			}
		}
		\sort( $live );
		return $live;
	}

	/** Test helper: count of live entries. */
	public function count(): int {
		return \count( $this->keys() );
	}
}
