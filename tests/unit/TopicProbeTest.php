<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\TopicProbe_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * TopicProbe sweeps this process's Consumers (faithful to Tachikoma's
 * `for keys %Tachikoma::Nodes { isa Consumer }`) and emits ONE snapshot record
 * per tick — consumer + partition state captured at the same instant — into its
 * sink (the shared topicprobe log). Log-only: no memcache.
 */
#[CoversClass( TopicProbe_Node::class )]
class TopicProbeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// A real clock instant so the first fire clears the interval gate
		// (last_fire_time starts at 0).
		Core::$now = 1000;
	}

	/** A registered Consumer whose probe_stats() is canned (no real segments needed). */
	private function stub_consumer( string $name, int $bytes_read, int $bytes_behind ): Consumer_Node {
		$c = new class() extends Consumer_Node {
			public array $canned = [];
			public function probe_stats(): array {
				return $this->canned;
			}
		};
		$c->canned = [
			'consumer'     => $name,
			'offset_dir'   => "{$name}.p0",
			'source'       => 'requests.p0',
			'cursor_seg'   => 3,
			'cursor_off'   => 100,
			'bytes_read'   => $bytes_read,
			'bytes_behind' => $bytes_behind,
			'bytes_total'  => $bytes_read + $bytes_behind,
			'msg_sent'     => 42,
			'worker_type'  => 'firehose',
		];
		$c->name( $name ); // registers into Core::$nodes_by_name (the sweep set)
		return $c;
	}

	public function test_fire_emits_one_record_per_consumer_stamped_with_one_instant(): void {
		// One small record per consumer (not a batch) so every append stays under
		// PIPE_BUF and the shared log is multi-writer atomic. All share one `ts`.
		$this->stub_consumer( 'firehose', 5000, 200 );
		$this->stub_consumer( 'gyroscope', 8000, 0 );

		$capture = new Capture_Sink_Node();
		$probe   = new TopicProbe_Node();
		$probe->name( '_topicprobe' );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 2, $capture->captured, 'one record per consumer' );
		$vals = \array_map(
			static fn ( $m ) => $m[ Message::VALUE ],
			$capture->captured
		);
		foreach ( $capture->captured as $msg ) {
			$this->assertSame( Message::TM_STRUCT, $msg[ Message::TYPE ] );
		}
		$names = \array_column( $vals, 'consumer' );
		\sort( $names );
		$this->assertSame( [ 'firehose', 'gyroscope' ], $names );
		// Each record carries ts + host + the consumer's rate/backlog volumes.
		$this->assertSame( Core::$now, $vals[0]['ts'] );
		$this->assertArrayHasKey( 'host', $vals[0] );
		$this->assertArrayHasKey( 'bytes_read', $vals[0] );
		$this->assertArrayHasKey( 'bytes_behind', $vals[0] );
		// All records from one tick share the snapshot instant.
		$this->assertSame( $vals[0]['ts'], $vals[1]['ts'] );
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
		$this->stub_consumer( 'firehose', 5000, 0 );

		$probe = new TopicProbe_Node();
		$probe->name( '_topicprobe' );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 'firehose', $capture->captured[0][ Message::VALUE ]['consumer'] );
	}

	public function test_fire_computes_read_and_write_rate_from_consecutive_snapshots(): void {
		// Rates are computed BY THE PROBE from its own consecutive 15s samples
		// (Δbytes / Δts) — the single source, so downstream never re-deltas a
		// live value at a different cadence. First sample has no prior → rate 0.
		$c = $this->stub_consumer( 'firehose', 1000, 0 );
		$c->canned['bytes_total'] = 5000;
		$capture = new Capture_Sink_Node();
		$probe   = new TopicProbe_Node();
		$probe->name( '_topicprobe' );
		$probe->sink( $capture );

		Core::$now = 1000;
		$probe->fire_cb();
		$this->assertSame( 0.0, $capture->captured[0][ Message::VALUE ]['read_rate'] );
		$this->assertSame( 0.0, $capture->captured[0][ Message::VALUE ]['write_rate'] );

		$c->canned['bytes_read']  = 4000;  // +3000 bytes read
		$c->canned['bytes_total'] = 12500; // +7500 bytes written to the partition
		Core::$now = 1015;                 // +15s
		$probe->fire_cb();
		$this->assertSame( 200.0, $capture->captured[1][ Message::VALUE ]['read_rate'], 'Δread/Δts = 3000/15' );
		$this->assertSame( 500.0, $capture->captured[1][ Message::VALUE ]['write_rate'], 'Δtotal/Δts = 7500/15' );
	}

	public function test_fire_gates_to_the_interval_against_last_fire_time(): void {
		// Hitchhikes the Router TIMER (fires every tick); only does real work once
		// per interval_s, gated against last_fire_time — like Consumer's publish.
		$this->stub_consumer( 'firehose', 5000, 0 );
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
