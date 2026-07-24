<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Probe_To_Graphite_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Port of Tachikoma's TopicProbeToGraphite.pm over our positional
 * Probe_Record: fill() accumulates per-reader, fire() formats
 * `prefix.host.nodes.topics.<reader>.<field> value ts` lines (distance,
 * msgs), batches them ≤16 per TM_BYTESTREAM, and clears its state.
 */
#[CoversClass( Probe_To_Graphite_Node::class )]
class ProbeToGraphiteTest extends TestCase {
	private Probe_To_Graphite_Node $node;
	private Capture_Sink_Node $sink;
	private float $prev_now;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_now = Core::$now;
		Core::$now      = 1000000.0;
		$router         = new \Newspack_Nodes\Router_Node();
		$router->name( \Newspack_Nodes\Node_Names::ROUTER );
		$this->sink = new Capture_Sink_Node();
		$this->node = new Probe_To_Graphite_Node();
		$this->node->name( 'graphite-format' );
		$this->node->sink( $this->sink );
		$this->node->arguments( [ 'eve', '60' ] );
	}

	protected function tearDown(): void {
		Core::$now = $this->prev_now;
		parent::tearDown();
	}

	private function probe_message( string $reader, int $distance, int $msgs, ?float $ts = null ): array {
		$record                              = [];
		$record[ Probe_Record::SOURCE ]      = 'firehose.p0';
		$record[ Probe_Record::READER ]      = $reader;
		$record[ Probe_Record::CURSOR_SEGMENT ] = 3;
		$record[ Probe_Record::CURSOR_OFF ]  = 100;
		$record[ Probe_Record::END_SEGMENT ] = 3;
		$record[ Probe_Record::END_SIZE ]    = 100 + $distance;
		$record[ Probe_Record::DISTANCE ]    = $distance;
		$record[ Probe_Record::MSGS ]        = $msgs;

		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = $ts ?? Core::$now;
		$message[ Message::VALUE ]     = $record;
		return $message;
	}

	public function test_fire_formats_distance_and_msgs_lines_per_reader(): void {
		$this->node->fill( $this->probe_message( 'combined.firehose.p0', 120, 45 ) );
		$this->node->fire();

		$this->assertCount( 1, $this->sink->captured );
		$lines = explode( "\n", rtrim( $this->sink->captured[0][ Message::VALUE ], "\n" ) );
		sort( $lines );
		$this->assertSame(
			[
				'eve.' . gethostname() . '.nodes.topics.combined_firehose_p0.distance 120 1000000',
				'eve.' . gethostname() . '.nodes.topics.combined_firehose_p0.msgs 45 1000000',
			],
			$lines
		);
	}

	public function test_latest_record_per_reader_wins_and_state_clears_after_fire(): void {
		$this->node->fill( $this->probe_message( 'combined.firehose.p0', 500, 1 ) );
		$this->node->fill( $this->probe_message( 'combined.firehose.p0', 120, 45 ) );
		$this->node->fire();

		$this->assertCount( 1, $this->sink->captured );
		$this->assertStringContainsString( 'distance 120 ', $this->sink->captured[0][ Message::VALUE ] );
		$this->assertStringNotContainsString( 'distance 500 ', $this->sink->captured[0][ Message::VALUE ] );

		// State cleared: an empty follow-up fire emits nothing.
		$this->node->fire();
		$this->assertCount( 1, $this->sink->captured );
	}

	public function test_fire_batches_at_most_sixteen_lines_per_message(): void {
		for ( $i = 0; $i < 20; $i++ ) {
			$this->node->fill( $this->probe_message( "reader{$i}.p0", $i, $i ) );
		}
		$this->node->fire();

		// 40 lines → 16 + 16 + 8.
		$this->assertCount( 3, $this->sink->captured );
		$this->assertCount( 16, explode( "\n", rtrim( $this->sink->captured[0][ Message::VALUE ], "\n" ) ) );
		$this->assertCount( 8, explode( "\n", rtrim( $this->sink->captured[2][ Message::VALUE ], "\n" ) ) );
	}

	public function test_non_struct_and_malformed_records_are_ignored(): void {
		$bytes                       = Message::new_message();
		$bytes[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$bytes[ Message::VALUE ]     = 'noise';
		$bytes[ Message::TIMESTAMP ] = Core::$now;
		$this->node->fill( $bytes );

		$struct                       = Message::new_message();
		$struct[ Message::TYPE ]      = Message::TM_STRUCT;
		$struct[ Message::VALUE ]     = [ 'k' => 'job' ];
		$struct[ Message::TIMESTAMP ] = Core::$now;
		$this->node->fill( $struct );

		$this->node->fire();
		$this->assertSame( [], $this->sink->captured );
	}
}
