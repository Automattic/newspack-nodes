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

	/** Tagged bytes encoded for a write or decoded for a read; see bytes(). */
	private int $bytes = 0;

	/** See Cache_Backend::get(). */
	public function get( string $key ): mixed {
		$read = $this->read( $key );
		return self::READ_HIT === $read['status'] ? $read['value'] : false;
	}

	/** See Cache_Backend::read(). */
	public function read( string $key ): array {
		return $this->attempt(
			function () use ( $key ): array {
				$rows = $this->entries( [ $key ], static fn ( mixed $value ): mixed => $value );
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
				$rows = \array_map( $this->encode( ... ), $items );
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
				$bytes   = $this->encode( $value );
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
	 * See Cache_Backend::delete_multi(); an atomic arm holds the batch in one
	 * write scope, and a statement that fails fails it, answering none. Any
	 * other arm answers the keys that took effect, one by one.
	 */
	public function delete_multi( array $keys ): array {
		if ( ! $this->batch_is_atomic() ) {
			return parent::delete_multi( $keys );
		}
		return $this->held( $keys, fn ( string $key ): bool => $this->delete_key( $key ) > 0 );
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
		return $this->attempt( fn (): bool => $this->touched( $key, self::expires( $ttl ) ), null );
	}

	/**
	 * See Cache_Backend::touch_multi(); an atomic arm holds the batch in one
	 * write scope, and a statement that fails fails it, answering none. Any
	 * other arm answers the keys that took effect, one by one.
	 */
	public function touch_multi( array $keys, int $ttl ): array {
		if ( ! $this->batch_is_atomic() ) {
			return parent::touch_multi( $keys, $ttl );
		}
		$expires = self::expires( $ttl );
		return $this->held( $keys, fn ( string $key ): bool => $this->touched( $key, $expires ) );
	}

	/**
	 * Move one key's expiry; a row already at it changes nothing, so a zero re-reads.
	 *
	 * @param string $key     Key.
	 * @param int    $expires The new `expires` column.
	 * @return bool Whether a live row holds the key.
	 */
	private function touched( string $key, int $expires ): bool {
		return $this->update_expiry( $key, $expires ) > 0 || [] !== $this->select_rows( [ $key ] );
	}

	/**
	 * Move a live row's expiry.
	 *
	 * @param string $key     Key.
	 * @param int    $expires The new `expires` column.
	 * @return int Rows changed.
	 */
	abstract protected function update_expiry( string $key, int $expires ): int;

	/**
	 * Run a per-key operation over a batch in one write scope. A statement
	 * that fails fails the batch, which answers no keys; an empty batch takes
	 * no write lock.
	 *
	 * @param list<string>              $keys The keys.
	 * @param \Closure(string): bool $took Whether the operation took effect on a key.
	 * @return list<string> The keys it took effect on.
	 */
	private function held( array $keys, \Closure $took ): array {
		if ( [] === $keys ) {
			return [];
		}
		return $this->attempt( fn (): array => $this->write_scope( fn (): array => $this->taking( $keys, $took ) ), [] );
	}

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
						$old = $this->select_rows( [ $key ] )[ $key ][0] ?? null;
						if ( null === $old ) {
							return false;
						}
						$value = $next( $this->decode( $old ) );
						if ( null === $value ) {
							return false;
						}
						$new = $this->encode( $value );
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
	 * Empty this arm's store, keyed and member rows, live or expired: an
	 * operator's `flush`. Each arm answers what it knows without counting:
	 * `Sqlite_Arm` the bytes its old files held, `Wpdb_Arm` the rows its
	 * DELETE reports.
	 *
	 * @return array{bytes:int}|array{rows:int}|null Null when the store
	 *                                               refused, which
	 *                                               `last_failure()` names.
	 */
	public function flush(): ?array {
		return $this->attempt( $this->discard( ... ), null );
	}

	/**
	 * Empty the store, in this arm's dialect.
	 *
	 * @return array{bytes:int}|array{rows:int} What was released.
	 */
	abstract protected function discard(): array;

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
				$encoded = \array_map( fn ( array $row ): array => [ $row[0], $row[1], $this->encode( $row[2] ), $row[3] ], $rows );
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
	 * so a row reads back under whichever serializer is in force later. Its
	 * size joins bytes().
	 *
	 * @param mixed $value The value.
	 * @return string The tagged bytes.
	 * @throws \UnexpectedValueException When igbinary cannot serialize the value.
	 */
	private function encode( mixed $value ): string {
		if ( 'igbinary' !== self::serializer() ) {
			$tagged = 's' . \serialize( $value ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.serialize_serialize
		} else {
			$bytes = \igbinary_serialize( $value );
			if ( ! \is_string( $bytes ) ) {
				throw new \UnexpectedValueException( 'igbinary could not serialize the value' );
			}
			$tagged = 'i' . $bytes;
		}
		$this->bytes += \strlen( $tagged );
		return $tagged;
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
						$out[ $set_key ] = \count( $rows ) > $limit ? null : \array_map( $this->decode( ... ), $rows );
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
	 * Each live row among `$keys` with the life it has left, in one read: the
	 * `{ value, ttl? }` a Table's backing answers (ADR-18), `ttl` the whole
	 * seconds until the row expires and absent for a row that never does.
	 *
	 * @param list<string> $keys Keys.
	 * @return array<string,array{value: mixed, ttl?: int}>|false Key => entry,
	 *         an absent or expired key absent; false when the store failed,
	 *         which `last_failure()` names.
	 */
	public function read_entries( array $keys ): array|false {
		if ( [] === $keys ) {
			return [];
		}
		$now = self::now();
		return $this->attempt(
			fn (): array => $this->entries( $keys, static fn ( mixed $value, int $expires ): array => $expires > 0 ? [ 'value' => $value, 'ttl' => $expires - $now ] : [ 'value' => $value ] ),
			false
		);
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
	 * The row a Table stores a key under, in this arm's grammar: its store
	 * already belongs to this install, so the key carries no salt, and a
	 * salt rotation leaves the rows.
	 *
	 * @param string $key Key within the Table's namespace.
	 * @return string The row's key.
	 */
	abstract public function row_key( string $key ): string;

	/**
	 * Tagged bytes this arm has encoded for a write or decoded for a read
	 * since it was built, counted where each is computed, never re-serialized.
	 *
	 * @api Table_Node's per-verb counters read the change across one verb.
	 * @return int Bytes.
	 */
	public function bytes(): int {
		return $this->bytes;
	}

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
		return $this->attempt( fn (): array => $this->entries( $keys, static fn ( mixed $value ): mixed => $value ), false );
	}

	/**
	 * The live rows for `$keys`, each decoded and shaped in one pass.
	 *
	 * @template T
	 * @param list<string>            $keys  Keys.
	 * @param \Closure(mixed, int): T $shape The value, and its `expires` column.
	 * @return array<string,T>
	 */
	private function entries( array $keys, \Closure $shape ): array {
		$out = [];
		foreach ( $this->select_rows( \array_values( \array_unique( $keys ) ) ) as $key => [ $bytes, $expires ] ) {
			$out[ (string) $key ] = $shape( $this->decode( $bytes ), $expires );
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
	 * @param string $row The tagged bytes `encode()` wrote; its size joins bytes().
	 * @return mixed The value.
	 * @throws \UnexpectedValueException On a row no serializer here wrote.
	 */
	private function decode( string $row ): mixed {
		$this->bytes += \strlen( $row );
		return match ( $row[0] ?? '' ) {
			'i'     => \igbinary_unserialize( \substr( $row, 1 ) ),
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.serialize_unserialize
			's'     => \unserialize( \substr( $row, 1 ), [ 'allowed_classes' => false ] ),
			default => throw new \UnexpectedValueException( 'undecodable row' ),
		};
	}

	/**
	 * The live rows among `$keys`, however many statements that takes.
	 *
	 * @param list<string> $keys Keys.
	 * @return array<array-key,array{0: string, 1: int}> Key => [ tagged bytes,
	 *         the `expires` column ].
	 */
	abstract protected function select_rows( array $keys ): array;

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
