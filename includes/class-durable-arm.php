<?php
/**
 * Durable_Arm: what every durable Cache_Backend arm means, whatever it stores in.
 *
 * A durable arm keeps rows until they expire or are deleted, and reclaims the
 * expired ones on `purge()`. It alone holds set members, one row per member
 * read by an exact set-key seek, beside its keyed rows. This class owns those semantics once — the
 * live-row rule, the refused keys, the tagged serialization, the
 * compare-then-write counters and the failure record — and an arm supplies its
 * statements. Each hook below is one step in the arm's own dialect and throws
 * `\PDOException` or `\UnexpectedValueException` when it fails;
 * `write_scope()` is where each arm decides how its writes hold together,
 * since only the arm knows whose connection it writes on.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The shared half of `Sqlite_Arm` and `Wpdb_Arm`.
 */
abstract class Durable_Arm extends Cache_Backend {

	/** Reads a counter makes before a run of lost races is a failure. */
	private const COUNTER_ATTEMPTS = 3;

	/** The last failure's message, for `last_failure()`. */
	protected string $failure = '';

	/** See Cache_Backend::get(). */
	public function get( string $key ): mixed {
		$read = $this->read( $key );
		return self::READ_HIT === $read['status'] ? $read['value'] : false;
	}

	/** See Cache_Backend::read(). */
	public function read( string $key ): array {
		return $this->attempt(
			function () use ( $key ): array {
				$rows = $this->select( [ $key ] );
				return \array_key_exists( $key, $rows )
					? [ 'status' => self::READ_HIT, 'value' => $rows[ $key ] ]
					: [ 'status' => self::READ_MISS, 'value' => null ];
			},
			[ 'status' => self::READ_ERROR, 'value' => null ]
		);
	}

	/** See Cache_Backend::set(). */
	public function set( string $key, mixed $value, int $ttl ): bool {
		return $this->write_multi( [ $key => $value ], $ttl );
	}

	/** See Cache_Backend::write_multi(). */
	public function write_multi( array $items, int $ttl ): bool {
		if ( [] === $items ) {
			return true;
		}
		if ( self::refuses_any( $items ) ) {
			return false;
		}
		$expires = self::expires( $ttl );
		return $this->attempt(
			function () use ( $items, $expires ): bool {
				$rows = \array_map( self::encode( ... ), $items );
				return $this->write_scope(
					function () use ( $rows, $expires ): bool {
						$this->upsert( $rows, $expires );
						return true;
					}
				);
			},
			false
		);
	}

	/**
	 * Insert or replace rows, all under one expiry.
	 *
	 * @param array<array-key,string> $rows    Key => tagged bytes.
	 * @param int                     $expires The `expires` column.
	 */
	abstract protected function upsert( array $rows, int $expires ): void;

	/** See Cache_Backend::add(); an expired row is absent. */
	public function add( string $key, mixed $value, int $ttl ): bool {
		if ( self::refuses_key( $key ) ) {
			return false;
		}
		return $this->attempt(
			function () use ( $key, $value, $ttl ): bool {
				$bytes   = self::encode( $value );
				$expires = self::expires( $ttl );
				return $this->write_scope( fn (): bool => $this->claim( $key, $bytes, $expires ) );
			},
			false
		);
	}

	/**
	 * Insert one row where no live row holds its key, dropping an expired one.
	 *
	 * @param string $key     Key.
	 * @param string $bytes   Tagged bytes.
	 * @param int    $expires The `expires` column.
	 * @return bool True when the row was inserted.
	 */
	abstract protected function claim( string $key, string $bytes, int $expires ): bool;

	/** See Cache_Backend::delete(). */
	public function delete( string $key ): ?bool {
		return $this->attempt( fn (): bool => $this->delete_key( $key ) > 0, null );
	}

	/**
	 * Delete one key's live row.
	 *
	 * @param string $key Key.
	 * @return int Rows deleted.
	 */
	abstract protected function delete_key( string $key ): int;

	/** See Cache_Backend::touch(); an unmoved expiry changes no row, so a zero re-reads. */
	public function touch( string $key, int $ttl ): ?bool {
		return $this->attempt( fn (): bool => $this->update_expiry( $key, self::expires( $ttl ) ) > 0 || [] !== $this->select( [ $key ] ), null );
	}

