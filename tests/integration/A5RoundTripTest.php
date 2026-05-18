<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Cli;
use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\WorkerBase;

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
		$w = new WorkerBase( $this->tmp, 'integration-test', 0 );
		$this->assertTrue( $w->acquire() );

		$ci = $w->build_scaffolding();

		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
		$topology = function ( $ci, int $partition ) {
			$ci->dispatch( 'make_node', 'CaptureSink target' );
		};
		$w->run_topology( $topology, $ci );

		// Send a message through _router → target.
		$router = Core::node( '_router' );
		$msg = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$msg[ Message::TO ]   = 'target';
		$msg[ Message::VALUE ] = 'lifecycle-data';
		$router->fill( $msg );

		$target = Core::node( 'target' );
		$this->assertCount( 1, $target->captured );
		$this->assertSame( 'lifecycle-data', $target->captured[0][ Message::VALUE ] );

		// Cli can list us as a live worker.
		$cli = new Cli( $this->tmp );
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
