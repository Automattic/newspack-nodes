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
 * per call, so a gap is repaid in one pass. Both come from Table.pm, and
 * without them a fleet whose workers recycle faster than the window (idle
 * exit at 30s against a 200s window) never aged anything out at all.
 *
 * Two shapes use it, and they want opposite things from promotion. A WORKING
 * SET (the event logger's in-flight requests, keyed by request id) reads
 * eviction as "this one never completed", so promotion is what keeps a live
 * entry alive. A READ-THROUGH TIER (`Table_Node`'s L1) instead needs every
 * entry to age out on schedule, or the hottest key is the one most likely to
 * be stale forever — those build with without_promotion().
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

	/** @var int Upper clamp on num_buckets; caps how many buckets stay live. */
	private const MAX_BUCKETS = 100;

	/** @var int Max items per bucket. */
	private int $bucket_size;

	/** @var array<int,array<string,mixed>> Live buckets, keyed by bucket index. */
	private array $buckets = [];

	/** @var int Newest bucket index; monotonic, so an index is never reused. */
	private int $current = 0;

	/** @var float Absolute-grid instant the next timed rotation comes due. */
	private float $next_window = 0;

	/** @var int Max number of buckets. */
	private int $num_buckets;

	/** @var callable|null Called with (key, value) for each evicted item. */
	private $on_evict = null;

	/** @var bool Whether a hit moves into the newest bucket. */
	private bool $promote = true;

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
	 * Get item from cache, promoting it to the newest bucket.
	 *
	 * Searches newest bucket first. A hit in an older bucket moves the entry
	 * into the newest one, which resets its age and can itself trigger a
	 * rotation — so a read may evict the oldest bucket. without_promotion()
	 * turns that off.
	 *
	 * @api Consumers read a working set one key at a time.
	 * @param string $key Cache key.
	 * @return mixed|null Value, or null when the key is absent.
	 */
	public function get( string $key ) {
		$i = $this->bucket_of( $key );
		return null === $i ? null : $this->take( $i, $key );
	}

	/**
	 * Read many keys, found-only, keyed by cache key.
	 *
	 * Found-only rather than null-padded because a stored null and an absent
	 * key are the same value here, and callers layering this over a slower tier
	 * need the difference: what is missing is what they go and fetch.
	 *
	 * Keys come back `array-key` for the reason iterate() gives — a PHP array
	 * turns an all-digit string key into an int on the way in. With promotion
	 * on, this promotes like get() does, so a batch read can rotate a bucket
	 * and fire on_evict.
	 *
	 * @param list<string> $keys Cache keys.
	 * @return array<array-key,mixed> Values for the keys that were present.
	 */
	public function get_multi( array $keys ): array {
		$found = [];
		foreach ( $keys as $key ) {
			$i = $this->bucket_of( $key );
			if ( null !== $i ) {
				$found[ $key ] = $this->take( $i, $key );
			}
		}
		return $found;
	}

	/**
	 * Read a key from a known bucket, promoting it unless promotion is off.
	 *
	 * Promotion resets the entry's age and can itself trigger a rotation, so a
	 * read may evict the oldest bucket.
	 *
	 * @param int    $i   Bucket index bucket_of() returned.
	 * @param string $key Cache key.
	 * @return mixed The stored value.
	 */
	private function take( int $i, string $key ): mixed {
		$value = $this->buckets[ $i ][ $key ];
		if ( $this->promote && $i < $this->current ) {
			unset( $this->buckets[ $i ][ $key ] );
			$this->buckets[ $this->current ][ $key ] = $value;
			$this->maybe_rotate();
		}
		return $value;
	}

	/**
	 * Store many items, each under the same rules as set().
	 *
	 * Keys are `array-key` for the reason iterate() gives: a PHP array turns an
	 * all-digit string key into an int on the way in.
	 *
	 * @param array<array-key,mixed> $items Values keyed by cache key.
	 */
	public function set_multi( array $items ): void {
		foreach ( $items as $key => $value ) {
			$this->set( (string) $key, $value );
		}
	}

	/**
	 * Store an item in the newest bucket, rotating once that bucket fills.
	 *
	 * Re-setting a key that still sits in an older bucket leaves that copy in
	 * place, shadowed by this newer one. get() returns the newer copy, but
	 * delete() removes only that copy and the shadowed one resurfaces.
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
	 * entry ages out on wall-clock time rather than on how often we looked.
	 * num_buckets rolls already empty the cache, so a longer gap has nothing
	 * left to drop and the count caps there.
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
	 * pushing the boundary each time one fires let a busy cache defer the timed
	 * roll indefinitely.
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
	 * Without a callback the items simply vanish, so a cache that treats
	 * eviction as a signal must register one via with_timed_rotation().
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

	/** The per-tick cached clock, falling back to a live read. */
	private function clock(): float {
		return Core::$now ?: Core::right_now();
	}

	/**
	 * The first grid boundary strictly after $after.
	 *
	 * The grid is a pure function of the wall clock, so a process that replaces
	 * another lands on the boundary its predecessor would have used. That is
	 * what makes the phase survive a restart with nothing persisted. Table.pm
	 * snaps to localtime components; the epoch grid is the same idea without a
	 * DST discontinuity, and nothing here reads a boundary as a label.
	 */
	private function next_boundary( float $after ): float {
		return ( \floor( $after / $this->rotate_interval ) + 1 ) * $this->rotate_interval;
	}

	/**
	 * Delete an item, newest copy first. Silent when the key is absent.
	 *
	 * on_evict does not fire for a delete — eviction means the cache dropped
	 * the entry, not that a caller retired it.
	 *
	 * @param string $key Cache key.
	 */
	public function delete( string $key ): void {
		$i = $this->bucket_of( $key );
		if ( null !== $i ) {
			unset( $this->buckets[ $i ][ $key ] );
		}
	}

	/**
	 * The newest live bucket holding the key, or null when it is absent.
	 *
	 * The one probe every read goes through, so a lookup walks the bucket list
	 * once — a found/fetch pair walked it twice, and a batch paid that per key.
	 *
	 * @param string $key Cache key.
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
	 * Iterate every item, newest bucket first and insertion order within a
	 * bucket. Mutating the cache mid-iteration is unsupported.
	 *
	 * Keys are `array-key`, not `string`: buckets are PHP arrays, so a key that
	 * is an all-digit string comes back an int. A `url_hash` is 12 hex chars,
	 * which is all-digits roughly one time in 290 — callers must handle both,
	 * and narrowing this to `string` makes those guards look like dead code.
	 *
	 * @api Consumers walk a working set (in-flight requests, per-URL accumulators).
	 * @return \Generator<array-key,mixed> Yields value keyed by cache key.
	 */
	public function iterate(): \Generator {
		foreach ( $this->live_indices() as $i ) {
			foreach ( $this->buckets[ $i ] as $key => $value ) {
				yield $key => $value;
			}
		}
	}

	/**
	 * Live bucket indices, newest first.
	 *
	 * Indices are monotonic and ride through get_state(), so `current` climbs
	 * for the life of the log while only num_buckets buckets exist. Counting
	 * down from it made a miss cost the whole history — a live worker sat at
	 * index 2053 holding three buckets.
	 *
	 * @return list<int>
	 */
	private function live_indices(): array {
		$indices = \array_keys( $this->buckets );
		\rsort( $indices );
		return $indices;
	}

	/**
	 * Stop a hit from moving into the newest bucket.
	 *
	 * A read-through tier wants this: promotion resets an entry's age, so the
	 * hottest key would be the one most likely to be stale forever and any
	 * window over this cache would be decorative. A working set wants the
	 * default, where a read is what keeps a live entry alive.
	 *
	 * @return self This cache, for chaining onto the constructor.
	 */
	public function without_promotion(): self {
		$this->promote = false;
		return $this;
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
	 * Malformed input leaves the cache untouched rather than throwing. The
	 * restored buckets are clamped only in that `current` lands on a real
	 * bucket index: a snapshot holding more buckets than num_buckets, or
	 * fuller ones than bucket_size, stays oversized until successive
	 * rotations trim it one bucket at a time.
	 *
	 * @api The read half of get_state().
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
