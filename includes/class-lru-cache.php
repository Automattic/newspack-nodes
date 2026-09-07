<?php
/**
 * LRU Cache
 *
 * Bucket-based LRU cache for in-memory data. Writes land in the newest
 * bucket; a full bucket (or a closed rotation window) opens a fresh one
 * and drops the oldest once the bucket count exceeds capacity. Reading an
 * entry promotes it to the newest bucket, so anything touched regularly
 * outlives the rotation window and only idle keys age out.
 *
 * Timed rotation runs on an ABSOLUTE grid — see next_boundary(). The boundary
 * is derived from the wall clock rather than from when this instance was
 * built, so a cache restored into a fresh process keeps its predecessor's
 * phase; and rotate_if_due() rolls once per elapsed window rather than once
 * per call, so a gap is repaid in one pass. Both come from Table.pm: without
 * them a worker that exits before its window closes restarts the wait, and a
 * fleet recycling faster than the event logger's 200-second rotation ages
 * nothing out at all.
 *
 * Every shape that uses it wants promotion. A WORKING SET (the event logger's
 * in-flight requests, keyed by request id) reads eviction as "this one never
 * completed"; an ACCUMULATOR (`Table_Node`'s tier, per-URL aggregates) would
 * lose counts it has not drained. In both, a hit keeping an entry alive is
 * exactly right.
 *
 * A variant of Tachikoma's bucket LRU — `Nodes/Table.pm` `lru_lookup`
 * (https://github.com/datapoke/tachikoma), in the shape our DN `ReqGrep.pm`
 * uses it. That DN tree is not public, so only the Table.pm half is followable.
 *
 * Store objects (not arrays) for zero-copy mutation — objects are
 * references in PHP, so get() returns the same instance.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * LRU cache using bucket rotation.
 *
 * Holds at most `bucket_size * num_buckets` items, both clamped by the
 * constructor.
 */
class LRU_Cache {

	/**
	 * Upper clamp on num_buckets. A miss walks every live bucket, so the
	 * bucket count is what a lookup costs.
	 *
	 * @var int
	 */
	private const MAX_BUCKETS = 100;

	/** @var int Max items per bucket. */
	private int $bucket_size;

	/** @var array<int,array<string,mixed>> Live buckets, keyed by bucket index. */
	private array $buckets = [];

	/** @var int Newest bucket index. It climbs monotonically; flush() restarts it at 0. */
	private int $current = 0;

	/** @var float Absolute-grid instant the next timed rotation comes due. */
	private float $next_window = 0;

	/** @var int Max number of buckets. */
	private int $num_buckets;

	/** @var callable|null Called with (key, value) for each evicted item. */
	private $on_evict = null;

	/** @var float Seconds between time-based rotations (0 = capacity-only). */
	private float $rotate_interval = 0;

	/**
	 * Constructor.
	 *
	 * @param int $bucket_size Max items per bucket; clamped to at least 1.
	 * @param int $num_buckets Max number of buckets; clamped to 1..MAX_BUCKETS.
	 */
	public function __construct( int $bucket_size = 250, int $num_buckets = 5 ) {
		$this->bucket_size = \max( 1, $bucket_size );
		$this->num_buckets = \max( 1, \min( $num_buckets, self::MAX_BUCKETS ) );
	}

	/**
	 * Read an item, promoting it to the newest bucket.
	 *
	 * Searches the newest bucket first. A hit in an older bucket moves the
	 * entry into the newest one, which resets its age and can itself trigger a
	 * rotation — so a read may evict the oldest bucket.
	 *
	 * @api Consumers read a working set one key at a time.
	 * @param string $key Cache key.
	 * @return mixed Value, or null when the key is absent — a stored null is indistinguishable from a miss.
	 */
	public function get( string $key ) {
		$i = $this->bucket_of( $key );
		return null === $i ? null : $this->take( $i, $key );
	}

	/**
	 * Read a key from a known bucket, promoting it to the newest one.
	 *
	 * A hit in the newest bucket is already current, so it stays where it is;
	 * only an older bucket's entry moves.
	 *
	 * @param int    $i   Bucket index bucket_of() returned.
	 * @param string $key Cache key.
	 * @return mixed The stored value.
	 */
	private function take( int $i, string $key ): mixed {
		$value = $this->buckets[ $i ][ $key ];
		if ( $i < $this->current ) {
			unset( $this->buckets[ $i ][ $key ] );
			$this->buckets[ $this->current ][ $key ] = $value;
			$this->maybe_rotate();
		}
		return $value;
	}

	/**
	 * The newest live bucket holding the key, or null when it is absent.
	 *
	 * The one probe every read goes through, so a lookup walks the bucket list
	 * once. A separate found/fetch pair walks it twice, and a batch pays that
	 * on every key.
	 *
	 * @param string $key Cache key.
	 * @return int|null Bucket index, or null when the key is absent.
	 */
	private function bucket_of( string $key ): ?int {
		foreach ( $this->live_indices() as $i ) {
			if ( \array_key_exists( $key, $this->buckets[ $i ] ) ) {
				return $i;
			}
		}
		return null;
	}