	/**
	 * Move a live row's expiry.
	 *
	 * @param string $key     Key.
	 * @param int    $expires The new `expires` column.
	 * @return int Rows changed.
	 */
	abstract protected function update_expiry( string $key, int $expires ): int;

	/** See Cache_Backend::compare_and_swap(). */
	public function compare_and_swap( string $key, int $expected, int $replacement ): bool {
		return false !== $this->swap( $key, static fn ( mixed $current ): ?int => $expected === $current ? $replacement : null, 1 );
	}

	/** See Cache_Backend::increment(). */
	public function increment( string $key ): int|false {
		return $this->swap( $key, static fn ( mixed $current ): ?int => \is_int( $current ) ? $current + 1 : null, self::COUNTER_ATTEMPTS );
	}

	/** See Cache_Backend::decrement(); clamped at zero, as memcached is. */
	public function decrement( string $key ): int|false {
		return $this->swap( $key, static fn ( mixed $current ): ?int => \is_int( $current ) ? \max( 0, $current - 1 ) : null, self::COUNTER_ATTEMPTS );
	}

	/**
	 * Replace a live integer through `$next`: read the row, then write it back
	 * only where it still holds what was read. The write is an UPDATE in place,
	 * so the expiry stands and a row that is gone is never recreated, and a
	 * concurrent writer between the two makes this read lose rather than
	 * clobber. A lost read is tried again up to `$attempts` times: once for a
	 * compare-and-swap, whose lost race is its answer, and more for a counter,
	 * which must count every step as memcached's does.
	 *
	 * @param string                $key      Key.
	 * @param \Closure(mixed): ?int $next     The replacement, or null to refuse.
	 * @param int                   $attempts Reads before a lost race is final.
	 * @return int|false The value now stored, or false when refused, lost or failed.
	 * @throws \UnexpectedValueException When a counter lost every race.
	 */
	private function swap( string $key, \Closure $next, int $attempts ): int|false {
		return $this->attempt(
			fn (): int|false => $this->write_scope(
				function () use ( $key, $next, $attempts ): int|false {
					for ( $tried = 1; $tried <= $attempts; ++$tried ) {
						$old = $this->select_rows( [ $key ] )[ $key ] ?? null;
						if ( null === $old ) {
							return false;
						}
						$value = $next( self::decode( $old ) );
						if ( null === $value ) {
							return false;
						}
						$new = self::encode( $value );
						if ( $new === $old || $this->replace( $key, $old, $new ) ) {
							return $value;
						}
					}
					return 1 === $attempts ? false : throw new \UnexpectedValueException( "a counter lost {$attempts} races to concurrent writers" );
				}
			),
			false
		);
	}

	/**
	 * Rewrite one live row's value where it still holds `$old`, its expiry
	 * untouched.
	 *
	 * @param string $key Key.
	 * @param string $old Tagged bytes the row must hold.
	 * @param string $new Tagged bytes to write.
	 * @return bool True when the row was rewritten.
	 */
	abstract protected function replace( string $key, string $old, string $new ): bool;

	/**
	 * Delete up to `$limit` rows expired at `$now`, keyed rows first and set
	 * members with what the limit leaves. A volatile arm has no such verb: its
	 * store expires rows on its own.
	 *
	 * @param int $now   Epoch second.
	 * @param int $limit Most rows to delete, keyed and member rows together.
	 * @return int Rows deleted; 0 when the store refused, which is logged.
	 */
	public function purge( int $now, int $limit ): int {
		$limit  = \max( 0, $limit );
		$purged = $this->attempt(
			function () use ( $now, $limit ): int {
				$rows = $this->purge_rows( $now, $limit );
				return $rows < $limit ? $rows + $this->purge_member_rows( $now, $limit - $rows ) : $rows;
			},
			null
		);
		if ( null === $purged ) {
			Core::print_less_often( 'Table purge failed: ', $this->last_failure() );
		}
		return $purged ?? 0;
	}

	/**
	 * Delete up to `$limit` member rows expired at `$now`.
	 *
	 * @param int $now   Epoch second.
	 * @param int $limit Most rows.
	 * @return int Rows deleted.
	 */
	abstract protected function purge_member_rows( int $now, int $limit ): int;

	/**
	 * Delete up to `$limit` keyed rows expired at `$now`.
	 *
	 * @param int $now   Epoch second.
	 * @param int $limit Most rows.
	 * @return int Rows deleted.
	 */
	abstract protected function purge_rows( int $now, int $limit ): int;

