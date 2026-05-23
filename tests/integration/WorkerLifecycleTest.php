<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Base;

class WorkerLifecycleTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_acquire_build_scaffolding_run_topology(): void {
		$w = new Worker_Base( $this->tmp, 'echo-test', 0 );
		$this->assertTrue( $w->acquire() );

		$interpreter = $w->build_scaffolding();

		$topology = function ( $ci, int $partition ) {
			$ci->dispatch( 'make_node', 'Capture_Sink echo' );
		};
		$w->run_topology( $topology, $interpreter );

		$this->assertNotNull( Core::node( 'echo' ) );

		$w->release();
	}
}
