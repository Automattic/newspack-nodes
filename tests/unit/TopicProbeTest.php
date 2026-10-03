<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Node;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Topic_Probe_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Topic_Probe sweeps this process's Consumers (faithful to Tachikoma's
 * `for keys %Tachikoma::Nodes { isa Consumer }`) and emits ONE lean positional
 * `Probe_Record` snapshot per Consumer per tick into its sink (the shared
 * topicprobe log). Raw state only — the Message TIMESTAMP is the time; rates and
 * totals are derived downstream, never logged.
 */
#[CoversClass( Topic_Probe_Node::class )]
#[CoversClass( Probe_Node::class )]
class TopicProbeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// A real clock instant so the first fire clears the interval gate
		// (last_fire_time starts at 0).
		Core::$now = 1000;
		// Topology_Loader binds both halves of the worker id, as in a worker.
		Core::$var['topology']  = 'probe-worker-6118';
		Core::$var['partition'] = '2';
		// Every worker graph holds the `_router` a probe's sweep timer rides.
		( new \Newspack_Nodes\Router_Node() )->name( '_router' );
	}

	/**
	 * A record is stale after two SWEEPS, and the sweep cadence is whatever
	 * `topic-probe.tsl` declares — not the class default. A deployment that
	 * retunes the probe would otherwise have every healthy reader read as
	 * departed, recomputing off disk on every poll and reporting a zero rate.
	 */
	/**
	 * ADR-14: a broad catch on the drain path re-throws Worker_Should_Stop
	 * first. The sweep runs off the Router TIMER inside a worker, so a stop
	 * raised while a probe reads segment sizes would otherwise be logged as a
	 * skipped node and the worker would run past its deadline.
	 */
	public function test_a_cooperative_stop_escapes_the_per_node_catch(): void {
		$probe = new class() extends Probe_Node {
			protected function probe( \Newspack_Nodes\Node $node ): array {
				throw new \Newspack_Nodes\Worker_Should_Stop( 'deadline' );
			}
		};
		$probe->name( 'stopprobe' );
		$probe->arguments( [] );
		$probe->sink( new Capture_Sink_Node() );

		$this->expectException( \Newspack_Nodes\Worker_Should_Stop::class );
		$probe->fire_cb();
	}

	public function test_stale_after_reads_the_declared_sweep_cadence(): void {
		// 47 is distinct from the stock 15 and from any fallback, so a lookup
		// that quietly missed the file cannot produce 94 by coincidence.
		$stock = $this->make_temp_dir( 'probe-cadence-' );
		\file_put_contents(
			"{$stock}/topic-probe.tsl",
			"make_node Topic_Probe topicprobe 47\n"
			. "make_node Partition topicprobe:log <config:logs_dir>/topicprobe.p0\n"
			. "connect_node topicprobe topicprobe:log\n"
		);
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		Topic_Probe_Node::forget_interval();

		$this->assertSame( 94, Topic_Probe_Node::stale_after_s() );

		Topic_Probe_Node::forget_interval();
		\Newspack_Nodes\Topology_Registry::reset();
		$this->rmdir_recursive( $stock );
	}

	public function test_stale_after_falls_back_when_the_topology_declares_no_probe(): void {
		// A topic-probe topology carrying no Topic_Probe node at all: there is no
		// cadence to read, and "no cadence" must not become "never stale".
		$stock = $this->make_temp_dir( 'probe-nonode-' );
		\file_put_contents( "{$stock}/topic-probe.tsl", "make_node Echo topicprobe:sink\n" );
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		Topic_Probe_Node::forget_interval();

		$this->assertSame( 30, Topic_Probe_Node::stale_after_s() );

		Topic_Probe_Node::forget_interval();
		\Newspack_Nodes\Topology_Registry::reset();
		$this->rmdir_recursive( $stock );
	}

	public function test_an_unreadable_probe_topology_fails_the_cadence_read(): void {
		$stock = $this->make_temp_dir( 'probe-broken-' );
		\file_put_contents( "{$stock}/topic-probe.tsl", "include no-such-probe-base-7719\n" );
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		Topic_Probe_Node::forget_interval();

		try {
			$this->expectExceptionMessageMatches( '/no-such-probe-base-7719/' );
			Topic_Probe_Node::declared_interval_s();
		} finally {
			Topic_Probe_Node::forget_interval();
			\Newspack_Nodes\Topology_Registry::reset();
			$this->rmdir_recursive( $stock );
		}
	}

	public function test_the_cadence_is_read_once_and_memoized(): void {
		// Read per request, off a graph the analyzer caches — a status poll must
		// not re-parse the TSL for every reader row.
		$stock = $this->make_temp_dir( 'probe-memo-' );
		\file_put_contents( "{$stock}/topic-probe.tsl", "make_node Topic_Probe topicprobe 23\n" );
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );
		Topic_Probe_Node::forget_interval();

		$this->assertSame( 23, Topic_Probe_Node::declared_interval_s() );
		\file_put_contents( "{$stock}/topic-probe.tsl", "make_node Topic_Probe topicprobe 99\n" );
		$this->assertSame( 23, Topic_Probe_Node::declared_interval_s(), 'memoized, not re-read' );

		Topic_Probe_Node::forget_interval();
		\Newspack_Nodes\Topology_Registry::reset();
		$this->rmdir_recursive( $stock );
	}

	public function test_stale_after_falls_back_to_the_default_cadence(): void {
		// No topic-probe topology reachable at all: the default is the only
		// honest answer, and it must not become "never stale".
		\Newspack_Nodes\Topology_Registry::reset();
		Topic_Probe_Node::forget_interval();

		$this->assertSame( 30, Topic_Probe_Node::stale_after_s() );
	}

	/** A registered Consumer whose probe_stats() is a canned positional record. */
	private function stub_consumer( string $name, int $distance = 0 ): Consumer_Node {
		$c = new class() extends Consumer_Node {
			public array $canned = [];
			public function probe_stats(): array {
				return $this->canned;
			}
			public function make_ready(): void {
				$this->set_state( 'READY', $this->name );
			}
		};
		$record                             = [];
		$record[ Probe_Record::SOURCE ]     = 'requests.p0';
		$record[ Probe_Record::READER ]     = "{$name}.p0";
		$record[ Probe_Record::CURSOR_SEGMENT ] = 3;
		$record[ Probe_Record::CURSOR_OFF ] = 100;
		$record[ Probe_Record::END_SEGMENT ]    = 3;
		$record[ Probe_Record::END_SIZE ]   = 100 + $distance;
		$record[ Probe_Record::DISTANCE ]   = $distance;
		$record[ Probe_Record::MSGS_DELTA ] = 42;
		$record[ Probe_Record::END_BYTES ]  = 100 + $distance;
		$record[ Probe_Record::CACHE_SIZE ] = 0;
		$record[ Probe_Record::BYTES_READ_DELTA ] = 512;
		$record[ Probe_Record::ELAPSED_MS ] = 15000;
		$c->canned = $record;
		$c->name( $name ); // registers into Core::$nodes_by_name (the sweep set)
		$c->make_ready();
		return $c;
	}

	/** An interpreter answering into `$replies`, over setUp's `_router`. */
	private static function interpreter( Capture_Sink_Node $replies ): \Newspack_Nodes\Command_Interpreter_Node {
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();
		$interpreter->sink( $replies );
		return $interpreter;
	}

	/** Build a TM_COMMAND the way a REPL line reaches the interpreter. */
	private static function command( string $name, string $args ): array {
		$m                    = Message::new_message();
		$m[ Message::TYPE ]   = Message::TM_COMMAND;
		$m[ Message::FROM ]   = '_output/1';
		$m[ Message::VALUE ]  = [ 'name' => $name, 'arguments' => \explode( ' ', $args ) ];
		$m[ Message::LOCAL ]  = true;
		return $m;
	}

	public function test_make_node_outside_a_worker_answers_TM_ERROR_and_registers_no_probe(): void {
		// A bare `wp nodes cli` binds nothing, so the probe would throw on a tick.
		unset( Core::$var['topology'], Core::$var['partition'] );
		$replies     = new Capture_Sink_Node();
		$interpreter = self::interpreter( $replies );

		$interpreter->fill( self::command( 'make_node', 'Topic_Probe topicprobe-8817 15' ) );

		$this->assertSame( Message::TM_COMMAND | Message::TM_ERROR, $replies->captured[0][ Message::TYPE ] );
		$this->assertSame( "topicprobe-8817: no topology bound; a probe runs only in a worker\n", (string) $replies->captured[0][ Message::VALUE ]['payload'] );
		$this->assertNull( Core::node( 'topicprobe-8817' ), 'the refused probe is removed' );
	}

	public function test_make_node_in_a_worker_builds_a_probe_that_fires_named_for_it(): void {
		$this->stub_consumer( 'firehose', 300 );
		$replies     = new Capture_Sink_Node();
		$interpreter = self::interpreter( $replies );

		$interpreter->fill( self::command( 'make_node', 'Topic_Probe topicprobe-8817 15' ) );
		$probe   = Core::node( 'topicprobe-8817' );
		$capture = new Capture_Sink_Node();
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertSame( 0, $replies->captured[0][ Message::TYPE ] & Message::TM_ERROR, 'make_node answered no error' );
		$this->assertInstanceOf( Topic_Probe_Node::class, $probe );
		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 'probe-worker-6118.p2/topicprobe-8817', $capture->captured[0][ Message::FROM ] );
	}

	public function test_fire_emits_one_lean_positional_record_per_consumer(): void {
		// One small POSITIONAL record per consumer (not a batch) so every append
		// stays under PIPE_BUF and the shared log is multi-writer atomic. The
		// snapshot instant is the Message TIMESTAMP — NOT duplicated into VALUE.
		$this->stub_consumer( 'firehose', 200 );
		$this->stub_consumer( 'gyroscope', 0 );

		$capture = new Capture_Sink_Node();
		$probe   = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->arguments( [] );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 2, $capture->captured, 'one record per consumer' );
		foreach ( $capture->captured as $msg ) {
			$this->assertSame( Message::TM_STRUCT, $msg[ Message::TYPE ] );
			$this->assertSame( Core::$now, $msg[ Message::TIMESTAMP ] );
			$this->assertCount(
				12,
				$msg[ Message::VALUE ],
				'lean positional record — no ts/host/derived fields'
			);
		}
		$readers = \array_map(
			static fn ( $m ) => $m[ Message::VALUE ][ Probe_Record::READER ],
			$capture->captured
		);
		\sort( $readers );
		$this->assertSame( [ 'firehose.p0', 'gyroscope.p0' ], $readers );
	}

	public function test_shutdown_sweep_emits_the_final_partial_interval(): void {
		// A worker recycles every ~595s, so the window since the last tick is real
		// work. The probe OPTS IN to the clean-shutdown sweep and emits it even
		// though the timer gate has not elapsed.
		$this->stub_consumer( 'firehose', 200 );
		$capture = new Capture_Sink_Node();
		$probe   = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->arguments( [] );
		$probe->sink( $capture );
		$probe->fire_cb(); // the regular tick

		$this->assertInstanceOf( \Newspack_Nodes\Shutdown_Sweeper::class, $probe );
		$probe->shutdown_sweep();
		$this->assertCount( 2, $capture->captured, 'the final window rides out on a clean stop' );
	}

	public function test_fire_emits_a_consumer_record_verbatim_without_fitting(): void {
		// Only Job_Probe fits: a Jobstats_Record carries a free-text LAST_MESSAGE
		// that can overflow PIPE_BUF, a Probe_Record carries no such field. Halving
		// a SOURCE would corrupt the partition identity a reader keys on, so an
		// oversize record must ride out whole and let Partition refuse it.
		$consumer                                  = $this->stub_consumer( 'firehose' );
		$consumer->canned[ Probe_Record::SOURCE ] = \str_repeat( 'p', 6000 );

		$capture = new Capture_Sink_Node();
		$probe   = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->arguments( [] );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 1, $capture->captured );
		$this->assertSame(
			\str_repeat( 'p', 6000 ),
			$capture->captured[0][ Message::VALUE ][ Probe_Record::SOURCE ],
			'untrimmed — no Line_Fitter on the consumer sweep'
		);
		$this->assertGreaterThan(
			\Newspack_Nodes\Partition_Node::MAX_LINE_SIZE,
			Message::packed_size( $capture->captured[0] )
		);
	}

	public function test_fire_emits_nothing_when_no_consumers(): void {
		$capture = new Capture_Sink_Node();
		$probe   = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->arguments( [] );
		$probe->sink( $capture );
		$probe->fire_cb();
		$this->assertCount( 0, $capture->captured );
	}

	public function test_does_not_probe_non_consumer_nodes(): void {
		// A non-Consumer in the registry (e.g. the probe's own sink) must be skipped.
		$capture = new Capture_Sink_Node();
		$capture->name( '_sink_in_registry' );
		$this->stub_consumer( 'firehose' );

		$probe = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->arguments( [] );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 1, $capture->captured );
		$this->assertSame(
			'firehose.p0',
			$capture->captured[0][ Message::VALUE ][ Probe_Record::READER ]
		);
	}

	public function test_arguments_sets_interval_and_returns_raw_string(): void {
		$probe = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$this->assertSame( [ '5' ], $probe->arguments( [ '5' ] ) );
		// The getter (null arg) returns the raw string last set, not a re-parse.
		$this->assertSame( [ '5' ], $probe->arguments() );
		$ref = new \ReflectionProperty( $probe, 'interval_ms' );
		$this->assertSame( 5000, $ref->getValue( $probe ) );
	}

	public function test_arguments_empty_string_keeps_default_interval(): void {
		$probe = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$this->assertSame( [], $probe->arguments( [] ) );
		$ref = new \ReflectionProperty( $probe, 'interval_ms' );
		$this->assertSame( 15000, $ref->getValue( $probe ) );
	}

	/** Every probe palettes as a Monitor with the one shared `interval_s` positional, and names only its own description. */
	public function test_every_probe_shares_the_monitor_interval_schema(): void {
		$interval = [ 'name' => 'interval_s', 'type' => 'int', 'default' => 15, 'description' => 'Sweep cadence in seconds; empty or absent defaults to 15.' ];
		$seen     = [];
		foreach ( [ Topic_Probe_Node::class, \Newspack_Nodes\Job_Probe_Node::class, \Newspack_Nodes\Table_Probe_Node::class ] as $class ) {
			$schema = $class::node_schema();
			$this->assertSame( 'Monitor', $schema['category'], $class );
			$this->assertSame( [ $interval ], $schema['arguments'], $class );
			$this->assertNotSame( '', $schema['description'], $class );
			$seen[] = $schema['description'];
		}
		$this->assertCount( 3, \array_unique( $seen ) );
		$this->assertSame( [ $interval ], \Newspack_Nodes\Probe_Node::node_schema()['arguments'] );
	}

	public function test_arguments_rejects_non_numeric(): void {
		$probe = new Topic_Probe_Node();
		$this->expectException( \InvalidArgumentException::class );
		$probe->arguments( [ 'every-15s' ] );
	}

	/** A zero cadence must never take an own 0 ms slot: the floor puts it on the Router hitchhike. */
	public function test_arguments_floors_zero_interval_onto_the_router_hitchhike(): void {
		$probe = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->arguments( [] );

		$probe->arguments( [ '0' ] );

		$mode = ( new \ReflectionObject( $probe ) )->getProperty( 'mode' );
		$this->assertSame( 1000, $probe->interval_ms );
		$this->assertSame( 'router', $mode->getValue( $probe ) );
	}

	public function test_fire_notifies_then_bails_before_sweeping_when_no_sink(): void {
		// fire() guards against a null sink independently of fire_cb's gate. Invoke
		// fire() directly (fire_cb would short-circuit before reaching it): the FIRE
		// notify still happens, then it returns before sweeping any Consumer.
		$this->stub_consumer( 'firehose' );
		$probe = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->arguments( [] );

		$fired = [];
		$probe->register( 'FIRE', 'cb', function ( $payload ) use ( &$fired ): void {
			$fired[] = $payload;
		} );

		( new \ReflectionMethod( $probe, 'fire' ) )->invoke( $probe );

		$this->assertSame( [ Core::$now ], $fired );
	}

	public function test_a_consumer_whose_probe_stats_throws_costs_its_peers_nothing_then_escapes(): void {
		// Every Consumer is swept; the bad one's failure escapes after the last.
		$no_segment = new \RuntimeException( 'no segment yet-2716' );
		$bad        = new class( $no_segment ) extends Consumer_Node {
			public function __construct( private \RuntimeException $no_segment ) {
				parent::__construct();
			}
			public function probe_stats(): array {
				throw $this->no_segment;
			}
			public function make_ready(): void {
				$this->set_state( 'READY', $this->name );
			}
		};
		$bad->name( 'broken' );
		$bad->make_ready();
		$this->stub_consumer( 'firehose' );

		$capture = new Capture_Sink_Node();
		$probe   = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->arguments( [] );
		$probe->sink( $capture );
		$caught = null;
		try {
			$probe->fire_cb();
		} catch ( \RuntimeException $e ) {
			$caught = $e;
		}

		$this->assertSame( $no_segment, $caught );
		$this->assertCount( 1, $capture->captured );
		$this->assertSame(
			'firehose.p0',
			$capture->captured[0][ Message::VALUE ][ Probe_Record::READER ]
		);
	}

	public function test_fire_gates_to_the_interval_against_last_fire_time(): void {
		// Hitchhikes the Router TIMER (fires every tick); only does real work once
		// per interval_s, gated against last_fire_time — like Consumer's publish.
		$this->stub_consumer( 'firehose' );
		$capture = new Capture_Sink_Node();
		$probe   = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->arguments( [] );
		$probe->sink( $capture );
		// Arm the way production does — the gate belongs to the hitchhike, so
		// the node has to be IN it, not merely carry a matching interval_ms.
		$probe->set_timer( 15000 );
		$this->assertSame( 'router', $probe->timer_mode() );

		Core::$now = 1000;
		$probe->fire_cb(); // due (last_fire_time 0) → emit
		$this->assertCount( 1, $capture->captured );

		$probe->fire_cb(); // same instant → gated
		$this->assertCount( 1, $capture->captured );

		Core::$now = 1015; // interval (15s) elapsed → emit
		$probe->fire_cb();
		$this->assertCount( 2, $capture->captured );

		Core::$now = 1029; // < 15s since last fire → gated
		$probe->fire_cb();
		$this->assertCount( 2, $capture->captured );
	}
}
