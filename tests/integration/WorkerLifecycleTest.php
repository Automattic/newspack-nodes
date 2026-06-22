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

		$topology = function ( $interpreter, int $partition ) {
			$interpreter->dispatch( 'make_node', 'Capture_Sink echo' );
		};
		$w->run_topology( $topology, $interpreter );

		$this->assertNotNull( Core::node( 'echo' ) );

		$w->release();
	}

	public function test_execute_treats_worker_should_stop_as_a_clean_stop(): void {
		// execute() must treat a Worker_Should_Stop from the drain as a clean stop, not a crash.
		// max_runtime=5 is a backstop so a missed timer can't hang the suite.
		$w = new Worker_Base( $this->tmp, 'stop-test', 0, 5 );

		$topology = function ( $interpreter, int $partition ) {
			$timer = new class extends \Newspack_Nodes\Timer_Node {
				public function fire_cb(): void {
					throw new \Newspack_Nodes\Worker_Should_Stop();
				}
			};
			$timer->name( '_stop_timer' );
			$timer->set_timer( 1, true );
		};

		$result = $w->execute( $topology, '', '' );

		$this->assertSame( 'ok', $result['status'] );
		$this->assertFalse(
			\is_dir( "{$this->tmp}/locks/stop-test.p0.lock.d" ),
			'execute() released the lock during cooperative-stop teardown'
		);
	}
}
