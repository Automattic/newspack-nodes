<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\CLI;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Base;

class A5RoundTripTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_full_lifecycle_acquire_topology_message_release(): void {
		$w = new Worker_Base( $this->tmp, 'integration-test', 0 );
		$this->assertTrue( $w->acquire() );

		$interpreter = $w->build_scaffolding();

		$topology = function ( $interpreter, int $partition ) {
			$interpreter->dispatch( 'make_node', 'Capture_Sink target' );
		};
		$w->run_topology( $topology, $interpreter );

		// Send a message through _router → target.
		$router = Core::node( '_router' );
		$message = Message::new_message();
		$message[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$message[ Message::TO ]   = 'target';
		$message[ Message::VALUE ] = 'lifecycle-data';
		$router->fill( $message );

		$target = Core::node( 'target' );
		$this->assertCount( 1, $target->captured );
		$this->assertSame( 'lifecycle-data', $target->captured[0][ Message::VALUE ] );

		// Cli can list us as a live worker.
		$cli = new CLI( $this->tmp );
		$workers = $cli->ls_workers();
		$this->assertCount( 1, $workers );
		$this->assertSame( 'integration-test', $workers[0]['type'] );
		$this->assertFalse( $workers[0]['stale'] );

		$w->release();

		// After release, cli sees no workers.
		$workers = $cli->ls_workers();
		$this->assertCount( 0, $workers );
	}
}
