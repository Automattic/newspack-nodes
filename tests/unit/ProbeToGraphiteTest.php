<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Probe_To_Graphite_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Port of Tachikoma's TopicProbeToGraphite.pm over our positional
 * Probe_Record: fill() accumulates per-reader, fire() formats
 * `<prefix>.<reader>.<field> value ts` lines (distance, msgs_delta,
 * bytes_read_delta, cache_size), batches them ≤16 per TM_BYTESTREAM, and
 * clears its state.
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

	private function probe_message( string $reader, int $distance, int $msgs, ?float $ts = null, int $bytes = 7331, int $cache = 4242 ): array {
		$record                                 = [];
		$record[ Probe_Record::SOURCE ]         = 'firehose.p0';
		$record[ Probe_Record::READER ]         = $reader;
		$record[ Probe_Record::CURSOR_SEGMENT ] = 3;
		$record[ Probe_Record::CURSOR_OFF ]     = 100;
		$record[ Probe_Record::END_SEGMENT ]    = 3;
		$record[ Probe_Record::END_SIZE ]       = 100 + $distance;
		$record[ Probe_Record::DISTANCE ]       = $distance;
		$record[ Probe_Record::MSGS_DELTA ]     = $msgs;
		// Distinct from each other and from the 0 an absent field reads as, so
		// a field wired to the wrong Probe_Record position fails loudly.
		$record[ Probe_Record::BYTES_READ_DELTA ] = $bytes;
		$record[ Probe_Record::CACHE_SIZE ]       = $cache;

		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = $ts ?? Core::$now;
		$message[ Message::VALUE ]     = $record;
		return $message;
	}

	public function test_fire_formats_one_line_per_field_per_reader(): void {
		// The path carries no hostname: one Graphite tree per install, not per
		// container, so a reader's series survives the worker moving hosts.
		$this->node->fill( $this->probe_message( 'combined.firehose.p0', 120, 45 ) );
		$this->node->fire();

		$this->assertCount( 1, $this->sink->captured );
		$lines = explode( "\n", rtrim( $this->sink->captured[0][ Message::VALUE ], "\n" ) );
		sort( $lines );
		$this->assertSame(
			[
				'eve.combined_firehose_p0.bytes_read_delta 7331 1000000',
				'eve.combined_firehose_p0.cache_size 4242 1000000',
				'eve.combined_firehose_p0.distance 120 1000000',
				'eve.combined_firehose_p0.msgs_delta 45 1000000',
			],
			$lines
		);
	}

	public function test_an_unconfigured_node_emits_under_the_topics_prefix(): void {
		$node = new Probe_To_Graphite_Node();
		$node->name( 'graphite-default' );
		$sink = new Capture_Sink_Node();
		$node->sink( $sink );
		$node->arguments( [] );

		$node->fill( $this->probe_message( 'combined.firehose.p0', 120, 45 ) );
		$node->fire();

		$this->assertStringStartsWith( 'nodes.topics.combined_firehose_p0.', $sink->captured[0][ Message::VALUE ] );
	}

	/**
	 * A positive sub-millisecond cadence must never truncate to an own 0 ms
	 * slot, whose next_fire never exceeds now: the drain then stops sleeping
	 * and fires the node on every iteration. Assert the MODE too — a fix that
	 * floored the number but stayed on its own slot would still spin.
	 */
	public function test_arguments_floors_subsecond_interval_onto_the_router_hitchhike(): void {
		$this->node->arguments( [ 'eve', '0.0005' ] );

		$mode = ( new \ReflectionObject( $this->node ) )->getProperty( 'mode' );
		$this->assertSame( 1000, $this->node->interval_ms );
		$this->assertSame( 'router', $mode->getValue( $this->node ) );
	}

	public function test_arguments_rejects_non_numeric_interval(): void {
		$this->expectException( \InvalidArgumentException::class );

		$this->node->arguments( [ 'eve', 'gerbil' ] );
	}

	/** A zero token still takes the declared default, as the Perl original's `||=` did. */
	public function test_arguments_zero_interval_takes_the_default_cadence(): void {
		$this->node->arguments( [ 'eve', '0' ] );

		$this->assertSame( 15000, $this->node->interval_ms );
	}

	public function test_delta_fields_sum_across_sweeps_while_gauges_sample_the_latest(): void {
		// Four 15s probe sweeps inside one 60s emit window. MSGS_DELTA and
		// BYTES_READ_DELTA partition the work (Consumer re-baselines each sweep),
		// so the window's truth is their SUM; DISTANCE and CACHE_SIZE are levels.
		$this->node->fill( $this->probe_message( 'combined.firehose.p0', 500, 45, null, 7331, 1111 ) );
		$this->node->fill( $this->probe_message( 'combined.firehose.p0', 410, 60, null, 9004, 2222 ) );
		$this->node->fill( $this->probe_message( 'combined.firehose.p0', 260, 55, null, 8112, 3333 ) );
		$this->node->fill( $this->probe_message( 'combined.firehose.p0', 120, 40, null, 4877, 4242 ) );
		$this->node->fire();

		$lines = explode( "\n", rtrim( $this->sink->captured[0][ Message::VALUE ], "\n" ) );
		sort( $lines );
		$this->assertSame(
			[
				'eve.combined_firehose_p0.bytes_read_delta 29324 1000000',
				'eve.combined_firehose_p0.cache_size 4242 1000000',
				'eve.combined_firehose_p0.distance 120 1000000',
				'eve.combined_firehose_p0.msgs_delta 200 1000000',
			],
			$lines
		);

		// Sums belong to the window: the next window starts from zero again.
		$this->node->fill( $this->probe_message( 'combined.firehose.p0', 90, 7, null, 613, 4242 ) );
		$this->node->fire();
		$this->assertStringContainsString( 'msgs_delta 7 ', $this->sink->captured[1][ Message::VALUE ] );
		$this->assertStringContainsString( 'bytes_read_delta 613 ', $this->sink->captured[1][ Message::VALUE ] );
	}

	public function test_gauges_sample_the_latest_record_and_state_clears_after_fire(): void {
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
		// 19 readers, deliberately not a multiple of the batch size: 19 x 4
		// fields = 76 lines → 16 x 4 + a 12-line remainder, so the partial
		// final batch stays covered.
		for ( $i = 0; $i < 19; $i++ ) {
			$this->node->fill( $this->probe_message( "reader{$i}.p0", $i, $i ) );
		}
		$this->node->fire();

		$this->assertCount( 5, $this->sink->captured );
		$this->assertCount( 16, explode( "\n", rtrim( $this->sink->captured[0][ Message::VALUE ], "\n" ) ) );
		$this->assertCount( 12, explode( "\n", rtrim( $this->sink->captured[4][ Message::VALUE ], "\n" ) ) );
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