	/**
	 * Store an item in the newest bucket, rotating once that bucket fills.
	 *
	 * Re-setting a key that still sits in an older bucket leaves that copy in
	 * place, shadowed by this newer one — cleaning it here would put a bucket
	 * walk on every write. get() returns the newer copy, delete() takes both,
	 * and iterate() yields the key once; the shadow itself goes when its own
	 * bucket ages out.
	 *
	 * @param string $key   Cache key.
	 * @param mixed  $value Value to store.
	 */
	public function set( string $key, $value ): void {
		if ( empty( $this->buckets ) ) {
			$this->buckets[0] = [];
			$this->current    = 0;
		}

		$this->buckets[ $this->current ][ $key ] = $value;
		$this->maybe_rotate();
	}

	/**
	 * Rotate when the newest bucket is full. Callers must have created it.
	 */
	private function maybe_rotate(): void {
		if ( \count( $this->buckets[ $this->current ] ) < $this->bucket_size ) {
			return;
		}
		$this->force_rotate();
	}

	/**
	 * Roll every window that has closed since the last call.
	 *
	 * Call this periodically from the processing loop — nothing ages out on a
	 * quiet cache otherwise, since capacity rotation needs writes. A no-op
	 * until with_timed_rotation() sets an interval.
	 *
	 * Rolls once PER elapsed window, not once per call: a gap — a process that
	 * was down, or a stretch with no ticks — is repaid in one pass, so a stalled
	 * entry ages out on wall-clock time rather than on how often a caller looks.
	 * num_buckets rolls already empty the cache, so a longer gap has nothing
	 * left to drop and the count caps there.
	 *
	 * @api Sibling plugins roll the window from their own tick.
	 */
	public function rotate_if_due(): void {
		if ( $this->rotate_interval <= 0 ) {
			return;
		}
		$now = $this->clock();
		if ( $now < $this->next_window ) {
			return;
		}
		$elapsed = 1 + (int) \floor( ( $now - $this->next_window ) / $this->rotate_interval );
		for ( $roll = \min( $elapsed, $this->num_buckets ); $roll > 0; $roll-- ) {
			$this->force_rotate();
		}
		$this->next_window = $this->next_boundary( $now );
	}

	/**
	 * Open a fresh newest bucket, evicting the oldest one past capacity.
	 *
	 * Leaves the time grid alone — a capacity rotation is not a window, and
	 * pushing the boundary each time one fires would let a busy cache defer the
	 * timed roll indefinitely.
	 */
	private function force_rotate(): void {
		++$this->current;
		$this->buckets[ $this->current ] = [];

		if ( \count( $this->buckets ) > $this->num_buckets ) {
			$oldest = \min( \array_keys( $this->buckets ) );
			$this->evict_bucket( $oldest );
		}
	}

	/**
	 * Evict a bucket, calling the on_evict callback for each item.
	 *
	 * Without a callback the items vanish, so a cache that reads eviction as a
	 * signal registers one through with_timed_rotation().
	 *
	 * @param int $index Bucket index to evict.
	 */
	private function evict_bucket( int $index ): void {
		if ( ! isset( $this->buckets[ $index ] ) ) {
			return;
		}
		if ( $this->on_evict ) {
			foreach ( $this->buckets[ $index ] as $key => $value ) {
				( $this->on_evict )( $key, $value );
			}
		}
		unset( $this->buckets[ $index ] );
	}

	/**
	 * Set the time-based rotation interval and the eviction callback.
	 *
	 * This is the only way to register on_evict, and the callback fires for
	 * capacity evictions too — pass a large interval to get the callback
	 * without timed rotation.
	 *
	 * @api Sibling plugins arm the wall-clock window and its evict callback.
	 * @param float    $seconds  Seconds between rotations.
	 * @param callable $on_evict Called with (key, value) for each evicted item.
	 * @return self This cache, for chaining onto the constructor.
	 */
	public function with_timed_rotation( float $seconds, callable $on_evict ): self {
		$this->rotate_interval = $seconds;
		$this->on_evict        = $on_evict;
		if ( $seconds > 0 ) {
			$this->next_window = $this->next_boundary( $this->clock() );
		}
		return $this;
	}

	/** The cached per-tick clock, falling back to a live read outside a drain loop. */
	private function clock(): float {
		return Core::$now ?: Core::right_now();
	}

	/**
	 * The first grid boundary strictly after $after.
	 *
	 * The grid is a pure function of the wall clock, so a process that replaces
	 * another lands on the boundary its predecessor would have used. That is
	 * what makes the phase survive a restart with nothing persisted. Timers ride
	 * the same clock-derived grid (ADR-17); this one carries no phase offset,
	 * because no cadence here has to align with another. Table.pm snaps to
	 * localtime components; the epoch grid is the same idea without a DST
	 * discontinuity, and nothing here reads a boundary as a label.
	 *
	 * @param float $after Instant to search forward from.
	 * @return float The boundary strictly after it.
	 */
	private function next_boundary( float $after ): float {
		return ( \floor( $after / $this->rotate_interval ) + 1 ) * $this->rotate_interval;
	}

