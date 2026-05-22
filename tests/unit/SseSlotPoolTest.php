<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Rest\SSE_Out;
use Newspack_Nodes\Sse_Slot_Pool;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Substrate SSE slot pool: the slot algorithm + SSE_Out seam wiring,
 * keyed directly off the shared `Core::$memd` handle.
 *
 * The pool owns the atomic add()-loop slot claim against `Core::$memd`.
 * Tests set `Core::$memd` to an in-memory `\Memcached` subclass so the
 * algorithm runs deterministically.
 */
#[CoversClass( Sse_Slot_Pool::class )]
class SseSlotPoolTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		SSE_Out::$acquire_slot = null;
		SSE_Out::$release_slot = null;
		SSE_Out::$check_slot   = null;
		Sse_Slot_Pool::$max_slots      = 8;
		Sse_Slot_Pool::$ttl_browser    = 30;
		Sse_Slot_Pool::$ttl_aggregator = 60;
		Core::$memd = new InMemoryMemcached();
	}

	protected function tearDown(): void {
		SSE_Out::$acquire_slot = null;
		SSE_Out::$release_slot = null;
		SSE_Out::$check_slot   = null;
		Core::$memd = null;
		parent::tearDown();
	}

	// ── slot algorithm (direct) ──────────────────────────────────────────────

	public function test_acquire_returns_first_free_slot(): void {
		$this->assertSame( 0, Sse_Slot_Pool::acquire( 1, 'abc', 8, 30, -1 ) );
		$this->assertSame( 1, Sse_Slot_Pool::acquire( 1, 'abc', 8, 30, -1 ) );
	}

	public function test_acquire_returns_false_when_pool_exhausted(): void {
		$this->assertSame( 0, Sse_Slot_Pool::acquire( 1, 'abc', 2, 30, -1 ) );
		$this->assertSame( 1, Sse_Slot_Pool::acquire( 1, 'abc', 2, 30, -1 ) );
		$this->assertFalse( Sse_Slot_Pool::acquire( 1, 'abc', 2, 30, -1 ) );
	}

	public function test_release_frees_the_slot_for_reacquire(): void {
		$slot = Sse_Slot_Pool::acquire( 1, 'abc', 8, 30, -1 );
		$this->assertSame( 0, $slot );
		$this->assertTrue( Sse_Slot_Pool::release( 1, 'abc', $slot, -1 ) );
		$this->assertSame( 0, Sse_Slot_Pool::acquire( 1, 'abc', 8, 30, -1 ) );
	}

	public function test_check_true_for_held_slot_false_for_free(): void {
		$slot = Sse_Slot_Pool::acquire( 1, 'abc', 8, 30, -1 );
		$this->assertTrue( Sse_Slot_Pool::check( 1, 'abc', $slot, -1 ) );
		$this->assertFalse( Sse_Slot_Pool::check( 1, 'abc', 5, -1 ) );
	}

	public function test_touch_returns_true_for_held_slot_false_for_missing(): void {
		$slot = Sse_Slot_Pool::acquire( 1, 'abc', 8, 30, -1 );
		$this->assertTrue( Sse_Slot_Pool::touch( 1, 'abc', $slot, 30, -1 ) );
		$this->assertFalse( Sse_Slot_Pool::touch( 1, 'abc', 5, 30, -1 ) );
	}

	public function test_partition_scopes_slot_keys_independently(): void {
		// A shared-pool (-1) claim must not collide with a per-partition claim.
		$this->assertSame( 0, Sse_Slot_Pool::acquire( 1, 'abc', 1, 30, -1 ) );
		$this->assertFalse( Sse_Slot_Pool::acquire( 1, 'abc', 1, 30, -1 ) );
		$this->assertSame( 0, Sse_Slot_Pool::acquire( 1, 'abc', 1, 30, 3 ) );
	}

	// ── fail-closed when Core::$memd is null ─────────────────────────────────

	public function test_acquire_fails_closed_when_memd_null(): void {
		Core::$memd = null;
		$this->assertFalse( Sse_Slot_Pool::acquire( 1, 'abc', 8, 30, -1 ) );
	}

	public function test_check_fails_closed_when_memd_null(): void {
		Core::$memd = null;
		$this->assertFalse( Sse_Slot_Pool::check( 1, 'abc', 0, -1 ) );
	}

	public function test_release_fails_open_when_memd_null(): void {
		Core::$memd = null;
		$this->assertTrue( Sse_Slot_Pool::release( 1, 'abc', 0, -1 ) );
	}

	public function test_touch_fails_open_when_memd_null(): void {
		Core::$memd = null;
		$this->assertTrue( Sse_Slot_Pool::touch( 1, 'abc', 0, 30, -1 ) );
	}

	// ── wire() installs the SSE_Out seams ────────────────────────────────────

	public function test_wire_populates_all_three_seams(): void {
		$this->assertNull( SSE_Out::$acquire_slot );
		$this->assertNull( SSE_Out::$release_slot );
		$this->assertNull( SSE_Out::$check_slot );

		Sse_Slot_Pool::wire();

		$this->assertInstanceOf( \Closure::class, SSE_Out::$acquire_slot );
		$this->assertInstanceOf( \Closure::class, SSE_Out::$release_slot );
		$this->assertInstanceOf( \Closure::class, SSE_Out::$check_slot );
	}

	public function test_wired_acquire_claims_a_slot(): void {
		Sse_Slot_Pool::wire();
		$acquire = SSE_Out::$acquire_slot;
		$this->assertSame( 0, $acquire( -1 ) );
	}

	public function test_wired_release_returns_slot_to_pool(): void {
		Sse_Slot_Pool::wire();
		$acquire = SSE_Out::$acquire_slot;
		$release = SSE_Out::$release_slot;

		$slot = $acquire( -1 );
		$this->assertSame( 0, $slot );
		$release( $slot, -1 );
		$this->assertSame( 0, $acquire( -1 ) );
	}

	public function test_wired_check_returns_true_for_held_slot(): void {
		Sse_Slot_Pool::wire();
		$acquire = SSE_Out::$acquire_slot;
		$check   = SSE_Out::$check_slot;

		$slot = $acquire( -1 );
		$this->assertTrue( $check( $slot, -1 ) );
	}

	public function test_wired_acquire_returns_false_when_pool_exhausted(): void {
		Sse_Slot_Pool::$max_slots = 2;
		Sse_Slot_Pool::wire();
		$acquire = SSE_Out::$acquire_slot;

		$this->assertNotFalse( $acquire( -1 ) );
		$this->assertNotFalse( $acquire( -1 ) );
		$this->assertFalse( $acquire( -1 ) );
	}

	public function test_wired_acquire_uses_aggregator_ttl_for_partition_pool(): void {
		// Per-partition (>= 0) pools use the longer aggregator TTL; the shared
		// browser pool (-1) uses the shorter browser TTL. We can't read the TTL
		// back through \Memcached, so assert the two pools are independent and
		// both claim slot 0 (proving the partition arg threads through wire()).
		Sse_Slot_Pool::wire();
		$acquire = SSE_Out::$acquire_slot;
		$this->assertSame( 0, $acquire( -1 ) );
		$this->assertSame( 0, $acquire( 5 ) );
	}
}
