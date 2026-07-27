<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\SSE_Slot_Pool;
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
#[CoversClass( SSE_Slot_Pool::class )]
class SseSlotPoolTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		SSE_Out_Node::$acquire_slot = null;
		SSE_Out_Node::$release_slot = null;
		SSE_Out_Node::$check_slot   = null;
		SSE_Slot_Pool::$max_slots   = 10;
		SSE_Slot_Pool::$ttl         = 60;
		Core::$memd = new InMemoryMemcached();
	}

	protected function tearDown(): void {
		SSE_Out_Node::$acquire_slot = null;
		SSE_Out_Node::$release_slot = null;
		SSE_Out_Node::$check_slot   = null;
		Core::$memd = null;
		parent::tearDown();
	}

	/**
	 * The slot must outlive the client's session-forget threshold, or the moment
	 * a client starts re-authenticating is the moment its slot lapses — and the
	 * keepalive is gated on having a session, so it cannot refresh during re-auth.
	 * Read off the DECLARED default; setUp's fixture value must not mask it.
	 */
	public function test_default_ttl_outlives_the_client_session_forget_threshold(): void {
		$declared = ( new \ReflectionClass( SSE_Slot_Pool::class ) )->getDefaultProperties()['ttl'];
		$forget   = \Newspack_Nodes\Remote_Link_Node::HEARTBEAT_INTERVAL * 3;

		$this->assertGreaterThan(
			$forget,
			$declared,
			'slot TTL must leave room for a re-auth round trip'
		);
	}

	/**
	 * The heartbeat verb must apply the SERVER's TTL. It used to take the TTL
	 * from the client's own argument, so a client could name any lifetime it
	 * liked — and the 10s-cadence heartbeat re-touched the slot down to 30s,
	 * quietly undoing the pool's 60s default a few seconds after acquire.
	 */
	public function test_heartbeat_applies_the_server_ttl_not_the_client_argument(): void {
		$slot = SSE_Slot_Pool::acquire( SSE_Slot_Pool::hostname(), SSE_Slot_Pool::user_id(), SSE_Slot_Pool::ip_hash(), 4, 5 );
		$this->assertIsInt( $slot );

		// The client asks for 30; the server's own default is 60.
		\Newspack_Nodes\Rest\Workers_CI_Node::cmd_heartbeat( [ (string) $slot, '30' ] );

		$expiries = \array_values( Core::$memd->expiries() );
		$this->assertCount( 1, $expiries );
		$this->assertGreaterThan(
			\time() + 30,
			$expiries[0],
			'the client-supplied TTL must not shorten the slot'
		);
	}

	// ── slot algorithm (direct) ──────────────────────────────────────────────

	public function test_acquire_returns_first_free_slot(): void {
		$this->assertSame( 0, SSE_Slot_Pool::acquire( 'host', 1, 'abc', 8, 30 ) );
		$this->assertSame( 1, SSE_Slot_Pool::acquire( 'host', 1, 'abc', 8, 30 ) );
	}

	public function test_acquire_returns_false_when_pool_exhausted(): void {
		$this->assertSame( 0, SSE_Slot_Pool::acquire( 'host', 1, 'abc', 2, 30 ) );
		$this->assertSame( 1, SSE_Slot_Pool::acquire( 'host', 1, 'abc', 2, 30 ) );
		$this->assertFalse( SSE_Slot_Pool::acquire( 'host', 1, 'abc', 2, 30 ) );
	}

	public function test_slot_keys_use_the_substrate_prefix(): void {
		// The pool is substrate infrastructure; its keys must live in the
		// newspack_nodes namespace, not a consumer application's.
		SSE_Slot_Pool::acquire( 'host', 1, 'abc', 1, 30 );
		/** @var InMemoryMemcached $memd */
		$memd = Core::$memd;
		$this->assertSame( [ 'newspack_nodes:sse:host:1:abc:0' ], $memd->keys() );
	}

	public function test_slots_are_namespaced_per_hostname(): void {
		// Same user + ip on two hosts get independent pools (shared memcache).
		$this->assertSame( 0, SSE_Slot_Pool::acquire( 'hostA', 1, 'abc', 1, 30 ) );
		$this->assertFalse( SSE_Slot_Pool::acquire( 'hostA', 1, 'abc', 1, 30 ) );
		$this->assertSame( 0, SSE_Slot_Pool::acquire( 'hostB', 1, 'abc', 1, 30 ) );
	}

	public function test_hostname_is_always_a_non_empty_string(): void {
		// The `?: 'unknown'` fallback guarantees a gethostname() failure can never
		// pass false to the string-typed slot methods.
		$host = SSE_Slot_Pool::hostname();
		$this->assertIsString( $host );
		$this->assertNotSame( '', $host );
	}

	public function test_release_frees_the_slot_for_reacquire(): void {
		$slot = SSE_Slot_Pool::acquire( 'host', 1, 'abc', 8, 30 );
		$this->assertSame( 0, $slot );
		$this->assertTrue( SSE_Slot_Pool::release( 'host', 1, 'abc', $slot ) );
		$this->assertSame( 0, SSE_Slot_Pool::acquire( 'host', 1, 'abc', 8, 30 ) );
	}

	public function test_check_true_for_held_slot_false_for_free(): void {
		$slot = SSE_Slot_Pool::acquire( 'host', 1, 'abc', 8, 30 );
		$this->assertTrue( SSE_Slot_Pool::check( 'host', 1, 'abc', $slot ) );
		$this->assertFalse( SSE_Slot_Pool::check( 'host', 1, 'abc', 5 ) );
	}

	public function test_touch_returns_true_for_held_slot_false_for_missing(): void {
		$slot = SSE_Slot_Pool::acquire( 'host', 1, 'abc', 8, 30 );
		$this->assertTrue( SSE_Slot_Pool::touch( 'host', 1, 'abc', $slot, 30 ) );
		$this->assertFalse( SSE_Slot_Pool::touch( 'host', 1, 'abc', 5, 30 ) );
	}

	// ── fail-closed when Core::$memd is null ─────────────────────────────────

	public function test_acquire_fails_closed_when_memd_null(): void {
		Core::$memd = null;
		$this->assertFalse( SSE_Slot_Pool::acquire( 'host', 1, 'abc', 8, 30 ) );
	}

	public function test_check_fails_closed_when_memd_null(): void {
		Core::$memd = null;
		$this->assertFalse( SSE_Slot_Pool::check( 'host', 1, 'abc', 0 ) );
	}

	public function test_release_fails_open_when_memd_null(): void {
		Core::$memd = null;
		$this->assertTrue( SSE_Slot_Pool::release( 'host', 1, 'abc', 0 ) );
	}

	public function test_touch_fails_open_when_memd_null(): void {
		Core::$memd = null;
		$this->assertTrue( SSE_Slot_Pool::touch( 'host', 1, 'abc', 0, 30 ) );
	}

	// ── wire() installs the SSE_Out seams ────────────────────────────────────

	public function test_wire_populates_all_three_seams(): void {
		$this->assertNull( SSE_Out_Node::$acquire_slot );
		$this->assertNull( SSE_Out_Node::$release_slot );
		$this->assertNull( SSE_Out_Node::$check_slot );

		SSE_Slot_Pool::wire();

		$this->assertInstanceOf( \Closure::class, SSE_Out_Node::$acquire_slot );
		$this->assertInstanceOf( \Closure::class, SSE_Out_Node::$release_slot );
		$this->assertInstanceOf( \Closure::class, SSE_Out_Node::$check_slot );
	}

	public function test_wired_acquire_claims_a_slot(): void {
		SSE_Slot_Pool::wire();
		$acquire = SSE_Out_Node::$acquire_slot;
		$this->assertSame( 0, $acquire() );
	}

	public function test_wired_release_returns_slot_to_pool(): void {
		SSE_Slot_Pool::wire();
		$acquire = SSE_Out_Node::$acquire_slot;
		$release = SSE_Out_Node::$release_slot;

		$slot = $acquire();
		$this->assertSame( 0, $slot );
		$release( $slot );
		$this->assertSame( 0, $acquire() );
	}

	public function test_wired_check_returns_true_for_held_slot(): void {
		SSE_Slot_Pool::wire();
		$acquire = SSE_Out_Node::$acquire_slot;
		$check   = SSE_Out_Node::$check_slot;

		$slot = $acquire();
		$this->assertTrue( $check( $slot ) );
	}

	public function test_wired_acquire_returns_false_when_pool_exhausted(): void {
		SSE_Slot_Pool::$max_slots = 2;
		SSE_Slot_Pool::wire();
		$acquire = SSE_Out_Node::$acquire_slot;

		$this->assertNotFalse( $acquire() );
		$this->assertNotFalse( $acquire() );
		$this->assertFalse( $acquire() );
	}
}
