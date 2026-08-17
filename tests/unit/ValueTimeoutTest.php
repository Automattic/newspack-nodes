<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Value_Timeout_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Port of Tachikoma's PayloadTimeout.pm: value-keyed dedup with a timeout
 * window and a trailing re-emit. The first value forwards; duplicates
 * inside the window are suppressed but refresh recently_received; fire()
 * re-emits a value whose window aged out while requests kept arriving, and
 * forgets one that went quiet. Stale messages (older than expires) drop.
 */
#[CoversClass( Value_Timeout_Node::class )]
class ValueTimeoutTest extends TestCase {
	private Value_Timeout_Node $node;
	private Capture_Sink_Node $sink;
	private float $prev_now;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_now = Core::$now;
		Core::$now      = 1000000.0;
		$router         = new \Newspack_Nodes\Router_Node();
		$router->name( \Newspack_Nodes\Node_Names::ROUTER );
		$this->sink = new Capture_Sink_Node();
		$this->node = new Value_Timeout_Node();
		$this->node->name( 'value-gate' );
		$this->node->sink( $this->sink );
		$this->node->arguments( [ '60', '300' ] );
	}

	protected function tearDown(): void {
		Core::$now = $this->prev_now;
		parent::tearDown();
	}

	private function value_message( string $value, ?float $ts = null ): array {
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = $ts ?? Core::$now;
		$message[ Message::VALUE ]     = $value . "\n";
		return $message;
	}

	private function captured_values(): array {
		return array_map(
			static fn ( array $m ) => $m[ Message::VALUE ],
			$this->sink->captured
		);
	}

	public function test_first_value_forwards_and_duplicate_is_suppressed(): void {
		$this->node->fill( $this->value_message( 'warm_homepage' ) );
		$this->node->fill( $this->value_message( 'warm_homepage' ) );
		$this->node->fill( $this->value_message( 'other_task' ) );

		$this->assertSame( [ "warm_homepage\n", "other_task\n" ], $this->captured_values() );
	}

	public function test_value_older_than_expires_is_dropped(): void {
		$this->node->fill( $this->value_message( 'stale_task', Core::$now - 301.0 ) );

		$this->assertSame( [], $this->captured_values() );
	}

	public function test_missing_timestamp_is_dropped(): void {
		$message                       = $this->value_message( 'no_ts' );
		$message[ Message::TIMESTAMP ] = 0;
		$this->node->fill( $message );

		$this->assertSame( [], $this->captured_values() );
	}

	public function test_non_bytestream_is_dropped(): void {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'k' => 'job' ];
		$message[ Message::TIMESTAMP ] = Core::$now;
		$this->node->fill( $message );

		$this->assertSame( [], $this->captured_values() );
	}

	public function test_fire_re_emits_when_requests_kept_arriving_past_the_window(): void {
		$this->node->fill( $this->value_message( 'warm_homepage' ) );

		// A duplicate arrives late in the window (suppressed, refreshes received).
		Core::$now = 1000050.0;
		$this->node->fill( $this->value_message( 'warm_homepage' ) );
		$this->assertCount( 1, $this->sink->captured );

		// Window ages out (sent stamp was 1000000 + 60); received > sent → re-emit.
		Core::$now = 1000061.0;
		$this->node->fire();

		$this->assertSame( [ "warm_homepage\n", "warm_homepage\n" ], $this->captured_values() );
		$this->assertSame( 'value-gate', $this->sink->captured[1][ Message::FROM ], 'the trailing re-emit is minted here and stamps FROM' );
	}

	public function test_fire_forgets_a_payload_that_went_quiet(): void {
		$this->node->fill( $this->value_message( 'one_shot' ) );

		Core::$now = 1000061.0;
		$this->node->fire();
		$this->assertCount( 1, $this->sink->captured, 'no re-emit without a fresher arrival' );

		// The window is clear again: the same payload forwards as new.
		$this->node->fill( $this->value_message( 'one_shot' ) );
		$this->assertCount( 2, $this->sink->captured );
	}

	public function test_state_survives_a_worker_restart_and_still_re_emits(): void {
		// The stale-cache case: the trailing emit meters post-processing, so the
		// window maps must ride the Consumer's snapshot frame across a respawn.
		$this->node->fill( $this->value_message( 'warm_homepage' ) );
		Core::$now = 1000050.0;
		$this->node->fill( $this->value_message( 'warm_homepage' ) );

		// Worker dies; a successor restores the co-committed state.
		$successor = new Capture_Sink_Node();
		$restored  = new \Newspack_Nodes\Value_Timeout_Node();
		$restored->name( 'value-gate-2' );
		$restored->sink( $successor );
		$restored->arguments( [ '60', '300' ] );
		$restored->restore_state( $this->node->save_state() );

		Core::$now = 1000061.0;
		$restored->fire();

		$this->assertSame( [ "warm_homepage\n" ], array_map( static fn ( $m ) => $m[ Message::VALUE ], $successor->captured ), 'the trailing re-emit must survive the restart' );
	}

	/**
	 * A positive sub-millisecond sweep cadence must never truncate to an own
	 * 0 ms slot, whose next_fire never exceeds now: the drain then stops
	 * sleeping and fires the node on every iteration. Assert the MODE too — a
	 * fix that floored the number but stayed on its own slot would still spin.
	 */
	public function test_arguments_floors_subsecond_interval_onto_the_router_hitchhike(): void {
		$this->node->arguments( [ '60', '300', '0.0005' ] );

		$mode = ( new \ReflectionObject( $this->node ) )->getProperty( 'mode' );
		$this->assertSame( 1000, $this->node->interval_ms );
		$this->assertSame( 'router', $mode->getValue( $this->node ) );
	}

	public function test_arguments_rejects_non_numeric_interval(): void {
		$this->expectException( \InvalidArgumentException::class );

		$this->node->arguments( [ '60', '300', 'gerbil' ] );
	}

	/** A zero token still derives the default sweep from timeout, as the original's `||=` did. */
	public function test_arguments_zero_interval_takes_the_derived_default(): void {
		$this->node->arguments( [ '120', '300', '0' ] );

		$this->assertSame( 2000, $this->node->interval_ms );
	}

	public function test_defaults_match_tachikoma(): void {
		$node = new Value_Timeout_Node();
		$node->name( 'value-gate-defaults' );
		$node->arguments( [] );
		$this->assertSame( 900, $node->timeout() );
		$this->assertSame( 3300, $node->expires() );
	}
}
