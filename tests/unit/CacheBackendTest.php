<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * The two-ordering tier resolver: local_first (APCu → memcached) for
 * same-host hot surfaces, shared_first (memcached → APCu) for
 * cross-process sources of truth. Each picks ONE live backend — a claim
 * must never straddle tiers. Null = nothing available (callers keep
 * their fail-closed behavior).
 */
#[CoversClass( Cache_Backend::class )]
class CacheBackendTest extends TestCase {
	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
	}

	protected function tearDown(): void {
		Core::$memd                 = $this->prev_memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		parent::tearDown();
	}

	public function test_orderings_pick_one_live_backend(): void {
		$memd       = new InMemoryMemcached();
		Core::$memd = $memd;

		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$this->assertNotNull( Cache_Backend::local_first(), 'no APCu: local_first falls back to memcached' );
		Cache_Backend::local_first()->add( 'k1', 1, 60 );
		$this->assertSame( 1, $memd->get( 'k1' ), 'the fallback really is the memcached handle' );

		$this->assertNotNull( Cache_Backend::shared_first() );

		Core::$memd = null;
		$this->assertNull( Cache_Backend::local_first(), 'nothing available: null, callers fail closed' );
		$this->assertNull( Cache_Backend::shared_first() );
	}

	public function test_memcached_ops_round_trip(): void {
		Core::$memd                 = new InMemoryMemcached();
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		$b                          = Cache_Backend::shared_first();

		$this->assertTrue( $b->add( 'claim', 1, 60 ) );
		$this->assertFalse( $b->add( 'claim', 1, 60 ), 'add is an atomic claim' );
		$this->assertTrue( $b->set( 'v', [ 'a' => 1 ], 60 ) );
		$this->assertSame( [ 'a' => 1 ], $b->get( 'v' ) );
		$this->assertTrue( $b->touch( 'v', 120 ) );
		$this->assertTrue( $b->delete( 'v' ) );
		$this->assertFalse( $b->get( 'v' ) );

		$b->set( 'n', 3, 60 );
		$this->assertSame( 4, $b->increment( 'n' ) );
		$this->assertSame( 3, $b->decrement( 'n' ) );
	}

	// --- Real APCu arms (skip where the SAPI has no usable segment) ----------

	private function apcu_backend( string $order ): Cache_Backend {
		if ( ! \function_exists( 'apcu_enabled' ) || ! \apcu_enabled() ) {
			$this->markTestSkipped( 'APCu not usable in this SAPI (needs apc.enable_cli=1)' );
		}
		Cache_Backend::$apcu_usable = null; // real check
		Core::$memd                 = null; // force the APCu arm in both orderings
		$b                          = 'local' === $order ? Cache_Backend::local_first() : Cache_Backend::shared_first();
		$this->assertNotNull( $b );
		\apcu_delete( [ 'claim', 'v', 'n' ] );
		return $b;
	}

	public function test_apcu_only_host_keeps_claim_surfaces_functional(): void {
		// The stock Atomic posture: APCu present, no memcached. Previously
		// fail-closed surfaces now work.
		if ( ! \function_exists( 'apcu_enabled' ) || ! \apcu_enabled() ) {
			$this->markTestSkipped( 'APCu not usable in this SAPI' );
		}
		Cache_Backend::$apcu_usable = null;
		Core::$memd                 = null;
		$tmp                        = $this->make_temp_dir( 'apcu-only-' );
		mkdir( "{$tmp}/locks", 0755, true );
		mkdir( "{$tmp}/logs", 0755, true );
		\apcu_delete( \Newspack_Nodes\Job_Intake::UNIQUE_KEY_PREFIX . 'apcu_h:solo' );

		$intake = new \Newspack_Nodes\Job_Intake( $tmp, 1 );
		try {
			$this->assertTrue( $intake->write_job( 'apcu_h', [], null, null, [ 'unique' => 'solo', 'unique_ttl' => 60 ] ) );
			$this->assertFalse( $intake->write_job( 'apcu_h', [], null, null, [ 'unique' => 'solo', 'unique_ttl' => 60 ] ), 'the dedup window holds on APCu alone' );
		} finally {
			$intake->close();
			$this->rmdir_recursive( $tmp );
		}
	}

	public function test_apcu_ops_round_trip(): void {
		$b = $this->apcu_backend( 'local' );

		$this->assertTrue( $b->add( 'claim', 1, 60 ) );
		$this->assertFalse( $b->add( 'claim', 1, 60 ), 'apcu_add is the same atomic claim' );
		$this->assertTrue( $b->set( 'v', [ 'a' => 1 ], 60 ) );
		$this->assertSame( [ 'a' => 1 ], $b->get( 'v' ) );
		$this->assertTrue( $b->touch( 'v', 120 ) );
		$this->assertTrue( $b->delete( 'v' ) );
		$this->assertFalse( $b->get( 'v' ) );
	}

	public function test_apcu_counters_clamp_at_zero_like_memcached(): void {
		$b = $this->apcu_backend( 'shared' );

		$b->set( 'n', 1, 60 );
		$this->assertSame( 2, $b->increment( 'n' ) );
		$this->assertSame( 1, $b->decrement( 'n' ) );
		$this->assertSame( 0, $b->decrement( 'n' ) );
		$this->assertSame( 0, $b->decrement( 'n' ), 'memcached clamps decrement at zero; the APCu arm must match' );
	}
}
