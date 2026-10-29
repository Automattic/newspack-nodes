<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Callback_Node;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Delay_Node;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_Should_Stop;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * The Delay node: a struct carrying `not_before` parks on the node's own
 * Partition, and a recurring sweep sends each due entry to target, drops
 * one parked longer than `max_age_s`, and circulates the rest before the
 * cursor commits.
 */
#[CoversClass( Delay_Node::class )]
class DelayNodeTest extends TestCase {
	private const NAME = 'later-5521';

	private const TARGET = 'later-sink-8813';

	/** The parking clock every test starts from, far from the wall clock. */
	private const T0 = 1_900_000_123.5;

	private string $tmp;

	private Router_Node $router;

	private Command_Interpreter_Node $ci;

	private Capture_Sink_Node $sink;

	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
		$this->tmp    = $this->make_temp_dir( 'newspack-delay-test-' );
		$this->use_base_dir( $this->tmp );
		$this->router = new Router_Node();
		$this->router->name( Node_Names::ROUTER );
		$this->ci = new Command_Interpreter_Node();
		$this->ci->name( Node_Names::COMMAND_INTERPRETER );
		$this->ci->sink( $this->router );
		$this->sink = new Capture_Sink_Node();
		$this->sink->name( self::TARGET );
		Core::$var['partition'] = '3';
		$this->at( self::T0 );
	}

	protected function tearDown(): void {
		Partition_Node::$fwrite = null;
		unset( Core::$var['partition'] );
		Topology_Registry::reset();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		Config::reset();
		parent::tearDown();
	}

	/** Build the Delay a worker's topology builds: three per-partition dirs, target wired. */
	private function delay( string ...$tail ): Delay_Node {
		$node = $this->ci->make_node(
			'Delay',
			self::NAME,
			"{$this->tmp}/logs/later.p{partition}",
			"{$this->tmp}/offsets/later-sweep.p{partition}",
			"{$this->tmp}/deadletter/later-sweep.p{partition}",
			...( [] === $tail ? [ '45', '7200' ] : $tail )
		);
		$this->assertInstanceOf( Delay_Node::class, $node );
		$node->target( self::TARGET );
		return $node;
	}

	/** Fix the node clock at $t. */
	private function at( float $t ): void {
		Core::$clock = static fn (): float => $t;
		Core::right_now();
	}

	/** Run one sweep on the timer at $t. */
	private function sweep_at( Delay_Node $delay, float $t ): void {
		$this->at( $t );
		$delay->fire_cb();
	}

	/** @param array<string,mixed> $value */
	private function park( Delay_Node $delay, array $value, string $key = '' ): void {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::FROM ]  = 'parker-4417';
		$m[ Message::KEY ]   = $key;
		$m[ Message::VALUE ] = $value;
		$delay->fill( $m );
	}

	/** Replace the capture sink with a closure answering for the target. */
	private function target_does( \Closure $fn ): void {
		$this->sink->remove_node();
		( new Callback_Node( $fn ) )->name( self::TARGET );
	}

	/** @return list<array<int,mixed>> Every message on the queue, oldest first. */
	private function queued_messages(): array {
		$queue = Core::node( self::NAME . ':queue' );
		$this->assertInstanceOf( Partition_Node::class, $queue );
		$queue->flush();
		$out      = [];
		$segments = \glob( "{$this->tmp}/logs/later.p3/*.log" );
		\natsort( $segments );
		foreach ( $segments as $segment ) {
			foreach ( \explode( "\n", \rtrim( (string) \file_get_contents( $segment ), "\n" ) ) as $line ) {
				if ( '' !== $line ) {
					$out[] = Message::unpacked( $line );
				}
			}
		}
		return $out;
	}

	/** @return list<mixed> Every entry on the queue, oldest first. */
	private function queued(): array {
		return \array_map( static fn ( array $m ): mixed => $m[ Message::VALUE ], $this->queued_messages() );
	}

	/** @return list<mixed> The VALUE of every message the target received. */
	private function delivered(): array {
		return \array_map( static fn ( array $m ): mixed => $m[ Message::VALUE ], $this->sink->captured );
	}

	/** @return list<string> Every quarantined file under the sweep's dead-letter dir. */
	private function dead_letters(): array {
		return \glob( "{$this->tmp}/deadletter/later-sweep.p3/*.log" ) ?: [];
	}

	public function test_park_stamps_parked_at_from_the_node_clock(): void {
		$delay = $this->delay();

		$this->park( $delay, [ 'item' => 'a-77', 'not_before' => self::T0 + 500 ] );

		$this->assertSame(
			[ [ 'item' => 'a-77', 'not_before' => self::T0 + 500, 'parked_at' => self::T0 ] ],
			$this->queued()
		);
	}

	public function test_a_repark_keeps_its_parked_at(): void {
		$delay = $this->delay();

		$this->park( $delay, [ 'item' => 'b-19', 'not_before' => self::T0 + 500, 'parked_at' => 1_899_990_001.25 ] );

		$this->assertSame( 1_899_990_001.25, $this->queued()[0]['parked_at'] );
	}

	/** ADR-6: a Delay in front of a Topic must hand on the KEY it parked with. */
	public function test_the_key_is_parked_and_delivered(): void {
		$delay = $this->delay();
		$this->park( $delay, [ 'item' => 'k-62', 'not_before' => self::T0 + 30 ], 'affkey-3307' );

		$this->assertSame( 'affkey-3307', $this->queued_messages()[0][ Message::KEY ] );

		$this->sweep_at( $delay, self::T0 + 60 );
		$this->assertSame( 'affkey-3307', $this->sink->captured[0][ Message::KEY ] );
	}

	public function test_a_due_entry_reaches_the_target_with_parked_at_and_without_not_before(): void {
		$delay = $this->delay();
		$this->park( $delay, [ 'item' => 'c-31', 'n' => 4, 'not_before' => self::T0 + 30 ] );

		$this->sweep_at( $delay, self::T0 + 60 );

		$this->assertSame( [ [ 'item' => 'c-31', 'n' => 4, 'parked_at' => self::T0 ] ], $this->delivered() );
		$message = $this->sink->captured[0];
		$this->assertSame( Message::TM_STRUCT, $message[ Message::TYPE ] );
		$this->assertSame( self::NAME, $message[ Message::FROM ] );

		$this->sweep_at( $delay, self::T0 + 200 );
		$this->assertCount( 1, $this->delivered(), 'a delivered entry is not delivered again' );
	}

	/** A target that parks an entry again keeps its first park, so max_age_s bounds the wait. */
	public function test_an_entry_the_target_parks_again_ages_out_from_its_first_park(): void {
		$errors = $this->capture_stderr();
		$delay  = $this->delay();
		$tries  = [];
		$this->target_does(
			static function ( array $message ) use ( $delay, &$tries ): void {
				$entry               = $message[ Message::VALUE ];
				$tries[]             = $entry['parked_at'];
				$entry['not_before'] = Core::$now + 1000;
				$again               = Message::new_message();
				$again[ Message::TYPE ]  = Message::TM_STRUCT;
				$again[ Message::VALUE ] = $entry;
				$delay->fill( $again );
			}
		);
		$this->park( $delay, [ 'item' => 'm-44', 'not_before' => self::T0 + 30 ] );

		foreach ( [ 60, 1100, 2200, 3300, 4400, 5500, 6600, 7700, 8800 ] as $offset ) {
			$this->sweep_at( $delay, self::T0 + $offset );
		}

		$this->assertSame( \array_fill( 0, 7, self::T0 ), $tries, 'every retry carries the first park time' );
		$this->assertCount( 1, self::stderr_lines( $errors, 'parked past max_age 7200s' ) );
	}

	public function test_a_future_entry_circulates_and_delivers_on_a_later_sweep(): void {
		$delay = $this->delay();
		$this->park( $delay, [ 'item' => 'd-58', 'not_before' => self::T0 + 600 ] );

		$this->sweep_at( $delay, self::T0 + 60 );
		$this->assertSame( [], $this->delivered() );

		$this->sweep_at( $delay, self::T0 + 700 );
		$this->assertSame( [ [ 'item' => 'd-58', 'parked_at' => self::T0 ] ], $this->delivered() );

		$this->sweep_at( $delay, self::T0 + 800 );
		$this->assertCount( 1, $this->delivered(), 'circulation never duplicates an entry' );
	}

	public function test_an_entry_parked_longer_than_max_age_drops_with_a_line(): void {
		$errors = $this->capture_stderr();
		$delay  = $this->delay();
		$this->park( $delay, [ 'item' => 'e-90', 'not_before' => self::T0 + 100000 ], "age-key-\x1b[31m" . \str_repeat( 'k', 300 ) );

		$this->sweep_at( $delay, self::T0 + 7100 );
		$this->assertSame( [], self::stderr_lines( $errors, 'max_age' ), 'not yet over age' );

		$this->sweep_at( $delay, self::T0 + 7300 );
		$this->sweep_at( $delay, self::T0 + 200000 );

		$this->assertSame( [], $this->delivered() );
		$lines = self::stderr_lines( $errors, 'parked past max_age 7200s' );
		$this->assertCount( 1, $lines );
		$this->assertStringContainsString( "keyed 'age-key-", $lines[0], 'the line names the KEY' );
		$this->assertStringNotContainsString( "\x1b", $lines[0], 'a KEY cannot drive the terminal' );
		$this->assertStringNotContainsString( \str_repeat( 'k', 300 ), $lines[0], 'a long KEY is cut' );
	}

	/** A delivery that throws inside a Router tick never escapes it, and retries next sweep. */
	public function test_a_target_that_throws_does_not_escape_the_router_tick(): void {
		$errors   = $this->capture_stderr();
		$delay    = $this->delay();
		$refusals = 1;
		$received = [];
		$this->target_does(
			static function ( array $message ) use ( &$refusals, &$received ): void {
				if ( $refusals-- > 0 ) {
					throw new \RuntimeException( 'target refused 6620' );
				}
				$received[] = $message[ Message::VALUE ]['item'];
			}
		);
		$this->park( $delay, [ 'item' => 'f-due', 'not_before' => self::T0 + 10 ] );

		$this->at( self::T0 + 60 );
		$this->router->fire_cb();

		$this->assertSame( [], $received );
		$this->assertNotSame( [], self::stderr_lines( $errors, 'target refused 6620' ), 'the failure is reported' );

		$this->sweep_at( $delay, self::T0 + 120 );
		$this->assertSame( [ 'f-due' ], $received, 'the held entry is due again on the next sweep' );
	}

	/** ADR-12: failing passes commit gracefully, so no crawl ever sacrifices a held entry. */
	public function test_five_failing_sweeps_lose_nothing_and_dead_letter_nothing(): void {
		$this->capture_stderr();
		$delay    = $this->delay();
		$failing  = true;
		$received = [];
		$this->target_does(
			static function ( array $message ) use ( &$failing, &$received ): void {
				if ( $failing ) {
					throw new \RuntimeException( 'target down 1187' );
				}
				$received[] = $message[ Message::VALUE ]['item'];
			}
		);
		$this->park( $delay, [ 'item' => 'n-held', 'not_before' => self::T0 + 600 ] );
		$this->park( $delay, [ 'item' => 'n-due', 'not_before' => self::T0 + 10 ] );

		foreach ( [ 60, 120, 180, 240, 300 ] as $offset ) {
			$this->sweep_at( $delay, self::T0 + $offset );
		}
		$failing = false;
		$this->sweep_at( $delay, self::T0 + 700 );

		\sort( $received );
		$this->assertSame( [ 'n-due', 'n-held' ], $received );
		$this->assertSame( [], $this->dead_letters() );
	}

	/** ADR-14: a stop escapes, and the entries the pass had read replay. */
	public function test_a_cooperative_stop_escapes_and_the_whole_pass_replays(): void {
		$delay    = $this->delay();
		$stops    = 1;
		$received = [];
		$this->target_does(
			static function ( array $message ) use ( &$stops, &$received ): void {
				if ( $stops-- > 0 ) {
					throw new Worker_Should_Stop( 'stop 3390' );
				}
				$received[] = $message[ Message::VALUE ]['item'];
			}
		);
		$this->park( $delay, [ 'item' => 'g-held', 'not_before' => self::T0 + 600 ] );
		$this->park( $delay, [ 'item' => 'g-due', 'not_before' => self::T0 + 10 ] );

		$this->at( self::T0 + 60 );
		$caught = $this->caught( static fn () => $delay->fire_cb(), 'a stop escapes the sweep' );
		$this->assertInstanceOf( Worker_Should_Stop::class, $caught );

		$this->sweep_at( $delay, self::T0 + 120 );
		$this->assertSame( [ 'g-due' ], $received );
		$this->sweep_at( $delay, self::T0 + 700 );
		$this->assertSame( [ 'g-due', 'g-held' ], $received, 'the entry held before the stop survived it' );
	}

	/** The re-append lands before the cursor commits; one that fails replays the pass. */
	public function test_a_failed_re_append_replays_the_pass(): void {
		$delay = $this->delay();
		$this->park( $delay, [ 'item' => 'r-held', 'not_before' => self::T0 + 600 ] );
		$this->queued();
		Partition_Node::$fwrite = static fn ( $fh, string $bytes ): int|false => \str_contains( \stream_get_meta_data( $fh )['uri'], '/logs/later.p3' ) ? false : \fwrite( $fh, $bytes );

		$this->at( self::T0 + 60 );
		$this->caught( static fn () => $delay->fire_cb(), 'a re-append that cannot write escapes' );
		Partition_Node::$fwrite = null;

		$this->sweep_at( $delay, self::T0 + 700 );
		$this->assertSame( [ [ 'item' => 'r-held', 'parked_at' => self::T0 ] ], $this->delivered() );
	}

	public function test_anything_but_a_struct_with_a_numeric_not_before_drops_with_a_line(): void {
		$errors = $this->capture_stderr();
		$delay  = $this->delay();
		$bytes  = Message::new_message();
		$bytes[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$bytes[ Message::VALUE ] = 'h-bytes';
		$delay->fill( $bytes );
		$this->park( $delay, [ 'item' => 'h-bare' ] );
		$this->park( $delay, [ 'item' => 'h-word', 'not_before' => 'soon' ] );

		$this->assertSame( [], $this->queued() );
		$this->assertNotSame( [], self::stderr_lines( $errors, 'no numeric not_before' ) );
	}

	/** ADR-12: a torn line goes to the reader's quarantine and the entries around it deliver. */
	public function test_a_torn_line_is_dead_lettered_and_the_entries_around_it_deliver(): void {
		$delay = $this->delay();
		$this->park( $delay, [ 'item' => 'i-before', 'not_before' => self::T0 + 20 ] );
		$this->queued();
		\file_put_contents( "{$this->tmp}/logs/later.p3/0.log", "torn-4471{\"k\":\"x\n", \FILE_APPEND );
		$this->park( $delay, [ 'item' => 'i-after', 'not_before' => self::T0 + 40 ] );

		$this->sweep_at( $delay, self::T0 + 90 );

		$this->assertSame( [ 'i-before', 'i-after' ], \array_column( $this->delivered(), 'item' ) );
		$this->assertCount( 1, $this->dead_letters() );
		$this->assertStringContainsString( 'torn-4471', (string) \file_get_contents( $this->dead_letters()[0] ) );
	}

	/**
	 * Entry sizes around the half segment: two to a segment, one to a
	 * segment, and a burst of small ones.
	 *
	 * @return array<string,array{0:int,1:int,2:bool}>
	 */
	public static function queue_loads(): array {
		return [
			'two to a 1 MiB segment' => [ 520000, 11, false ],
			'one to a 1 MiB segment' => [ 530000, 11, false ],
			'a burst of 100 KB'      => [ 100000, 120, true ],
		];
	}

	/**
	 * The hard cap prunes by segment count, so no park, between sweeps or in
	 * one, may leave the reader more unread segments than it keeps: what a
	 * pass keeps is delivered, oldest first, and what it cannot keep drops
	 * loud, naming its KEY.
	 */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'queue_loads' )]
	public function test_no_park_lets_the_hard_cap_prune_an_unread_segment( int $bytes, int $count, bool $overflows ): void {
		$errors  = $this->capture_stderr();
		$delay   = $this->delay();
		$payload = \str_repeat( 'x', $bytes );
		for ( $i = 0; $i < $count; $i++ ) {
			$this->park( $delay, [ 'item' => $i, 'not_before' => self::T0 + 600, 'pad' => $payload ], "cap-key-{$i}" );
		}

		$this->sweep_at( $delay, self::T0 + 60 );
		$this->sweep_at( $delay, self::T0 + 700 );

		$items = \array_column( $this->delivered(), 'item' );
		$this->assertNotSame( [], $items );
		$this->assertSame( \range( 0, \count( $items ) - 1 ), $items, 'what a pass keeps arrives whole, oldest first' );
		$this->assertSame( $overflows, \count( $items ) < $count, 'only a load past the cap drops' );
		if ( $overflows ) {
			$this->assertMatchesRegularExpression( "/queue full.*'cap-key-\\d+'/", \implode( "\n", self::stderr_lines( $errors, 'queue full' ) ) );
		}
	}

	/**
	 * Right after a respawn, before any sweep, the queue counts what is
	 * unread from the committed cursor, not from its oldest segment.
	 */
	public function test_a_park_right_after_a_respawn_counts_from_the_committed_cursor(): void {
		$delay   = $this->delay();
		$payload = \str_repeat( 'x', 530000 );
		for ( $round = 1; $round <= 9; $round++ ) {
			$this->park( $delay, [ 'item' => "fill-{$round}a", 'not_before' => self::T0 + 10, 'pad' => $payload ] );
			$this->park( $delay, [ 'item' => "fill-{$round}b", 'not_before' => self::T0 + 10, 'pad' => $payload ] );
			$this->sweep_at( $delay, self::T0 + 60 * $round );
		}
		$this->assertCount( 8, \glob( "{$this->tmp}/logs/later.p3/*.log" ), 'the queue keeps its hard cap of segments' );
		$this->assertCount( 18, $this->delivered() );
		$delay->remove_node();

		$delay = $this->delay();
		$this->park( $delay, [ 'item' => 'after-respawn', 'not_before' => self::T0 + 99999 ], 'respawn-key-3' );

		$queued = $this->queued_messages();
		$this->assertSame( 'after-respawn', \end( $queued )[ Message::VALUE ]['item'] ?? null );
	}

	public function test_remove_node_lets_go_of_the_queue(): void {
		$delay = $this->delay();

		$delay->remove_node();

		$this->assertNull( Core::node( self::NAME . ':queue' ) );
		$this->assertNull( $this->read_private( $delay, 'queue' ) );
	}

	public function test_the_arguments_round_trip_through_dump_config(): void {
		$delay = $this->delay();

		$this->assertStringStartsWith(
			"make_node Delay later-5521 {$this->tmp}/logs/later.p{partition} {$this->tmp}/offsets/later-sweep.p{partition} {$this->tmp}/deadletter/later-sweep.p{partition} 45 7200\n",
			$delay->dump_config()
		);
	}

	public function test_the_sweep_rides_a_recurring_timer_at_interval_s(): void {
		$delay = $this->delay();

		$this->assertSame( 45000, $delay->interval_ms );
		$this->assertFalse( $delay->oneshot );
	}

	public function test_the_queue_takes_low_volume_geometry_with_max_age_s_as_its_lifetime(): void {
		$this->delay();

		$queue = Core::node( self::NAME . ':queue' );
		$this->assertSame( 1048576, $this->read_private( $queue, 'segment_size' ) );
		$this->assertSame( 4, $this->read_private( $queue, 'num_segments' ) );
		$this->assertSame( 7200, $this->read_private( $queue, 'min_lifetime' ) );
		$this->assertSame( 7200, $this->read_private( $queue, 'lifetime' ) );
	}

	public function test_the_schema_declares_the_defaults(): void {
		$delay = $this->delay( '', '' );

		$this->assertSame( Delay_Node::DEFAULT_INTERVAL_S * 1000, $delay->interval_ms );
		$this->assertSame( Delay_Node::DEFAULT_MAX_AGE_S, $this->read_private( Core::node( self::NAME . ':queue' ), 'lifetime' ) );
	}

	public function test_a_dir_naming_no_partition_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'offsets_dir names no {partition}' );
		$this->ci->make_node(
			'Delay',
			self::NAME,
			"{$this->tmp}/logs/later.p{partition}",
			"{$this->tmp}/offsets/later-sweep",
			"{$this->tmp}/deadletter/later-sweep.p{partition}"
		);
	}

	public function test_a_max_age_below_one_second_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'max_age_s' );
		$this->delay( '45', '0' );
	}

	/** `wp nodes gc` keeps what an active topology's write set declares. */
	public function test_the_write_set_claims_the_queue_and_the_reader_s_dirs(): void {
		$this->stock_topology_dir( 'delay-stock-' );
		$this->write_tsl( 'later-lab', "make_node Delay later-5521 <config:logs_dir>/later.p{partition} <config:offsets_dir>/later-sweep.p{partition} <config:deadletter_dir>/later-sweep.p{partition}\n" );

		$this->assertSame(
			[
				'deadletter:<config:deadletter_dir>/later-sweep.p{partition}',
				'offsetlog:<config:offsets_dir>/later-sweep.p{partition}',
				'partition:<config:logs_dir>/later.p{partition}',
			],
			Topology_Analyzer::write_set( 'later-lab' )
		);
	}
}
