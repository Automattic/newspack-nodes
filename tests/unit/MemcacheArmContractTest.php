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
}
