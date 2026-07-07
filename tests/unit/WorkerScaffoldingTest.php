<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\TopicProbe_Node;
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

	public function test_build_scaffolding_mounts_topic_probe_targeting_the_log(): void {
		// Every worker process runs its own TopicProbe, sweeping its local Consumers
		// into the shared topicprobe log. It steers there with target() (rule #2:
		// everything sinks into the interpreter; flow is routed by TO), and the log
		// is a 5 MiB / 2-segment / 24h Partition.
		$w = new Worker_Base( $this->tmp, 'test', 0 );
		$w->build_scaffolding();

		$probe = Core::node( '_topicprobe' );
		$log   = Core::node( '_topicprobe:log' );
		$this->assertInstanceOf( TopicProbe_Node::class, $probe );
		$this->assertInstanceOf( Partition_Node::class, $log );
		$this->assertSame( '_topicprobe:log', $probe->target() );

		[ , $segment_size, $num_segments, $max_lifespan ] = \explode(
			' ',
			$log->arguments()
		);
		$this->assertSame( (string) ( 1024 * 1024 ), $segment_size );
		$this->assertSame( '2', $num_segments );
		$this->assertSame( '86400', $max_lifespan );
	}

	public function test_ipc_input_consumer_resumes_from_prior_offsetlog(): void {
		// Durable IPC-input offsetlog: a prior worker checkpointed its read offset;
		// the respawned worker resumes from it, so commands queued during the
		// ~10-min restart aren't dropped (the live console keeps getting replies).
		$ipc_dir = "{$this->tmp}/ipc/test.p0";
		\mkdir( "{$ipc_dir}/input", 0755, true );
		$seed = new Consumer_Node();
		$seed->arguments( "{$ipc_dir}/input {$ipc_dir}/input.offsets" );
		$seed->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$seed->poll(); // a real prior worker polls (seeding the cursor) before it checkpoints.
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
		$message                                  = \Newspack_Nodes\Message::new_message();
		$message[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$message[ \Newspack_Nodes\Message::VALUE ] = "old-command\n";
		$input->fill( $message );

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
		$message                                  = \Newspack_Nodes\Message::new_message();
		$message[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$message[ \Newspack_Nodes\Message::VALUE ] = $value;
		$partition->fill( $message );
		$partition->flush();
	}

	public function test_clean_shutdown_graceful_checkpoints_registry_work_consumers(): void {
		// A clean recycle must hand off the worker's durable work consumers (registered
		// in Core, unlike the anonymous IPC consumer) at attempts=0, so a respawn
		// resumes at the virgin baseline (1) instead of climbing toward a false poison
		// strike. Only a hard crash — which never runs this shutdown path — leaves a
		// non-graceful frame and lets attempts climb.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$msg                            = \Newspack_Nodes\Message::new_message();
		$msg[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$msg[ \Newspack_Nodes\Message::VALUE ] = 'hello';
		$source->fill( $msg );
		$source->flush();

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' ); // registers in Core::$nodes_by_name.
		$c->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$this->pump_consumer( $c ); // advances → healthy attempts=1.

		$w = new Worker_Base( $this->tmp, 'firehose', 0 );
		$w->checkpoint_durable_consumers(); // clean-shutdown handoff.

		$paths = \glob( "{$this->tmp}/offsets.p0/*.log" );
		\usort( $paths, static fn ( $x, $y ): int => (int) \basename( $x, '.log' ) <=> (int) \basename( $y, '.log' ) );
		$lines = \array_values( \array_filter( \explode( "\n", (string) \file_get_contents( (string) \end( $paths ) ) ) ) );
		$entry = \Newspack_Nodes\Message::unpacked( (string) \end( $lines ) )[ \Newspack_Nodes\Message::VALUE ];
		$this->assertSame( 0, $entry['attempts'], 'a clean shutdown hands off work consumers at attempts=0' );
	}

	public function test_cooperative_stop_routes_durable_consumer_to_a_fair_shot_strike(): void {
		// When the worker stops cooperatively (timeout/memory), the shutdown must route
		// its durable work consumers through the fair-shot rule — stamping the reason —
		// NOT the blanket graceful handoff used for a clean recycle (dead-letter [42]).
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data.p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$msg                                   = \Newspack_Nodes\Message::new_message();
		$msg[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_BYTESTREAM;
		$msg[ \Newspack_Nodes\Message::VALUE ] = 'poison';
		$source->fill( $msg );
		$source->flush();

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0 {$this->tmp}/deadletter.p0" );
		$c->name( 'firehose:consumer' ); // registers in Core::$nodes_by_name.
		$c->sink( new class() extends \Newspack_Nodes\Node {
			public function fill( array $message ): void {
				throw new \Newspack_Nodes\Worker_Should_Stop();
			}
		} );
		try {
			$this->pump_consumer( $c );
		} catch ( \Newspack_Nodes\Worker_Should_Stop $e ) {
			$this->addToAssertionCount( 1 );
		}

		$w = new Worker_Base( $this->tmp, 'firehose', 0 );
		( new \ReflectionProperty( Worker_Base::class, 'stop_reason' ) )->setValue( $w, 'timeout' );
		$w->checkpoint_durable_consumers();

		$paths = \glob( "{$this->tmp}/offsets.p0/*.log" );
		\usort( $paths, static fn ( $x, $y ): int => (int) \basename( $x, '.log' ) <=> (int) \basename( $y, '.log' ) );
		$lines = \array_values( \array_filter( \explode( "\n", (string) \file_get_contents( (string) \end( $paths ) ) ) ) );
		$entry = \Newspack_Nodes\Message::unpacked( (string) \end( $lines ) )[ \Newspack_Nodes\Message::VALUE ];
		$this->assertSame( 'timeout', $entry['reason'], 'a cooperative stop routes durable consumers to the fair-shot rule' );
	}

	public function test_fatal_shutdown_skips_graceful_handoff_so_attempts_climb(): void {
		// A catchable fatal (OOM) runs the shutdown handler but is NOT a clean recycle: the
		// handler must NOT graceful-checkpoint (which resets attempts to 0), or a deterministic
		// fatal-poison would reset its crash counter every lifetime and never reach the crawl.
		$this->seed_offsetlog_frame( "{$this->tmp}/offsets.p0", 0, 0, 2, '' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$this->pump_consumer( $c ); // load_offsetlog resumes at attempts=3 and writes that boot frame.

		$w = new FatalProbeWorker( $this->tmp, 'firehose', 0 );
		$w->err = [ 'type' => \E_ERROR, 'message' => 'oom', 'file' => 'f', 'line' => 1 ];
		$w->shutdown_handoff();

		$entry = $this->newest_offsetlog_entry_for( "{$this->tmp}/offsets.p0" );
		$this->assertSame( 3, $entry['attempts'], 'a fatal must not reset the climbing crash counter to a graceful 0' );
	}

	public function test_clean_shutdown_handoff_graceful_checkpoints_when_not_fatal(): void {
		$this->seed_offsetlog_frame( "{$this->tmp}/offsets.p0", 0, 0, 2, '' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data.p0 {$this->tmp}/offsets.p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$this->pump_consumer( $c );

		$w = new FatalProbeWorker( $this->tmp, 'firehose', 0 );
		$w->err = null; // clean exit.
		$w->shutdown_handoff();

		$entry = $this->newest_offsetlog_entry_for( "{$this->tmp}/offsets.p0" );
		$this->assertSame( 0, $entry['attempts'], 'a clean (non-fatal) shutdown hands off gracefully at attempts=0' );
	}

	/** Newest offsetlog keyframe VALUE from a directory of {id}.log segments. */
	private function newest_offsetlog_entry_for( string $dir ): array {
		$paths = \glob( "{$dir}/*.log" );
		\usort( $paths, static fn ( $x, $y ): int => (int) \basename( $x, '.log' ) <=> (int) \basename( $y, '.log' ) );
		$lines = \array_values( \array_filter( \explode( "\n", (string) \file_get_contents( (string) \end( $paths ) ) ) ) );
		return \Newspack_Nodes\Message::unpacked( (string) \end( $lines ) )[ \Newspack_Nodes\Message::VALUE ];
	}

	/** Write one offsetlog keyframe to seed a respawning worker's boot state (crash-simulation). */
	private function seed_offsetlog_frame( string $dir, int $segment, int $offset, int $attempts, string $reason = '' ): void {
		\mkdir( $dir, 0755, true );
		$m                   = \Newspack_Nodes\Message::new_message();
		$m[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_STRUCT;
		$m[ \Newspack_Nodes\Message::FROM ]  = 'seed';
		$m[ \Newspack_Nodes\Message::VALUE ] = [ 'segment' => $segment, 'offset' => $offset, 'attempts' => $attempts, 'reason' => $reason, 'first_crash_ts' => null ];
		\file_put_contents( "{$dir}/0.log", \Newspack_Nodes\Message::packed( $m ) . "\n" );
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

/** Worker with a settable error_get_last() so the fatal-shutdown branch is testable without a real fatal. */
class FatalProbeWorker extends Worker_Base {
	public ?array $err = null;
	protected function last_error(): ?array {
		return $this->err;
	}
}
