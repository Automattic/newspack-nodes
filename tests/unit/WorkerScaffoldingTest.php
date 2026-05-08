<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Callback;
use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Core;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Responder;
use Newspack_Nodes\Router;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\WorkerBase;

class WorkerScaffoldingTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_build_scaffolding_creates_router_and_interpreter(): void {
		$w = new WorkerBase( $this->tmp, 'test', 0 );
		$ci = $w->build_scaffolding();
		$this->assertSame( $ci, Core::node( '_command_interpreter' ) );
		$this->assertNotNull( Core::node( '_router' ) );
	}

	public function test_build_scaffolding_creates_responder(): void {
		$w = new WorkerBase( $this->tmp, 'test', 0 );
		$w->build_scaffolding();
		$resp = Core::node( '_responder' );
		$this->assertInstanceOf( Responder::class, $resp );
	}

	public function test_build_scaffolding_creates_repl_routable(): void {
		// `_repl` is now a Callback wrapper that packs non-TM_BYTESTREAM
		// messages before forwarding to the underlying anonymous output
		// Partition. Anything addressed to TO=`_repl` (e.g. by _router after
		// peeling) lands here and gets serialized to disk.
		$w = new WorkerBase( $this->tmp, 'test', 0 );
		$w->build_scaffolding();
		$repl = Core::node( '_repl' );
		$this->assertNotNull( $repl );
		$this->assertInstanceOf( Callback::class, $repl );
	}

	public function test_interpreter_sinks_into_router(): void {
		$w = new WorkerBase( $this->tmp, 'test', 0 );
		$ci = $w->build_scaffolding();
		$this->assertSame( Core::node( '_router' ), $ci->sink() );
	}
}
