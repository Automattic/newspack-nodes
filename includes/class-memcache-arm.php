<?php
/**
 * Memcache_Arm: the Cache_Backend arm over the shared `\Memcached` handle,
 * whose semantics every other arm matches.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Memcached, through the one shared handle `Core::memd()` returns.
 */
final class Memcache_Arm extends Cache_Backend {

	/**
	 * Wrap the shared handle.
	 *
	 * @param \Memcached $memd The shared handle.
	 */
	public function __construct( private readonly \Memcached $memd ) {}

	public function compare_and_swap( string $key, int $expected, int $replacement ): bool {
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

	/**
	 * Hand `Memcached::cas()` the opaque token exactly as the extended read
	 * returned it.
	 *
	 * Extension releases declare that parameter `float` or `string|int|float`,
	 * so the token rides as the union and nothing here narrows it: a 64-bit
	 * token cast to float loses its low digits.
	 *
	 * @param callable         $cas         The bound `[ $memcached, 'cas' ]`.
	 * @param string|int|float $token       CAS token from the extended read.
	 * @param string           $key         The cache key.
	 * @param int              $replacement Value to write.
	 * @return bool True when the extension reports the swap landed.
	 */
	private static function invoke_memcached_cas( callable $cas, string|int|float $token, string $key, int $replacement ): bool {
		return true === $cas( $token, $key, $replacement );
	}

	public function last_failure(): string {
		$meta = $this->diagnostic_metadata();
		return "memcached result {$meta['memcached_result_code']}: {$meta['memcached_result_message']}";
	}

	public function diagnostic_metadata(): array {
		return [
			'memcached_result_code'    => $this->memd->getResultCode(),
			'memcached_result_message' => $this->memd->getResultMessage(),
		];
	}

	public function get( string $key ): mixed {
		return $this->memd->get( $key );
	}

	public function read( string $key ): array {
		$value = $this->memd->get( $key );
		return match ( $this->memd->getResultCode() ) {
			\Memcached::RES_SUCCESS  => [ 'status' => self::READ_HIT, 'value' => $value ],
			\Memcached::RES_NOTFOUND => [ 'status' => self::READ_MISS, 'value' => null ],
			default                  => [ 'status' => self::READ_ERROR, 'value' => null ],
		};
	}

	public function set( string $key, mixed $value, int $ttl ): bool {
		return ! self::refuses_key( $key ) && $this->memd->set( $key, $value, $ttl );
	}

	public function write_multi( array $items, int $ttl ): bool {
		return [] === $items || ( ! self::refuses_any( $items ) && $this->memd->setMulti( $items, $ttl ) );
	}

	public function add( string $key, mixed $value, int $ttl ): bool {
		return ! self::refuses_key( $key ) && $this->memd->add( $key, $value, $ttl );
	}

	public function delete( string $key ): bool {
		return $this->memd->delete( $key );
	}

	public function touch( string $key, int $ttl ): ?bool {
		if ( $this->memd->touch( $key, $ttl ) ) {
			return true;
		}
		return \Memcached::RES_NOTFOUND === $this->memd->getResultCode() ? false : null;
	}

	public function increment( string $key ): int|false {
		return $this->memd->increment( $key );
	}

	public function decrement( string $key ): int|false {
		return $this->memd->decrement( $key );
	}

	public function backend_name(): string {
		return 'memcached';
	}

	protected function fetch_multi( array $keys ): array|false {
		return $this->memd->getMulti( $keys );
	}
}
