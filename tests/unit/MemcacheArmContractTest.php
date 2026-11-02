<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Memcache_Arm;
use Newspack_Nodes\Tests\Helpers\CacheBackendContract;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Memcache_Arm::class )]
#[CoversClass( Cache_Backend::class )]
final class MemcacheArmContractTest extends CacheBackendContract {
	protected function setUp(): void {
		parent::setUp();
		$memd        = new InMemoryMemcached();
		$memd->clock = fn (): int => (int) $this->clock;
		Core::$memd                 = $memd;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
	}

	protected function arm(): Cache_Backend {
		return Cache_Backend::memcache_arm() ?? self::fail( 'no memcache arm' );
	}

	/** A long TTL is dated from the tick's clock, and a cache write never moves that clock. */
	public function test_a_long_ttl_reads_the_ticks_clock_without_moving_it(): void {
		$memd       = Core::$memd;
		$this->assertInstanceOf( InMemoryMemcached::class, $memd );
		Core::$now  = self::T0 + 123.0;
		$this->clock = self::T0 + 9999;

		$this->arm()->set( 'kea-pinned', 'v-7712', 365 * DAY_IN_SECONDS );

		$this->assertSame( self::T0 + 123.0, Core::$now );
		$this->assertSame( [ self::T0 + 123 + 365 * DAY_IN_SECONDS ], \array_values( $memd->expiries() ) );
	}
}
