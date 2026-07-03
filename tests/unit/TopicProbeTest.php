<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\TopicProbe_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * TopicProbe sweeps this process's Consumers (faithful to Tachikoma's
 * `for keys %Tachikoma::Nodes { isa Consumer }`) and emits ONE lean positional
 * `Probe_Record` snapshot per Consumer per tick into its sink (the shared
 * topicprobe log). Raw state only — the Message TIMESTAMP is the time; rates and
 * totals are derived downstream, never logged.
 */
#[CoversClass( TopicProbe_Node::class )]
class TopicProbeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// A real clock instant so the first fire clears the interval gate
		// (last_fire_time starts at 0).
		Core::$now = 1000;
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
		$record[ Probe_Record::MSGS ]       = 42;
		$record[ Probe_Record::END_BYTES ]  = 100 + $distance;
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
		$probe   = new TopicProbe_Node();
		$probe->name( '_topicprobe' );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 2, $capture->captured, 'one record per consumer' );
		foreach ( $capture->captured as $msg ) {
			$this->assertSame( Message::TM_STRUCT, $msg[ Message::TYPE ] );
			$this->assertSame( Core::$now, $msg[ Message::TIMESTAMP ] );
			$this->assertCount(
				9,
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

	public function test_fire_emits_nothing_when_no_consumers(): void {
		$capture = new Capture_Sink_Node();
		$probe   = new TopicProbe_Node();
		$probe->name( '_topicprobe' );
		$probe->sink( $capture );
		$probe->fire_cb();
		$this->assertCount( 0, $capture->captured );
	}

	public function test_does_not_probe_non_consumer_nodes(): void {
		// A non-Consumer in the registry (e.g. the probe's own sink) must be skipped.
		$capture = new Capture_Sink_Node();
		$capture->name( '_sink_in_registry' );
		$this->stub_consumer( 'firehose' );

		$probe = new TopicProbe_Node();
		$probe->name( '_topicprobe' );
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
		$probe = new TopicProbe_Node();
		$probe->name( '_topicprobe' );
		$this->assertSame( '5', $probe->arguments( '5' ) );
		// The getter (null arg) returns the raw string last set, not a re-parse.
		$this->assertSame( '5', $probe->arguments() );
		$ref = new \ReflectionProperty( $probe, 'interval_ms' );
		$this->assertSame( 5000, $ref->getValue( $probe ) );
	}

	public function test_arguments_empty_string_keeps_default_interval(): void {
		( new \Newspack_Nodes\Router_Node() )->name( '_router' );
		$probe = new TopicProbe_Node();
		$probe->name( '_topicprobe' );
		$this->assertSame( '', $probe->arguments( '' ) );
		$ref = new \ReflectionProperty( $probe, 'interval_ms' );
		$this->assertSame( 15000, $ref->getValue( $probe ) );
	}

	public function test_arguments_rejects_non_numeric(): void {
		$probe = new TopicProbe_Node();
		$this->expectException( \InvalidArgumentException::class );
		$probe->arguments( 'every-15s' );
	}

	public function test_fire_notifies_then_bails_before_sweeping_when_no_sink(): void {
		// fire() guards against a null sink independently of fire_cb's gate. Invoke
		// fire() directly (fire_cb would short-circuit before reaching it): the FIRE
		// notify still happens, then it returns before sweeping any Consumer.
		$this->stub_consumer( 'firehose' );
		$probe = new TopicProbe_Node();
		$probe->name( '_topicprobe' );

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
		$probe   = new TopicProbe_Node();
		$probe->name( '_topicprobe' );
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
		$probe   = new TopicProbe_Node();
		$probe->name( '_topicprobe' );
		$probe->sink( $capture );

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