	/**
	 * Delete every copy of an item. Silent when the key is absent.
	 *
	 * Every copy, not the newest: set() leaves an older copy shadowed, and
	 * dropping only the newest resurrects a value the caller retired. The walk
	 * is num_buckets long on an operation that is rare, so the hot set() path
	 * stays as it is.
	 *
	 * on_evict does not fire for a delete — eviction means the cache dropped
	 * the entry, not that a caller retired it.
	 *
	 * @api Sibling plugins drop a key they have finished with.
	 * @param string $key Cache key.
	 */
	public function delete( string $key ): void {
		foreach ( $this->live_indices() as $i ) {
			unset( $this->buckets[ $i ][ $key ] );
		}
	}

	/**
	 * Iterate every item, newest bucket first and insertion order within a
	 * bucket. Mutating the cache mid-iteration is unsupported.
	 *
	 * Each key is yielded once, with the value get() would return: a key
	 * re-set across a rotation still has its shadowed older copy, and yielding
	 * both would make a sweep process a retired value and over-report a count.
	 *
	 * Keys are `array-key`, not `string`: buckets are PHP arrays, so a key that
	 * is an all-digit string comes back an int. A `url_hash` is 12 hex chars,
	 * which PHP reads as an int roughly one time in 300 — callers must handle
	 * both, and narrowing this to `string` makes those guards look like dead
	 * code.
	 *
	 * @api Consumers walk a working set (in-flight requests, per-URL accumulators).
	 * @return \Generator<array-key,mixed> Yields value keyed by cache key.
	 */
	public function iterate(): \Generator {
		$seen = [];
		foreach ( $this->live_indices() as $i ) {
			foreach ( $this->buckets[ $i ] as $key => $value ) {
				if ( isset( $seen[ $key ] ) ) {
					continue;
				}
				$seen[ $key ] = true;
				yield $key => $value;
			}
		}
	}

	/**
	 * Live bucket indices, newest first.
	 *
	 * Indices are monotonic and ride through get_state(), so `current` climbs
	 * for the life of the log while only num_buckets buckets exist. Counting
	 * down from it would make every miss walk that whole history.
	 *
	 * @return list<int>
	 */
	private function live_indices(): array {
		$indices = \array_keys( $this->buckets );
		\rsort( $indices );
		return $indices;
	}

	/**
	 * Drop every item without firing on_evict, and restart bucket numbering.
	 *
	 * @api Consumers empty a working set they have just drained.
	 */
	public function flush(): void {
		$this->buckets = [];
		$this->current = 0;
	}

	/**
	 * Snapshot the buckets for serialization.
	 *
	 * `Request_Builder_Node::save_state()` persists this so in-flight requests
	 * survive a worker restart. Rotation settings and on_evict stay out — the
	 * restoring instance supplies its own. The window boundary DOES ride along:
	 * the grid gives a fresh cache the right phase, but only the boundary the
	 * predecessor was actually waiting on tells the successor how many windows
	 * went by unattended, and those are exactly the ones to repay.
	 *
	 * @api Consumers persist a working set across a worker restart.
	 * @return array<string,mixed> Keys `buckets`, `current` and `next_window`.
	 */
	public function get_state(): array {
		return [
			'buckets'     => $this->buckets,
			'current'     => $this->current,
			'next_window' => $this->next_window,
		];
	}

	/**
	 * Restore a get_state() snapshot, replacing everything held now.
	 *
	 * A non-array `buckets` or a non-int `current` leaves the cache untouched
	 * rather than throwing; an absent or empty `buckets` empties it. Otherwise
	 * the snapshot is adopted as it stands, with `current` floored at 0 and
	 * capped at the highest restored bucket index: a snapshot holding more
	 * buckets than num_buckets, or fuller ones than bucket_size, stays
	 * oversized until successive rotations trim it one bucket at a time.
	 *
	 * @api Consumers restore a persisted working set at worker start.
	 * @param array<string,mixed> $state State array from get_state().
	 */
	public function restore_state( array $state ): void {
		$buckets = $state['buckets'] ?? [];
		$current = $state['current'] ?? 0;

		if ( ! \is_array( $buckets ) || ! \is_int( $current ) ) {
			return;
		}

		if ( empty( $buckets ) ) {
			$this->buckets = [];
			$this->current = 0;
			return;
		}

		$max_key = \max( \array_keys( $buckets ) );
		/** @var array<int,array<string,mixed>> $buckets */
		$this->buckets = $buckets;
		$this->current = (int) \max( 0, \min( $current, $max_key ) );

		// Adopt the predecessor's boundary so rotate_if_due() repays the gap.
		$carried = $state['next_window'] ?? null;
		if ( \is_float( $carried ) || \is_int( $carried ) ) {
			$this->next_window = (float) $carried;
		}
	}
}
