<?php
/**
 * Tests for Newspack_Nodes\LRU_Cache.
 *
 * Verifies bucket rotation, LRU promotion, eviction with on_evict callbacks,
 * timed rotation, and serialization round-trips.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\LRU_Cache;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( LRU_Cache::class )]
class LruCacheTest extends TestCase {

	/** @var float Core::$now as this suite found it; Core::reset() does not clear it. */
	private float $saved_now = 0.0;

	protected function setUp(): void {
		parent::setUp();
		$this->saved_now = Core::$now;
	}

	protected function tearDown(): void {
		Core::$now = $this->saved_now;
		parent::tearDown();
	}

	// ── Basic get/set/delete ───────────────────────────────────────────────

	public function test_get_set_basic(): void {
		$cache = new LRU_Cache( 10, 3 );
		$cache->set( 'key1', 'value1' );
		$this->assertSame( 'value1', $cache->get( 'key1' ) );
	}

	public function test_get_nonexistent_returns_null(): void {
		$cache = new LRU_Cache( 10, 3 );
		$this->assertNull( $cache->get( 'missing' ) );
	}

	public function test_set_overwrites_existing(): void {
		$cache = new LRU_Cache( 10, 3 );
		$cache->set( 'key', 'old' );
		$cache->set( 'key', 'new' );
		$this->assertSame( 'new', $cache->get( 'key' ) );
	}

	public function test_set_different_value_types(): void {
		$cache = new LRU_Cache( 10, 3 );

		$cache->set( 'int', 42 );
		$cache->set( 'float', 3.14 );
		$cache->set( 'bool', true );
		$cache->set( 'array', [ 1, 2, 3 ] );

		$this->assertSame( 42, $cache->get( 'int' ) );
		$this->assertSame( 3.14, $cache->get( 'float' ) );
		$this->assertTrue( $cache->get( 'bool' ) );
		$this->assertSame( [ 1, 2, 3 ], $cache->get( 'array' ) );
	}

	public function test_set_object_returns_same_reference(): void {
		// LRU spec note: storing objects gives zero-copy mutation since PHP
		// objects are references. Mutating through get() must mutate the stored
		// object too — essential behaviour for the InflightTracker pattern.
		$cache  = new LRU_Cache( 10, 3 );
		$object = new \stdClass();
		$object->count = 0;
		$cache->set( 'k', $object );

		$retrieved = $cache->get( 'k' );
		++$retrieved->count;

		$this->assertSame( 1, $cache->get( 'k' )->count );
		$this->assertSame( $object, $retrieved );
	}

	public function test_delete_removes_entry(): void {
		$cache = new LRU_Cache( 10, 3 );
		$cache->set( 'key', 'value' );
		$cache->delete( 'key' );
		$this->assertNull( $cache->get( 'key' ) );
	}

	public function test_delete_nonexistent_is_safe(): void {
		$cache = new LRU_Cache( 10, 3 );
		$cache->delete( 'nope' );
		$this->assertTrue( true );
	}

	public function test_delete_finds_in_old_bucket(): void {
		// Place entry in bucket 0, fill bucket 0 to trigger rotation, then
		// delete the original — must traverse buckets back and remove.
		$cache = new LRU_Cache( 2, 3 );
		$cache->set( 'a', 1 );
		$cache->set( 'b', 2 );
		// Bucket 0 full; next set rotates to bucket 1.
		$cache->set( 'c', 3 );

		$cache->delete( 'a' );
		$this->assertNull( $cache->get( 'a' ) );
		$this->assertSame( 2, $cache->get( 'b' ) );
	}

	// ── Bucket rotation + LRU eviction ─────────────────────────────────────

	public function test_lru_eviction_evicts_oldest_bucket_first(): void {
		// bucket_size=3, num_buckets=2 → max ~6 items before oldest bucket
		// evicts. Verify the "least recently used" bucket goes first.
		$cache = new LRU_Cache( 3, 2 );

		$cache->set( 'a', 1 );
		$cache->set( 'b', 2 );
		$cache->set( 'c', 3 );

		// Triggers rotation to bucket 1.
		$cache->set( 'd', 4 );
		$cache->set( 'e', 5 );
		$cache->set( 'f', 6 );

		// Triggers rotation to bucket 2; with num_buckets=2, evicts bucket 0.
		$cache->set( 'g', 7 );

		$this->assertNull( $cache->get( 'a' ), 'oldest bucket evicted' );
		$this->assertNull( $cache->get( 'b' ) );
		$this->assertNull( $cache->get( 'c' ) );
		// Newer items survive.
		$this->assertSame( 4, $cache->get( 'd' ) );
		$this->assertSame( 7, $cache->get( 'g' ) );
	}

	public function test_get_promotes_to_current_bucket(): void {
		// Promotion is the LRU mechanism — re-reading an old entry moves it
		// to the current bucket so it survives subsequent rotations. Without
		// promotion, frequently-read but rarely-written entries would evict
		// after num_buckets rotations regardless of access pattern.
		$cache = new LRU_Cache( 3, 3 );

		$cache->set( 'a', 1 );
		$cache->set( 'b', 2 );
		$cache->set( 'c', 3 );

		// Trigger rotation (now on bucket 1).
		$cache->set( 'd', 4 );

		// Promote 'a' to bucket 1.
		$this->assertSame( 1, $cache->get( 'a' ) );

		// Continue filling to evict bucket 0 — 'a' was promoted, so it
		// should outlast 'b' and 'c'.
		$cache->set( 'e', 5 );
		$cache->set( 'f', 6 );
		$cache->set( 'g', 7 );
		$cache->set( 'h', 8 );
		$cache->set( 'i', 9 );

		$this->assertNull( $cache->get( 'b' ), 'non-promoted entries evict' );
		$this->assertNull( $cache->get( 'c' ) );
	}

	public function test_bucket_rotation_with_single_bucket(): void {
		// num_buckets=1: rotation immediately evicts the only bucket.
		$cache = new LRU_Cache( 2, 1 );
		$cache->set( 'a', 1 );
		$cache->set( 'b', 2 );
		$cache->set( 'c', 3 ); // Triggers rotation + eviction.

		$this->assertNull( $cache->get( 'a' ) );
		$this->assertNull( $cache->get( 'b' ) );
		$this->assertSame( 3, $cache->get( 'c' ) );
	}

	public function test_min_bucket_count_of_1(): void {
		// num_buckets clamped to >=1.
		$cache = new LRU_Cache( 5, 0 );
		$cache->set( 'a', 1 );
		$this->assertSame( 1, $cache->get( 'a' ) );
	}

	public function test_max_bucket_count_of_100(): void {
		// num_buckets clamped to <=100. Just verifies the clamp doesn't break
		// instantiation — actual bucket count is implementation-internal.
		$cache = new LRU_Cache( 1, 5000 );
		$cache->set( 'a', 1 );
		$this->assertSame( 1, $cache->get( 'a' ) );
	}

	public function test_bucket_size_clamped_to_min_1(): void {
		$cache = new LRU_Cache( 0, 3 );
		// Each set immediately triggers rotation since bucket size is clamped to 1.
		$cache->set( 'a', 1 );
		$cache->set( 'b', 2 );
		$cache->set( 'c', 3 );
		$this->assertSame( 3, $cache->get( 'c' ) );
	}

	// ── on_evict callbacks ─────────────────────────────────────────────────

	public function test_on_evict_callback_called_on_capacity_eviction(): void {
		$evicted = [];
		$cache   = new LRU_Cache( 2, 2 );
		$cache->with_timed_rotation( 999, function ( $k, $v ) use ( &$evicted ) {
			$evicted[ $k ] = $v;
		} );

		// Fill bucket 0 then bucket 1; the third bucket forces eviction of bucket 0.
		$cache->set( 'a', 1 );
		$cache->set( 'b', 2 );
		$cache->set( 'c', 3 ); // Triggers rotation.
		$cache->set( 'd', 4 );
		$cache->set( 'e', 5 ); // Triggers second rotation, evicts bucket 0.

		$this->assertSame( [ 'a' => 1, 'b' => 2 ], $evicted );
	}

	public function test_evict_bucket_without_callback_safe(): void {
		// No on_evict registered (default constructor) — eviction must not throw.
		$cache = new LRU_Cache( 2, 2 );
		$cache->set( 'a', 1 );
		$cache->set( 'b', 2 );
		$cache->set( 'c', 3 );
		$cache->set( 'd', 4 );
		$cache->set( 'e', 5 ); // Eviction.

		$this->assertNull( $cache->get( 'a' ) );
		$this->assertSame( 5, $cache->get( 'e' ) );
	}

	// ── Timed rotation ────────────────────────────────────────────────────

	public function test_with_timed_rotation_returns_self(): void {
		$cache = new LRU_Cache( 10, 3 );
		$result = $cache->with_timed_rotation( 1.0, function () {} );
		$this->assertSame( $cache, $result );
	}

	public function test_rotate_if_due_noop_without_timed_rotation(): void {
		$cache = new LRU_Cache( 10, 3 );
		$cache->set( 'a', 1 );
		$cache->rotate_if_due();
		$this->assertSame( 1, $cache->get( 'a' ) );
	}

	public function test_rotate_if_due_rotates_after_interval(): void {
		// Timed rotation reads the cached per-tick clock (production drives this
		// from the drain loop); advance Core::$now to simulate elapsed ticks.
		Core::$now = 500.0;
		$cache     = new LRU_Cache( 100, 2 );
		$evicted   = [];
		$cache->with_timed_rotation( 0.001, function ( $k, $v ) use ( &$evicted ) {
			$evicted[ $k ] = $v;
		} );

		$cache->set( 'a', 1 );
		$cache->set( 'b', 2 );

		Core::$now = 500.002; // +2ms > 1ms interval.
		$cache->rotate_if_due(); // bucket 0 → bucket 1 (no eviction yet, count <= 2).
		Core::$now = 500.004;
		$cache->rotate_if_due(); // bucket 1 → bucket 2 (count > 2, evicts bucket 0).

		$this->assertArrayHasKey( 'a', $evicted );
		$this->assertArrayHasKey( 'b', $evicted );
	}

	/**
	 * The window boundary belongs to the CLOCK, not to the process. Anchoring it
	 * at construction meant a cache built 150s into a 200s window waited another
	 * 200s, and every worker generation restarted the wait.
	 */
	public function test_the_window_boundary_sits_on_an_absolute_grid(): void {
		// 1_000_000 is an exact multiple of 200, so the next boundary is 1_000_200.
		Core::$now = 1000150.0;
		$cache     = ( new LRU_Cache( 100, 3 ) )->with_timed_rotation( 200.0, static fn() => null );
		$cache->set( 'a', 1 );

		Core::$now = 1000200.0;
		$cache->rotate_if_due();

		$this->assertSame( 1, $cache->get_state()['current'], 'rolls on the grid boundary, 50s in' );
	}

	/**
	 * One `rotate_if_due()` per elapsed window, not one per call — otherwise a
	 * process that was down (or quiet) through several windows repays only one
	 * of them and stale entries outlive the retention span.
	 */
	public function test_a_gap_of_several_windows_rolls_each_of_them_at_once(): void {
		$evicted   = [];
		Core::$now = 1000000.0;
		$cache     = ( new LRU_Cache( 100, 3 ) )->with_timed_rotation(
			200.0,
			function ( $k ) use ( &$evicted ) {
				$evicted[] = $k;
			}
		);
		$cache->set( 'stalled', 'req' );

		Core::$now = 1001000.0; // five windows later, a single call
		$cache->rotate_if_due();

		$this->assertContains( 'stalled', $evicted );
	}

	/**
	 * The reported failure. `on_demand_idle` is 30, so the worker recycles long
	 * before a 200s window elapses; with the clock anchored at construction and
	 * absent from get_state(), the wait restarted every generation and a stalled
	 * request was never evicted — never emitted as timed out.
	 */
	public function test_entries_age_out_across_short_lived_worker_generations(): void {
		$window   = 200.0;
		$evicted  = [];
		$on_evict = function ( $k ) use ( &$evicted ) {
			$evicted[] = $k;
		};

		Core::$now = 1000000.0;
		$cache     = ( new LRU_Cache( 100, 3 ) )->with_timed_rotation( $window, $on_evict );
		$cache->set( 'stalled', 'req' );
		$state = $cache->get_state();

		// 21 generations x 30s = 630s of wall clock, no generation over 30s.
		for ( $generation = 0; $generation < 21; $generation++ ) {
			$cache = ( new LRU_Cache( 100, 3 ) )->with_timed_rotation( $window, $on_evict );
			$cache->restore_state( $state );
			for ( $tick = 0; $tick < 30; $tick++ ) {
				Core::$now += 1.0;
				$cache->rotate_if_due();
			}
			$state = $cache->get_state();
		}

		$this->assertContains( 'stalled', $evicted, '600s of wall clock must age an entry out' );
	}

	/**
	 * The grid fixes the PHASE, but a boundary crossed while no worker was
	 * alive still has to be repaid. `next_window` was left out of get_state(),
	 * so each generation re-derived it from its own start and skipped every
	 * window the gap covered — with 30s generations against a 200s window that
	 * is most of them, and the catch-up loop never fired in the restart path.
	 */
	public function test_windows_missed_while_no_process_was_alive_are_repaid(): void {
		$evicted  = [];
		$on_evict = function ( $k ) use ( &$evicted ) {
			$evicted[] = $k;
		};

		Core::$now = 1000000.0;
		$cache     = ( new LRU_Cache( 100, 3 ) )->with_timed_rotation( 200.0, $on_evict );
		$cache->set( 'stalled', 'req' );
		$state = $cache->get_state();

		// The successor starts 700s later: three boundaries went by unattended.
		Core::$now = 1000700.0;
		$cache     = ( new LRU_Cache( 100, 3 ) )->with_timed_rotation( 200.0, $on_evict );
		$cache->restore_state( $state );
		$cache->rotate_if_due();

		$this->assertContains( 'stalled', $evicted );
	}

	/**
	 * Bucket indices are monotonic and persisted, so `current` climbs forever
	 * across generations while only num_buckets indices ever exist. Scanning it
	 * down to zero made every MISS — and Request_Builder takes one per firehose
	 * line that opens a request — cost a walk proportional to the cache's whole
	 * history. A live worker was already at index 2053 holding three buckets.
	 */
	public function test_a_miss_does_not_scan_the_whole_index_history(): void {
		$cache = new LRU_Cache( 100, 3 );
		$cache->restore_state( [
			'buckets' => [ 4999998 => [ 'a' => 1 ], 4999999 => [], 5000000 => [] ],
			'current' => 5000000,
		] );

		$started = \microtime( true );
		for ( $i = 0; $i < 20; $i++ ) {
			$this->assertNull( $cache->get( 'absent' ) );
		}
		$elapsed = \microtime( true ) - $started;

		$this->assertSame( 1, $cache->get( 'a' ), 'live buckets still resolve' );
		$this->assertLessThan( 1.0, $elapsed, '20 misses must not walk 5M dead indices each' );
	}

	public function test_rotate_if_due_does_not_rotate_before_interval(): void {
		$cache = new LRU_Cache( 100, 2 );
		$cache->with_timed_rotation( 10.0, function () {} );

		$cache->set( 'a', 1 );
		$cache->rotate_if_due(); // Shouldn't rotate (10s not elapsed).
		$cache->rotate_if_due();
		$cache->rotate_if_due();

		// 'a' must still be reachable; cache shouldn't have evicted anything.
		$this->assertSame( 1, $cache->get( 'a' ) );
	}

	public function test_active_items_survive_timed_rotation(): void {
		$cache   = new LRU_Cache( 100, 3 );
		$evicted = [];
		$cache->with_timed_rotation( 0.001, function ( $k ) use ( &$evicted ) {
			$evicted[] = $k;
		} );

		$cache->set( 'active', 'val' );

		\usleep( 2000 );
		$cache->rotate_if_due();
		// Touch promotes 'active' to the new current bucket.
		$cache->get( 'active' );
		\usleep( 2000 );
		$cache->rotate_if_due();
		\usleep( 2000 );
		$cache->rotate_if_due();

		$this->assertSame( 'val', $cache->get( 'active' ), 'promoted entry survives' );
		$this->assertNotContains( 'active', $evicted );
	}

	// ── Iteration ──────────────────────────────────────────────────────────

	public function test_iterate_returns_all_entries(): void {
		$cache = new LRU_Cache( 10, 3 );
		$cache->set( 'x', 1 );
		$cache->set( 'y', 2 );
		$cache->set( 'z', 3 );

		$items = [];
		foreach ( $cache->iterate() as $key => $value ) {
			$items[ $key ] = $value;
		}

		$this->assertCount( 3, $items );
		$this->assertSame( 1, $items['x'] );
		$this->assertSame( 2, $items['y'] );
		$this->assertSame( 3, $items['z'] );
	}

	public function test_iterate_empty_cache(): void {
		$cache = new LRU_Cache( 10, 3 );
		$items = [];
		foreach ( $cache->iterate() as $key => $value ) {
			$items[ $key ] = $value;
		}
		$this->assertEmpty( $items );
	}

	public function test_iterate_across_buckets(): void {
		$cache = new LRU_Cache( 2, 3 );
		$cache->set( 'a', 1 );
		$cache->set( 'b', 2 );
		$cache->set( 'c', 3 ); // rotates
		$cache->set( 'd', 4 );

		$items = [];
		foreach ( $cache->iterate() as $key => $value ) {
			$items[ $key ] = $value;
		}

		$this->assertCount( 4, $items );
	}

	// ── State serialization ────────────────────────────────────────────────

	public function test_get_state_and_restore_state(): void {
		$cache = new LRU_Cache( 5, 3 );
		$cache->set( 'k1', 'v1' );
		$cache->set( 'k2', 'v2' );
		$cache->set( 'k3', 'v3' );

		$state = $cache->get_state();
		$this->assertArrayHasKey( 'buckets', $state );
		$this->assertArrayHasKey( 'current', $state );

		$cache2 = new LRU_Cache( 5, 3 );
		$cache2->restore_state( $state );

		$this->assertSame( 'v1', $cache2->get( 'k1' ) );
		$this->assertSame( 'v2', $cache2->get( 'k2' ) );
		$this->assertSame( 'v3', $cache2->get( 'k3' ) );
	}

	public function test_restore_state_with_empty_state(): void {
		$cache = new LRU_Cache( 5, 3 );
		$cache->set( 'existing', 'data' );

		$cache->restore_state( [] );
		$this->assertNull( $cache->get( 'existing' ) );
	}

	public function test_restore_state_with_invalid_buckets_type(): void {
		// Validation: non-array buckets must be rejected (no state change).
		$cache = new LRU_Cache( 5, 3 );
		$cache->set( 'a', 1 );

		$cache->restore_state( [ 'buckets' => 'not an array', 'current' => 0 ] );
		// Original entry should still be reachable since validation rejected.
		$this->assertSame( 1, $cache->get( 'a' ) );
	}

	public function test_restore_state_with_invalid_current_type(): void {
		$cache = new LRU_Cache( 5, 3 );
		$cache->set( 'a', 1 );

		$cache->restore_state( [ 'buckets' => [ 0 => [ 'b' => 2 ] ], 'current' => 'not int' ] );
		$this->assertSame( 1, $cache->get( 'a' ), 'invalid current rejected, original preserved' );
	}

	public function test_restore_state_clamps_current_to_max_key(): void {
		// Out-of-range current must clamp to the highest bucket index.
		$cache = new LRU_Cache( 5, 3 );
		$cache->restore_state( [
			'buckets' => [ 0 => [ 'a' => 1 ], 1 => [ 'b' => 2 ] ],
			'current' => 999,
		] );

		$this->assertSame( 1, $cache->get( 'a' ) );
		$this->assertSame( 2, $cache->get( 'b' ) );
	}

	public function test_restore_state_clamps_negative_current(): void {
		$cache = new LRU_Cache( 5, 3 );
		$cache->restore_state( [
			'buckets' => [ 0 => [ 'a' => 1 ] ],
			'current' => -10,
		] );

		$this->assertSame( 1, $cache->get( 'a' ) );
	}

	public function test_get_state_preserves_bucket_structure(): void {
		$cache = new LRU_Cache( 3, 3 );
		for ( $i = 0; $i < 9; $i++ ) {
			$cache->set( "k{$i}", $i );
		}
		$state = $cache->get_state();

		$this->assertGreaterThan( 1, \count( $state['buckets'] ) );
		$this->assertGreaterThan( 0, $state['current'] );
	}

	// ── flush ──────────────────────────────────────────────────────────────

	public function test_flush_clears_all(): void {
		$cache = new LRU_Cache( 10, 3 );
		$cache->set( 'a', 1 );
		$cache->set( 'b', 2 );
		$cache->flush();

		$this->assertNull( $cache->get( 'a' ) );
		$this->assertNull( $cache->get( 'b' ) );
	}

	// ── Batch access ───────────────────────────────────────────────────────

	public function test_get_multi_returns_found_keys_only(): void {
		$cache = new LRU_Cache( 10, 3 );
		$cache->set( 'alpha', 'a-val' );
		$cache->set( 'gamma', 'g-val' );

		$found = $cache->get_multi( [ 'alpha', 'beta', 'gamma' ] );

		$this->assertSame( [ 'alpha' => 'a-val', 'gamma' => 'g-val' ], $found );
	}

	public function test_get_multi_keeps_a_stored_false(): void {
		// get() answers null for absent, so a found-only sweep that filtered on
		// null would drop a stored false — the shape a Table entry can hold.
		$cache = new LRU_Cache( 10, 3 );
		$cache->set( 'flag', false );

		$this->assertSame( [ 'flag' => false ], $cache->get_multi( [ 'flag', 'absent' ] ) );
	}

	public function test_set_multi_stores_every_item(): void {
		$cache = new LRU_Cache( 10, 3 );

		$cache->set_multi( [ 'one' => 11, 'two' => 22 ] );

		$this->assertSame( 11, $cache->get( 'one' ) );
		$this->assertSame( 22, $cache->get( 'two' ) );
	}

	// ── Promotion opt-out ──────────────────────────────────────────────────

	public function test_without_promotion_leaves_a_hit_in_its_original_bucket(): void {
		// bucket_size 1 so every set rotates; with promotion on, reading 'a'
		// would move it to the newest bucket and it would outlive 'b'.
		$cache = ( new LRU_Cache( 1, 3 ) )->without_promotion();
		$cache->set( 'a', 'first' );
		$cache->set( 'b', 'second' );

		$this->assertSame( 'first', $cache->get( 'a' ) );
		$cache->set( 'c', 'third' );

		$this->assertNull( $cache->get( 'a' ), 'a read must not extend an entry beyond its window' );
		$this->assertSame( 'third', $cache->get( 'c' ) );
	}

	public function test_promotion_is_on_by_default(): void {
		$cache = new LRU_Cache( 1, 3 );
		$cache->set( 'a', 'first' );
		$cache->set( 'b', 'second' );

		$this->assertSame( 'first', $cache->get( 'a' ) );
		$cache->set( 'c', 'third' );

		$this->assertSame( 'first', $cache->get( 'a' ), 'a working set keeps what it touches' );
	}

	public function test_get_multi_honours_the_promotion_setting(): void {
		$cache = ( new LRU_Cache( 1, 3 ) )->without_promotion();
		$cache->set( 'a', 'first' );
		$cache->set( 'b', 'second' );

		$this->assertSame( [ 'a' => 'first' ], $cache->get_multi( [ 'a' ] ) );
		$cache->set( 'c', 'third' );

		$this->assertSame( [], $cache->get_multi( [ 'a' ] ) );
	}

	// ── Combined behaviour ─────────────────────────────────────────────────

	public function test_large_number_of_items(): void {
		$cache = new LRU_Cache( 100, 5 );
		for ( $i = 0; $i < 600; $i++ ) {
			$cache->set( "key{$i}", $i );
		}

		// Recent items reachable.
		$this->assertSame( 599, $cache->get( 'key599' ) );
		// Old items evicted.
		$this->assertNull( $cache->get( 'key0' ) );
	}
}
