<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Consumer_Node;
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
		$interpreter = $w->build_scaffolding();
		$this->assertSame( $interpreter, Core::node( '_command_interpreter' ) );
		$this->assertNotNull( Core::node( '_router' ) );
	}

	public function test_ipc_input_consumer_resumes_from_prior_offsetlog(): void {
		// Durable IPC-input offsetlog: a prior worker checkpointed its read offset;
		// the respawned worker resumes from it, so commands queued during the
		// ~10-min restart aren't dropped (the live console keeps getting replies).
		$ipc_dir = "{$this->tmp}/ipc/test.p0";
		\mkdir( "{$ipc_dir}/input", 0755, true );
		$seed = new Consumer_Node();
		$seed->arguments( "{$ipc_dir}/input {$ipc_dir}/input.offsets" );
		$seed->checkpoint();
		unset( $seed );

		$w  = new Worker_Base( $this->tmp, 'test', 0 );
		$in = $w->build_ipc_input_consumer( $ipc_dir );
		// has_checkpoint is meaningful only after the first poll seeds the cursor
		// from the offsetlog (construction does no I/O).
		$in->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$in->poll();

		$this->assertTrue( $in->has_checkpoint(), 'respawn must resume from the durable IPC-input offsetlog' );
	}

	public function test_ipc_input_consumer_first_spawn_skips_preexisting_commands(): void {
		// First spawn (no checkpoint) tail-seeks to end so it does not replay the
		// input partition's retained command history.
		$ipc_dir = "{$this->tmp}/ipc/test.p0";
		$input = new Partition_Node();
		$input->arguments( "{$ipc_dir}/input" );
		$msg                                  = \Newspack_Nodes\Message::new_message();
		$msg[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$msg[ \Newspack_Nodes\Message::VALUE ] = "old-command\n";
		$input->fill( $msg );

		$w   = new Worker_Base( $this->tmp, 'test', 0 );
		$in  = $w->build_ipc_input_consumer( $ipc_dir );
		$cap = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$in->sink( $cap );
		$in->poll();

		$this->assertEmpty( $cap->captured, 'first spawn must not replay pre-existing IPC input' );
	}

	public function test_ipc_output_partition_uses_1mb_segment_size(): void {
		// All IPC logs (input + output) use a 1 MiB segment_size.
		$w = new Worker_Base( $this->tmp, 'test', 0 );
		$w->build_scaffolding();
		$parts = \explode( ' ', Core::node( '_repl' )->arguments() );
		$this->assertSame( (string) ( 1024 * 1024 ), $parts[1], 'IPC output Partition segment_size must be 1 MiB' );
	}

	private function write_ipc_line( Partition_Node $partition, string $value ): void {
		$msg                                  = \Newspack_Nodes\Message::new_message();
		$msg[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$msg[ \Newspack_Nodes\Message::VALUE ] = $value;
		$partition->fill( $msg );
		$partition->flush();
	}

	public function test_checkpoint_ipc_input_persists_consumed_offset(): void {
		// A clean recycle checkpoints the IPC input: a command consumed before
		// shutdown is NOT replayed on respawn, while one that arrived during the
		// downtime IS delivered. (Without the shutdown checkpoint, the respawn's
		// tail-seek would skip both.)
		$ipc_dir = "{$this->tmp}/ipc/ckpt.p0";
		\mkdir( "{$ipc_dir}/input", 0755, true );
		$w  = new Worker_Base( $this->tmp, 'ckpt', 0 );
		$in = $w->build_ipc_input_consumer( $ipc_dir );
		$in->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );

		$input = new Partition_Node();

		$input->arguments( "{$ipc_dir}/input" );
		$this->write_ipc_line( $input, 'cmd1' );
		$this->pump_consumer( $in );   // consume cmd1 before the recycle
		$w->checkpoint_ipc_input();    // clean-recycle shutdown checkpoint

		$this->write_ipc_line( $input, 'cmd2' );   // queued during the downtime

		$in2 = ( new Worker_Base( $this->tmp, 'ckpt', 0 ) )->build_ipc_input_consumer( $ipc_dir );
		$cap = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$in2->sink( $cap );
		$this->pump_consumer( $in2 );

		$this->assertCount( 1, $cap->captured, 'respawn delivers the queued command, not the already-consumed one' );
		$this->assertSame( 'cmd2', $cap->captured[0][ \Newspack_Nodes\Message::VALUE ] );
	}

	public function test_build_scaffolding_installs_command_verifier(): void {
		// The worker process must verify command provenance; an unsigned IPC
		// command is refused, a signed one runs.
		$w  = new Worker_Base( $this->tmp, 'test', 0 );
		$interpreter = $w->build_scaffolding();
		$this->assertNotNull( Command_Interpreter_Node::$default_authorize );

		// Unsigned command (no LOCAL, no auth) — refused.
		$unsigned                   = \Newspack_Nodes\Message::new_message();
		$unsigned[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND;
		$unsigned[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => 'Capture_Sink unsigned' ];
		$interpreter->fill( $unsigned );
		$this->assertNull( Core::node( 'unsigned' ), 'unsigned command must be refused by the worker verifier' );

		// Signed command, round-tripped through the IPC wire (packed/unpacked) so
		// this proves the {name,arguments,payload,auth} struct survives JSON and
		// the worker recomputes the same canonical — runs.
		$signed                   = \Newspack_Nodes\Message::new_message();
		$signed[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND;
		$signed[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => 'Capture_Sink signed', 'payload' => '' ];
		\Newspack_Nodes\Command_Auth::sign( $signed );
		$wire = \Newspack_Nodes\Message::unpacked( \Newspack_Nodes\Message::packed( $signed ) );
		$interpreter->fill( $wire );
		$this->assertInstanceOf( \Newspack_Nodes\Tests\Capture_Sink_Node::class, Core::node( 'signed' ) );
	}

	public function test_worker_verifier_accepts_in_process_local_command(): void {
		// A worker loads its topology IN-PROCESS via Shell::eval_script, which mints
		// commands tainted with LOCAL but NOT HMAC-signed. LOCAL can't cross IPC
		// (packed strips index 7; unpacked rejects 8-field lines), so the verifier
		// must still trust LOCAL-tainted in-process commands — otherwise the worker
		// refuses its own topology and boots with an empty graph.
		$w  = new Worker_Base( $this->tmp, 'test', 0 );
		$interpreter = $w->build_scaffolding();

		$local                   = \Newspack_Nodes\Message::new_message();
		$local[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_COMMAND;
		$local[ \Newspack_Nodes\Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => 'Capture_Sink topo', 'payload' => '' ];
		$local[ \Newspack_Nodes\Message::LOCAL ] = true;
		$interpreter->fill( $local );

		$this->assertInstanceOf( \Newspack_Nodes\Tests\Capture_Sink_Node::class, Core::node( 'topo' ), 'worker must accept its own LOCAL topology commands' );
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
		$interpreter = $w->build_scaffolding();
		$this->assertSame( Core::node( '_router' ), $interpreter->sink() );
	}
}
