<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
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
class TopicProbeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// A real clock instant so the first fire clears the interval gate
		// (last_fire_time starts at 0).
		Core::$now = 1000;
	}

	/**
	 * A record is stale after two SWEEPS, and the sweep cadence is whatever
	 * `topic-probe.tsl` declares — not the class default. A deployment that
	 * retunes the probe would otherwise have every healthy reader read as
	 * departed, recomputing off disk on every poll and reporting a zero rate.
	 */
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

	public function test_fire_emits_one_lean_positional_record_per_consumer(): void {
		// One small POSITIONAL record per consumer (not a batch) so every append
		// stays under PIPE_BUF and the shared log is multi-writer atomic. The
		// snapshot instant is the Message TIMESTAMP — NOT duplicated into VALUE.
		$this->stub_consumer( 'firehose', 200 );
		$this->stub_consumer( 'gyroscope', 0 );

		$capture = new Capture_Sink_Node();
		$probe   = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
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
		$probe->sink( $capture );
		$probe->fire_cb(); // the regular tick

		$this->assertInstanceOf( \Newspack_Nodes\Shutdown_Sweeper::class, $probe );
		$probe->shutdown_sweep();
		$this->assertCount( 2, $capture->captured, 'the final window rides out on a clean stop' );
	}

	public function test_fire_emits_nothing_when_no_consumers(): void {
		$capture = new Capture_Sink_Node();
		$probe   = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
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
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 1, $capture->captured );
		$this->assertSame(
			'firehose.p0',
			$capture->captured[0][ Message::VALUE ][ Probe_Record::READER ]
		);
	}

	public function test_arguments_sets_interval_and_returns_raw_string(): void {
		( new \Newspack_Nodes\Router_Node() )->name( '_router' ); // set_timer hitchhikes the Router TIMER
		$probe = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$this->assertSame( [ '5' ], $probe->arguments( [ '5' ] ) );
		// The getter (null arg) returns the raw string last set, not a re-parse.
		$this->assertSame( [ '5' ], $probe->arguments() );
		$ref = new \ReflectionProperty( $probe, 'interval_ms' );
		$this->assertSame( 5000, $ref->getValue( $probe ) );
	}

	public function test_arguments_empty_string_keeps_default_interval(): void {
		( new \Newspack_Nodes\Router_Node() )->name( '_router' );
		$probe = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$this->assertSame( [], $probe->arguments( [] ) );
		$ref = new \ReflectionProperty( $probe, 'interval_ms' );
		$this->assertSame( 15000, $ref->getValue( $probe ) );
	}

	public function test_arguments_rejects_non_numeric(): void {
		$probe = new Topic_Probe_Node();
		$this->expectException( \InvalidArgumentException::class );
		$probe->arguments( [ 'every-15s' ] );
	}

	public function test_fire_notifies_then_bails_before_sweeping_when_no_sink(): void {
		// fire() guards against a null sink independently of fire_cb's gate. Invoke
		// fire() directly (fire_cb would short-circuit before reaching it): the FIRE
		// notify still happens, then it returns before sweeping any Consumer.
		$this->stub_consumer( 'firehose' );
		$probe = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );

		$fired = [];
		$probe->register( 'FIRE', 'cb', function ( $payload ) use ( &$fired ): void {
			$fired[] = $payload;
		} );

		( new \ReflectionMethod( $probe, 'fire' ) )->invoke( $probe );

		$this->assertSame( [ Core::$now ], $fired );
	}

	public function test_fire_skips_a_consumer_whose_probe_stats_throws(): void {
		// One bad Consumer (probe_stats throws) is skipped rate-limited; the healthy
		// Consumer in the same sweep still emits its snapshot.
		$bad = new class() extends Consumer_Node {
			public function probe_stats(): array {
				throw new \RuntimeException( 'no segment yet' );
			}
		};
		$bad->name( 'broken' );
		$this->stub_consumer( 'firehose' );

		$capture = new Capture_Sink_Node();
		$probe   = new Topic_Probe_Node();
		$probe->name( 'topicprobe' );
		$probe->sink( $capture );
		$probe->fire_cb();

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
		$probe->sink( $capture );
		// Arm the way production does — the gate belongs to the hitchhike, so
		// the node has to be IN it, not merely carry a matching interval_ms.
		( new \Newspack_Nodes\Router_Node() )->name( '_router' );
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
