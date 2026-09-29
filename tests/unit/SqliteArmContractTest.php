<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Durable_Arm;
use Newspack_Nodes\Sqlite_Arm;
use Newspack_Nodes\Tests\Helpers\DurableArmContract;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Sqlite_Arm::class )]
#[CoversClass( Cache_Backend::class )]
#[CoversClass( Durable_Arm::class )]
final class SqliteArmContractTest extends DurableArmContract {
	private string $dir = '';
	private ?Sqlite_Arm $arm = null;

	protected function setUp(): void {
		parent::setUp();
		$this->dir = $this->make_temp_dir( 'sqlite-arm-' );
	}

	protected function tearDown(): void {
		$this->arm = null;
		$this->rmdir_recursive( $this->dir );
		parent::tearDown();
	}

	protected function arm(): Cache_Backend {
		return $this->arm ??= new Sqlite_Arm( "{$this->dir}/tables/lab-7:kea.p3.sqlite" );
	}

	protected function batches_atomically(): bool {
		return true;
	}
}
