<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Base;

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
		$w = new Worker_Base( $this->tmp, 'test', 0 );
		$ci = $w->build_scaffolding();
		$this->assertSame( $ci, Core::node( '_command_interpreter' ) );
		$this->assertNotNull( Core::node( '_router' ) );
	}

	public function test_build_scaffolding_installs_command_verifier(): void {
		// The worker process must verify command provenance; an unsigned IPC
		// command is refused, a signed one runs.
		Command_Interpreter_Node::register_class( 'CaptureSink', \Newspack_Nodes\Tests\CaptureSink::class );
		$w  = new Worker_Base( $this->tmp, 'test', 0 );
		$ci = $w->build_scaffolding();
		$this->assertNotNull( Command_Interpreter_Node::$default_authorize );

		// Unsigned command (no LOCAL, no auth) — refused.
		$unsigned                   = \Newspack_Nodes\Message::new_message();
		$unsigned[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND;
		$unsigned[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => 'CaptureSink unsigned' ];
		$ci->fill( $unsigned );
		$this->assertNull( Core::node( 'unsigned' ), 'unsigned command must be refused by the worker verifier' );

		// Signed command, round-tripped through the IPC wire (packed/unpacked) so
		// this proves the {name,arguments,payload,auth} struct survives JSON and
		// the worker recomputes the same canonical — runs.
		$signed                   = \Newspack_Nodes\Message::new_message();
		$signed[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND;
		$signed[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => 'CaptureSink signed', 'payload' => '' ];
		\Newspack_Nodes\Command_Auth::sign( $signed );
		$wire = \Newspack_Nodes\Message::unpacked( \Newspack_Nodes\Message::packed( $signed ) );
		$ci->fill( $wire );
		$this->assertInstanceOf( \Newspack_Nodes\Tests\CaptureSink::class, Core::node( 'signed' ) );
	}

	public function test_worker_verifier_accepts_in_process_local_command(): void {
		// A worker loads its topology IN-PROCESS via Shell::eval_script, which mints
		// commands tainted with LOCAL but NOT HMAC-signed. LOCAL can't cross IPC
		// (packed strips index 7; unpacked rejects 8-field lines), so the verifier
		// must still trust LOCAL-tainted in-process commands — otherwise the worker
		// refuses its own topology and boots with an empty graph.
		Command_Interpreter_Node::register_class( 'CaptureSink', \Newspack_Nodes\Tests\CaptureSink::class );
		$w  = new Worker_Base( $this->tmp, 'test', 0 );
		$ci = $w->build_scaffolding();

		$local                   = \Newspack_Nodes\Message::new_message();
		$local[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND;
		$local[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => 'CaptureSink topo', 'payload' => '' ];
		$local[ \Newspack_Nodes\Message::LOCAL ] = true;
		$ci->fill( $local );

		$this->assertInstanceOf( \Newspack_Nodes\Tests\CaptureSink::class, Core::node( 'topo' ), 'worker must accept its own LOCAL topology commands' );
	}

	public function test_build_scaffolding_creates_repl_routable(): void {
		// `_repl` IS the output Partition (matches real Tachikoma — Partition::fill
		// auto-packs any non-control message via Message::packed). Anything
		// addressed to TO=`_repl` after _router peels lands here and gets
		// serialized to disk.
		$w = new Worker_Base( $this->tmp, 'test', 0 );
		$w->build_scaffolding();
		$repl = Core::node( '_repl' );
		$this->assertNotNull( $repl );
		$this->assertInstanceOf( Partition_Node::class, $repl );
	}

	public function test_interpreter_sinks_into_router(): void {
		$w = new Worker_Base( $this->tmp, 'test', 0 );
		$ci = $w->build_scaffolding();
		$this->assertSame( Core::node( '_router' ), $ci->sink() );
	}
}
