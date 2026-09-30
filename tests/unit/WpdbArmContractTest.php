<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Durable_Arm;
use Newspack_Nodes\Tests\Helpers\DurableArmContract;
use Newspack_Nodes\Wpdb_Arm;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Wpdb_Arm::class )]
#[CoversClass( Durable_Arm::class )]
final class WpdbArmContractTest extends DurableArmContract {
	protected function setUp(): void {
		parent::setUp();
		$this->use_wpdb();
	}

	protected function arm(): Cache_Backend {
		return new Wpdb_Arm( 'kea:p3' );
	}
}