	/**
	 * Upsert set members, each set under its own TTL: one row per member, a
	 * re-added member's value and expiry replaced. Every member of every set
	 * goes through one write scope, so a set lands whole where the arm holds
	 * its writes together. A set whose key is refused or whose TTL is below
	 * one second refuses the call before anything is written.
	 *
	 * @param array<array-key,array{0: array<array-key,mixed>, 1: int}> $sets Set key =>
	 *        [ member => value, ttl ], the TTL in whole seconds, at least 1.
	 * @return bool True when every set landed; true for no sets.
	 */
	public function add_members( array $sets ): bool {
		$rows = [];
		foreach ( $sets as $set_key => [ $members, $ttl ] ) {
			if ( self::refuses_key( (string) $set_key ) || $ttl < 1 ) {
				return false;
			}
			$expires = self::expires( $ttl );
			foreach ( $members as $member => $value ) {
				$rows[] = [ (string) $set_key, (string) $member, $value, $expires ];
			}
		}
		if ( [] === $rows ) {
			return true;
		}
		return $this->attempt(
			function () use ( $rows ): bool {
				$encoded = \array_map( static fn ( array $row ): array => [ $row[0], $row[1], self::encode( $row[2] ), $row[3] ], $rows );
				return $this->write_scope(
					function () use ( $encoded ): bool {
						$this->upsert_members( $encoded );
						return true;
					}
				);
			},
			false
		);
	}

	/**
	 * Insert or replace member rows.
	 *
	 * @param list<array{0: string, 1: string, 2: string, 3: int}> $rows Set key,
	 *        member, tagged bytes, the `expires` column.
	 */
	abstract protected function upsert_members( array $rows ): void;

	/**
	 * Run a write's statements the way this arm holds them together.
	 *
	 * @template T
	 * @param \Closure(): T $work The statements.
	 * @return T What `$work` returned.
	 */
	abstract protected function write_scope( \Closure $work ): mixed;

