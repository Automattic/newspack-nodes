<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Apcu_Arm;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Tests\Helpers\CacheBackendContract;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Apcu_Arm::class )]
#[CoversClass( Cache_Backend::class )]
final class ApcuArmContractTest extends CacheBackendContract {
	protected function setUp(): void {
		parent::setUp();
		Cache_Backend::$apcu_usable = static fn (): bool => true;
		\apcu_clear_cache();
	}

	protected function tearDown(): void {
		\apcu_clear_cache();
		parent::tearDown();
	}

	protected function arm(): Cache_Backend {
		return Cache_Backend::apcu_arm() ?? self::fail( 'no APCu arm' );
	}

	protected function moves_clock(): bool {
		return false;
	}
}
