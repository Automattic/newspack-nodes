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
		};
		$record                          = [];
		$record[ Probe_Record::SOURCE ]     = 'requests.p0';
		$record[ Probe_Record::READER ]     = "{$name}.p0";
		$record[ Probe_Record::CURSOR_SEG ] = 3;
		$record[ Probe_Record::CURSOR_OFF ] = 100;
		$record[ Probe_Record::END_SEG ]    = 3;
		$record[ Probe_Record::END_SIZE ]   = 100 + $distance;
		$record[ Probe_Record::DISTANCE ]   = $distance;
		$record[ Probe_Record::MSGS ]       = 42;
		$c->canned = $record;
		$c->name( $name ); // registers into Core::$nodes_by_name (the sweep set)
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
				8,
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
