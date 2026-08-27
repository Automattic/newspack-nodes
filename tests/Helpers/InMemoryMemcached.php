<?php
/**
 * InMemoryMemcached: a real `\Memcached` subclass backed by a PHP array.
 *
 * The substrate's `Sse_Slot_Pool` and `Core::$memd` are typed `\Memcached`,
 * so tests can't substitute a bare duck-type — the value must be-a
 * `\Memcached`. This subclass overrides only the methods the slot pool
 * touches (add/get/delete/touch/CAS) with exact native signatures, keeping
 * everything in memory so slot tests stay deterministic without a server.
 *
 * `add()` keeps the real atomic-claim semantics (fails if the key exists),
 * and every mutation advances the CAS token, which are the properties the
 * slot-acquire loop relies on.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Helpers;

class InMemoryMemcached extends \Memcached {
	/** @var array<string,array{value:mixed,expires:int,cas:int}> */
	private array $store = [];

	private int $result_code = \Memcached::RES_SUCCESS;

	private int $next_cas = 1;

	/** @var array<string,int> */
	private array $get_failures = [];

	/** @var array<string,int> */
	private array $next_get_failures = [];

	/**
	 * One-shot seam after touch reads the old value but before it stores the
	 * refreshed value. This models APCu's non-atomic fetch/store touch.
	 *
	 * @var \Closure(string,mixed,int):void|null
	 */
	public ?\Closure $after_touch_read = null;

	/**
	 * Round trips by shape, so a test can assert a tier answered without one.
	 * getMulti() counts as ONE batch trip and no single-key trips, however many
	 * keys it reads.
	 */
	public int $get_calls = 0;

	public int $multi_calls = 0;

	/** Keys ASKED for across every getMulti — the fan-out width, not the trips. */
	public int $multi_keys = 0;

	/** @var array<string,true> */
	private array $set_failures = [];

	/** Force get() to return false with a non-NOTFOUND backend result. */
	public function fail_get( string $key, int $result_code = \Memcached::RES_FAILURE ): void {
		$this->get_failures[ $key ] = $result_code;
	}

	/** Force set() to refuse the key — an item over the size limit, or a dead server. */
	public function fail_set( string $key ): void {
		$this->set_failures[ $key ] = true;
	}

	/** Force only the next get() to return a backend error. */
	public function fail_next_get( string $key, int $result_code = \Memcached::RES_FAILURE ): void {
		$this->next_get_failures[ $key ] = $result_code;
	}

	public function get( string $key, ?callable $cache_cb = null, int $get_flags = 0 ): mixed {
		++$this->get_calls;
		if ( \array_key_exists( $key, $this->next_get_failures ) ) {
			$this->result_code = $this->next_get_failures[ $key ];
			unset( $this->next_get_failures[ $key ] );
			return false;
		}
		if ( \array_key_exists( $key, $this->get_failures ) ) {
			$this->result_code = $this->get_failures[ $key ];
			return false;
		}
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
		if ( \Memcached::GET_EXTENDED === ( $get_flags & \Memcached::GET_EXTENDED ) ) {
			return [
				'value' => $entry['value'],
				'cas'   => $entry['cas'],
				'flags' => 0,
			];
		}
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
		if ( isset( $this->set_failures[ $key ] ) ) {
			$this->result_code = \Memcached::RES_E2BIG;
			return false;
		}
		$this->store[ $key ] = [
			'value'   => $value,
			'expires' => $expiration > 0 ? \time() + $expiration : 0,
			'cas'     => $this->next_cas++,
		];
		$this->result_code = \Memcached::RES_SUCCESS;
		return true;
	}

	/**
	 * @param array<string,mixed> $items
	 */
	public function setMulti( array $items, int $expiration = 0 ): bool {
		$ok = true;
		foreach ( $items as $key => $value ) {
			$ok = $this->set( (string) $key, $value, $expiration ) && $ok;
		}
		return $ok;
	}

	public function add( string $key, mixed $value, int $expiration = 0 ): bool {
		$this->get( $key );
		if ( \Memcached::RES_SUCCESS === $this->result_code ) {
			$this->result_code = \Memcached::RES_NOTSTORED;
			return false;
		}
		return $this->set( $key, $value, $expiration );
	}

	public function cas( string|int|float $cas_token, string $key, mixed $value, int $expiration = 0 ): bool {
		$this->get( $key );
		if ( \Memcached::RES_SUCCESS !== $this->result_code ) {
			return false;
		}
		if ( (string) $cas_token !== (string) $this->store[ $key ]['cas'] ) {
			$this->result_code = \Memcached::RES_DATA_EXISTS;
			return false;
		}
		return $this->set( $key, $value, $expiration );
	}

	public function delete( string $key, int $time = 0 ): bool {
		if ( ! \array_key_exists( $key, $this->store ) ) {
			$this->result_code = \Memcached::RES_NOTFOUND;
			return false;
		}
		unset( $this->store[ $key ] );
		$this->result_code = \Memcached::RES_SUCCESS;
		return true;
	}

	public function touch( string $key, int $expiration = 0 ): bool {
		$value = $this->get( $key );
		if ( false === $value ) {
			return false;
		}
		$after_touch_read       = $this->after_touch_read;
		$this->after_touch_read = null;
		if ( null !== $after_touch_read ) {
			$after_touch_read( $key, $value, $expiration );
		}
		$this->store[ $key ] = [
			'value'   => $value,
			'expires' => $expiration > 0 ? \time() + $expiration : 0,
			'cas'     => $this->next_cas++,
		];
		$this->result_code = \Memcached::RES_SUCCESS;
		return true;
	}

	/** Found-only, and a stored `false` IS found — the real getMulti includes it. */
	public function getMulti( array $keys, int $get_flags = 0 ): array|false {
		++$this->multi_calls;
		$this->multi_keys += \count( $keys );
		$singles = $this->get_calls;
		$out     = [];
		foreach ( $keys as $key ) {
			$val = $this->get( $key );
			if ( \Memcached::RES_SUCCESS === $this->result_code ) {
				$out[ $key ] = $val;
			}
		}
		$this->get_calls = $singles;
		return $out;
	}

	public function increment( string $key, int $offset = 1, int $initial_value = 0, int $expiry = 0 ): int|false {
		$value = $this->get( $key );
		if ( false === $value || ! \is_int( $value ) ) {
			return false;
		}
		$value += $offset;
		$this->store[ $key ]['value'] = $value;
		$this->store[ $key ]['cas']   = $this->next_cas++;
		return $value;
	}

	public function decrement( string $key, int $offset = 1, int $initial_value = 0, int $expiry = 0 ): int|false {
		$value = $this->get( $key );
		if ( false === $value || ! \is_int( $value ) ) {
			return false;
		}
		// Real memcached clamps decrement at zero; keep that property.
		$value = \max( 0, $value - $offset );
		$this->store[ $key ]['value'] = $value;
		$this->store[ $key ]['cas']   = $this->next_cas++;
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
