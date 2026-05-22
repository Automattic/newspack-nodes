<?php
/**
 * FakeMemcached: in-process duck-type of the `\Memcached`-method subset that
 * caching consumers call.
 *
 * Caching is the single shared `\Newspack_Nodes\Core::$memd` handle (a raw
 * `\Memcached`); there is no Cache_Interface anywhere. This helper exists so
 * substrate-side tests for Workers_CI can pass a cache-shaped stub (or stand in
 * for `Core::$memd`) without a live memcached. The shape mirrors the methods
 * the substrate actually reads.
 *
 * Set $fail_all = true to simulate a memcache-down scenario (every
 * operation returns the failure sentinel: get → null, set/delete → false).
 */

namespace Newspack_Nodes\Tests\Helpers;

class FakeMemcached {
	/** @var array<string,array{value:mixed,expires:int}> */
	private array $store = [];
	private bool $fail_all;

	public function __construct( bool $fail_all = false ) {
		$this->fail_all = $fail_all;
	}

	public function is_available(): bool {
		return ! $this->fail_all;
	}

	public function get( string $key ): mixed {
		if ( $this->fail_all ) {
			return null;
		}
		$entry = $this->store[ $key ] ?? null;
		if ( null === $entry ) {
			return null;
		}
		if ( $entry['expires'] > 0 && \time() >= $entry['expires'] ) {
			unset( $this->store[ $key ] );
			return null;
		}
		return $entry['value'];
	}

	public function get_multi( array $keys ): array {
		if ( $this->fail_all ) {
			return [];
		}
		$out = [];
		foreach ( $keys as $key ) {
			$val = $this->get( $key );
			if ( null !== $val ) {
				$out[ $key ] = $val;
			}
		}
		return $out;
	}

	public function set( string $key, mixed $value, int $ttl ): bool {
		if ( $this->fail_all ) {
			return false;
		}
		$this->store[ $key ] = [
			'value'   => $value,
			'expires' => $ttl > 0 ? \time() + $ttl : 0,
		];
		return true;
	}

	public function add( string $key, mixed $value, int $ttl ): bool {
		if ( $this->fail_all ) {
			return false;
		}
		if ( $this->get( $key ) !== null ) {
			return false;
		}
		return $this->set( $key, $value, $ttl );
	}

	public function delete( string $key ): bool {
		if ( $this->fail_all ) {
			return false;
		}
		if ( ! \array_key_exists( $key, $this->store ) ) {
			return false;
		}
		unset( $this->store[ $key ] );
		return true;
	}

	public function flush_all(): bool {
		if ( $this->fail_all ) {
			return false;
		}
		$this->store = [];
		return true;
	}

	/** Test helper: expose all live keys (post-expiry filter). */
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

	/** Test helper: count live entries. */
	public function count(): int {
		return \count( $this->keys() );
	}

	/** Test helper: switch fail mode mid-test. */
	public function set_fail_all( bool $fail ): void {
		$this->fail_all = $fail;
	}

}