	/**
	 * A value as a durable arm stores it: the serializer's tag, then its bytes,
	 * so a row reads back under whichever serializer is in force later.
	 *
	 * @param mixed $value The value.
	 * @return string The tagged bytes.
	 * @throws \UnexpectedValueException When igbinary cannot serialize the value.
	 */
	private static function encode( mixed $value ): string {
		if ( 'igbinary' !== self::serializer() ) {
			return 's' . \serialize( $value ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.serialize_serialize
		}
		$bytes = \igbinary_serialize( $value );
		if ( ! \is_string( $bytes ) ) {
			throw new \UnexpectedValueException( 'igbinary could not serialize the value' );
		}
		return 'i' . $bytes;
	}

	/**
	 * The serializer a stored value takes: igbinary where the shared memcached
	 * handle has been built with it, PHP's otherwise. It reads `Core::$memd` as
	 * built so far and never builds one.
	 *
	 * @api Callers sizing a stored value.
	 * @return 'igbinary'|'php'
	 */
	public static function serializer(): string {
		$memd = Core::$memd;
		return null !== $memd && \defined( '\Memcached::SERIALIZER_IGBINARY' )
			&& \Memcached::SERIALIZER_IGBINARY === $memd->getOption( \Memcached::OPT_SERIALIZER )
			? 'igbinary'
			: 'php';
	}

	/**
	 * The `expires` column for a TTL: 0 keeps the row until it is deleted.
	 *
	 * @param int $ttl Seconds; 0 = no expiry.
	 * @return int Epoch second, or 0.
	 */
	private static function expires( int $ttl ): int {
		return $ttl > 0 ? self::now() + $ttl : 0;
	}

	/**
	 * Epoch seconds a row's liveness is judged at: `Core::$clock` when a test
	 * binds it.
	 *
	 * @return int Epoch seconds.
	 */
	protected static function now(): int {
		return (int) ( null !== Core::$clock ? ( Core::$clock )() : \time() );
	}

	/**
	 * Each set's live members in member order, or null for a set holding more
	 * than `$limit`: each set is read by an exact set-key seek of `$limit + 1`
	 * rows, and the row past the limit tells a full set from one over it, whose
	 * rows are dropped undecoded before the next set is read. A row no
	 * serializer wrote fails the read, as it fails a keyed read. A limit below 1
	 * reads nothing, and a failed read is logged.
	 *
	 * @param list<string> $set_keys Set keys.
	 * @param int          $limit    Most members a set may hold and be answered.
	 * @return array<array-key,array<array-key,mixed>|null>|false Set key =>
	 *         member => value, or null past the limit; a set with no live member
	 *         absent; false when the store failed.
	 */
	public function members( array $set_keys, int $limit ): array|false {
		if ( $limit < 1 ) {
			return [];
		}
		$found = $this->attempt(
			function () use ( $set_keys, $limit ): array {
				$out = [];
				foreach ( \array_unique( $set_keys ) as $set_key ) {
					$rows = $this->select_set( $set_key, $limit + 1 );
					if ( [] !== $rows ) {
						$out[ $set_key ] = \count( $rows ) > $limit ? null : self::decoded( $rows );
					}
					unset( $rows );
				}
				return $out;
			},
			false
		);
		if ( false === $found ) {
			Core::print_less_often( 'Table member read failed: ', $this->last_failure() );
		}
		return $found;
	}

	/**
	 * Up to `$limit` live member rows of one set, lowest member first, by an
	 * exact set-key seek; one set at a time, so a set past its limit is let
	 * go before the next is read.
	 *
	 * @param string $set_key The set key.
	 * @param int    $limit   Most rows, at least 2.
	 * @return array<array-key,string> Member => tagged bytes.
	 */
	abstract protected function select_set( string $set_key, int $limit ): array;

	/**
	 * Reclaim the store's free pages. An operator verb, never automatic.
	 *
	 * @throws \RuntimeException When the store refuses, in plain text the
	 *                           verb reporting it escapes.
	 */
	abstract public function vacuum(): void;

	/** See Cache_Backend::diagnostic_metadata(). */
	public function diagnostic_metadata(): array {
		return [ $this->backend_name() . '_error' => $this->failure ];
	}

	/** See Cache_Backend::fetch_multi(). */
	protected function fetch_multi( array $keys ): array|false {
		return $this->attempt( fn (): array => $this->select( $keys ), false );
	}

	/**
	 * The live rows for `$keys`, decoded.
	 *
	 * @param list<string> $keys Keys.
	 * @return array<string,mixed>
	 */
	private function select( array $keys ): array {
		return self::decoded( $this->select_rows( \array_values( \array_unique( $keys ) ) ) );
	}

	/**
	 * The live rows among `$keys`, however many statements that takes.
	 *
	 * @param list<string> $keys Keys.
	 * @return array<array-key,string> Key => tagged bytes.
	 */
	abstract protected function select_rows( array $keys ): array;

	/**
	 * Tagged rows as key => value.
	 *
	 * @param array<array-key,string> $rows Key => tagged bytes.
	 * @return array<string,mixed>
	 * @throws \UnexpectedValueException On a row no serializer here wrote.
	 */
	private static function decoded( array $rows ): array {
		$out = [];
		foreach ( $rows as $key => $bytes ) {
			$out[ (string) $key ] = self::decode( $bytes );
		}
		return $out;
	}

	/**
	 * The value a durable row holds.
	 *
	 * Rows sit inside the install's trust boundary, as memcached does (whose
	 * igbinary serializer already instantiates classes) and as wp_options do.
	 * `allowed_classes => false` on the PHP path is defense in depth where the
	 * serializer offers a filter; igbinary offers none.
	 *
	 * @param string $row The tagged bytes `encode()` wrote.
	 * @return mixed The value.
	 * @throws \UnexpectedValueException On a row no serializer here wrote.
	 */
	private static function decode( string $row ): mixed {
		return match ( $row[0] ?? '' ) {
			'i'     => \igbinary_unserialize( \substr( $row, 1 ) ),
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.serialize_unserialize
			's'     => \unserialize( \substr( $row, 1 ), [ 'allowed_classes' => false ] ),
			default => throw new \UnexpectedValueException( 'undecodable row' ),
		};
	}

	/**
	 * Run one operation, recording a store failure and answering `$failed`.
	 *
	 * @template T
	 * @template F
	 * @param \Closure(): T $op     The operation.
	 * @param F             $failed What a failure answers.
	 * @return T|F
	 */
	private function attempt( \Closure $op, mixed $failed ): mixed {
		try {
			return $op();
		} catch ( \PDOException | \UnexpectedValueException $e ) {
			$this->failure = $e->getMessage();
			return $failed;
		}
	}
}
