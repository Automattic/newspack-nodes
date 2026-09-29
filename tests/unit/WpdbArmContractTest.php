<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Durable_Arm;
use Newspack_Nodes\Tests\Helpers\DurableArmContract;
use Newspack_Nodes\Tests\Helpers\Sqlite_Wpdb;
use Newspack_Nodes\Wpdb_Arm;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Wpdb_Arm::class )]
#[CoversClass( Durable_Arm::class )]
final class WpdbArmContractTest extends DurableArmContract {
	private mixed $prev_wpdb = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_wpdb = $GLOBALS['wpdb'];
		$GLOBALS['wpdb'] = new Sqlite_Wpdb();
	}

	protected function tearDown(): void {
		$GLOBALS['wpdb'] = $this->prev_wpdb;
		parent::tearDown();
	}

	protected function arm(): Cache_Backend {
		return new Wpdb_Arm( 'kea:p3' );
	}
}
