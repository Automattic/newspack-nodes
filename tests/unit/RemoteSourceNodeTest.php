<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Remote_Source_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * Downstream relay sink: records forwards, throws on a `boom`-keyed message (poison), and
 * raises Worker_Should_Stop on a `stop`-keyed one (a cooperative deadline mid-forward).
 */
class Relay_Sink_Spy extends Node {
	/** @var array<int,array<int,mixed>> */
	public array $captured = [];
	public int $fill_count = 0;

	public function fill( array $message ): void {
		++$this->fill_count;
		$key = Core::as_string( $message[ Message::KEY ] );
		if ( 'boom' === $key ) {
			throw new \RuntimeException( 'downstream boom' );
		}
		if ( 'stop' === $key ) {
			throw new Worker_Should_Stop( 'cooperative stop' );
		}
		$this->captured[] = $message;
	}
}

#[CoversClass( Remote_Source_Node::class )]
class RemoteSourceNodeTest extends TestCase {

	private string $base_dir = '';

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir();
		$this->use_base_dir( $this->base_dir );
		Core::$memd = new InMemoryMemcached();
		// Remote_Source arms a 1000ms TICK timer that router-hitchhikes (>=1000),
		// which needs _router present — as it always is in a live graph.
		( new Router_Node() )->name( '_router' );
	}

	protected function tearDown(): void {
		Command_Auth::forget_session( 'austin' );
		Core::$memd                = null;
		SSE_In_Node::$curl_dispatch = null;
		HTTP_Out_Node::$curl_dispatch = null;
		// The SSE_In patrons register easy cURL handles on the process-lifetime
		// Event_Framework singleton; reset it so handles don't leak into later suites.
		Event_Framework::reset();
		Vault::get_instance()->reset_cache();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	private function seed_vault( string $id, array $entry ): void {
		// A spoke that can be sent to has authed; the heartbeat signs for it.
		Command_Auth::remember_session( $id, \str_repeat( 'b', 32 ), 'spoke-session-key' );
		\update_option( Vault::OPTION_KEY, [ $id => $entry ] );
		Vault::get_instance()->reset_cache();
	}

	/**
	 * Build a named Remote_Source wired to a capture sink + downstream target.
	 *
	 * @param list<string>|null $args Positional ctor tokens (null = derive via remote_args).
	 */
	private function make_remote( string $name = 'remote-austin', ?array $args = null ): array {
		$args ??= $this->remote_args( $name );
		$node   = new Remote_Source_Node();
		$node->name( $name );
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$node->sink( $sink );
		$node->target( 'downstream' );
		$node->arguments( $args );
		return [ $node, $sink ];
	}

	// ---------------------------------------------------------------------
	// Task 4 — skeleton: args, patron creation, Vault resolution, schema.
	// ---------------------------------------------------------------------

	public function test_poll_runs_every_tick_while_housekeeping_latches(): void {
		$node = new class() extends Remote_Source_Node {
			public int $polls = 0;
			public int $housekeeping_runs = 0;
			public function poll(): void {
				++$this->polls;
			}
			protected function publish_status(): void {
				++$this->housekeeping_runs;
			}
			protected function should_connect(): bool {
				return true;
			}
		};
		$node->name( 'src-a' );
		$ref = new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' );
		$ref->setValue( $node, new \Newspack_Nodes\SSE_In_Node() );

		Core::$now = 2000.0;
		$node->fire();
		$node->fire();
		$node->fire();
		$this->assertSame( 3, $node->polls, '10Hz fast path: poll every tick' );
		$this->assertSame( 1, $node->housekeeping_runs, 'housekeeping latched to the wall-second' );
	}

	/**
	 * The two transports are owned siblings, so a rename carries them. Left
	 * inline, `{old}:sse-in` and `{old}:http-out` stay registered under a
	 * spelling nothing resolves while `{new}:sse-in` resolves to null.
	 */
	public function test_renaming_a_connected_source_moves_its_transports(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$sse  = Core::node( 'remote-austin:sse-in' );
		$http = Core::node( 'remote-austin:http-out' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertInstanceOf( HTTP_Out_Node::class, $http );

		$node->name( 'remote-galveston' );

		$this->assertSame( $sse, Core::node( 'remote-galveston:sse-in' ) );
		$this->assertSame( $http, Core::node( 'remote-galveston:http-out' ) );
		$this->assertNull( Core::node( 'remote-austin:sse-in' ) );
		$this->assertNull( Core::node( 'remote-austin:http-out' ) );
		// target is a stored STRING; the moved Null needs re-addressing.
		$this->assertSame( 'remote-galveston:null', $http->target() );
	}

	/**
	 * A refused transport name must leave every slot empty, or `ensure_patrons()`
	 * hands back an unnamed SSE_In on every later tick — one reading the spoke
	 * while the registry, `ls` and `command_node` all see nothing.
	 */
	public function test_a_refused_transport_name_caches_no_patron(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example' ] );
		$squatter = new Capture_Sink_Node();
		$squatter->name( 'remote-austin:http-out' );
		[ $node ] = $this->make_remote( 'remote-austin' );

		try {
			$node->fire();
			$this->fail( 'expected the squatted http-out slot to be refused' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'remote-austin:http-out already registered', $e->getMessage() );
		}

		$this->assertNull( $this->read_private( $node, 'sse_in' ) );
	}

	public function test_arguments_parses_positional_tokens(): void {
		[ $node ] = $this->make_remote();
		$this->assertSame( 'austin', $this->read_private( $node, 'vault_id' ) );
		$this->assertSame( 'firehose.p0', $this->read_private( $node, 'remote_partition' ) );
	}

	public function test_arguments_arms_recurring_timer(): void {
		[ $node ] = $this->make_remote();
		$this->assertGreaterThan( 0, $node->interval_ms );
		$this->assertFalse( $node->oneshot );
	}

	public function test_valve_backpressures_only_on_buffer_water_marks(): void {
		// Edge-triggered buffer management: DISARM only when the buffer crosses above
		// high-water, RE-ARM only when it drains back below low-water. The valve stays
		// OPEN through normal flow (the old disarm-on-every-line gate stop-started the
		// spoke and lagged the hub 10-20s). No disarm on an empty buffer, no arm per poll.
		[ $node ] = $this->make_remote();
		$sse = new class() extends SSE_In_Node {
			public int $arms    = 0;
			public int $disarms = 0;
			public function arm(): void {
				++$this->arms; }
			public function disarm(): void {
				++$this->disarms; }
		};
		( new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' ) )->setValue( $node, $sse );
		$buffer = new \ReflectionProperty( \Newspack_Nodes\Remote_Source_Node::class, 'buffer' );
		$armed  = new \ReflectionProperty( \Newspack_Nodes\Remote_Source_Node::class, 'pump_armed' );
		$disarm = new \ReflectionMethod( $node, 'pump_maybe_disarm' );
		$arm    = new \ReflectionMethod( $node, 'pump_maybe_arm' );

		// Armed + below high-water: valve stays open (continuous flow).
		$armed->setValue( $node, true );
		$buffer->setValue( $node, \str_repeat( 'x', 100 * 1024 ) );
		$disarm->invoke( $node );
		$this->assertSame( 0, $sse->disarms, 'below high-water stays armed' );

		// Armed + above high-water: disarm once (backpressure).
		$buffer->setValue( $node, \str_repeat( 'x', 600 * 1024 ) );
		$disarm->invoke( $node );
		$this->assertSame( 1, $sse->disarms );
		$this->assertFalse( $armed->getValue( $node ), 'disarm flips the valve state' );

		// Disarmed + still above low-water: NO re-arm (hysteresis band).
		$buffer->setValue( $node, \str_repeat( 'x', 300 * 1024 ) );
		$arm->invoke( $node );
		$this->assertSame( 0, $sse->arms, 'above low-water does not re-arm' );

		// Disarmed + drained below low-water: re-arm.
		$buffer->setValue( $node, \str_repeat( 'x', 10 * 1024 ) );
		$arm->invoke( $node );
		$this->assertSame( 1, $sse->arms, 're-arm once drained below low-water' );

		// Armed + empty buffer: NO idle disarm, NO redundant arm-on-poll.
		$buffer->setValue( $node, '' );
		$arm->invoke( $node );
		$disarm->invoke( $node );
		$this->assertSame( 1, $sse->arms, 'no arm-on-poll when already armed' );
		$this->assertSame( 1, $sse->disarms, 'no disarm on an empty buffer' );
	}

	public function test_first_tick_creates_and_configures_sse_in_patron(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $sink ] = $this->make_remote( 'remote-austin' );

		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertSame( 'https://austin.example', $this->read_private( $sse, 'url' ) );
		$this->assertSame( 'u', $this->read_private( $sse, 'auth_username' ) );
		$this->assertSame( 'firehose.p0', $this->read_private( $sse, 'subscribe' ) );
		// SSE_In hands each raw `msg` payload to the Remote_Source's delivery seam, which
		// appends it to the Durable_Reader buffer (a poison line is quarantined on drain).
		// The target for forward_line's TO belongs to THIS node; SSE_In never reads one.
		$this->assertInstanceOf( \Closure::class, $sse->on_message, 'the raw-delivery seam is wired' );
		$this->assertSame( 'downstream', $this->read_private( $node, 'target' ) );
	}

	// ---------------------------------------------------------------------
	// Multi-writer seal-grace — Consumer's verb, asserted over the wire.
	// ---------------------------------------------------------------------

	public function test_the_committed_cursor_names_the_next_unread_record(): void {
		// The cursor must mean what Consumer's means: the next UNREAD position.
		// Pinned at the last-forwarded record's start instead, every resume
		// re-delivers that one record — the hub writes it twice, adjacent, with
		// the same crumb, while the spoke's own log holds it once.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $sink ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		// Two records, the crumbs chaining exactly as a partition lays them out.
		$this->deliver( $sse, '7:100:60' );
		$this->deliver( $sse, '7:160:40' );

		$this->assertCount( 2, $sink->captured, 'both forwarded' );
		$this->assertSame(
			[ 7, 200 ],
			[ $this->read_private( $node, 'cursor_segment' ), $this->read_private( $node, 'cursor_offset' ) ],
			'the cursor sits PAST the last record (160 + 40), not on its start'
		);
	}

	// ---------------------------------------------------------------------
	// Seek sentinels — a push source has no segments, so it forwards the seek
	// to the spoke, which does.
	// ---------------------------------------------------------------------

	public function test_a_bare_seek_is_forwarded_to_the_spoke(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$sse->restore_position( 3, 900 ); // a pair the seek must override

		$node->next_offset( Consumer_Node::SEEK_RECENT );
		// A seek waits for the spoke to resolve it, and the reconnect is throttled to the
		// wall second — so the seek must survive the ticks in between. The per-tick cursor
		// handoff would otherwise answer it with the very position it was asked to leave.
		$node->fire();
		$node->fire();

		$captured = [];
		SSE_In_Node::$curl_dispatch = function ( array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		$this->assertTrue( $sse->maybe_connect() );
		\parse_str( (string) \parse_url( $captured[0][ \CURLOPT_URL ], PHP_URL_QUERY ), $query );
		$positions = \json_decode( $query['positions'], true );
		$this->assertSame( Consumer_Node::SEEK_RECENT, $positions['firehose.p0'] );
	}

	public function test_a_seek_word_forwards_the_same_sentinel(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		( new \ReflectionProperty( Remote_Source_Node::class, 'buffer' ) )
			->setValue( $node, "stale, and about to be seeked away from\n" );

		$node->next_offset( 'end' );

		$captured = [];
		SSE_In_Node::$curl_dispatch = function ( array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		$this->assertTrue( $sse->maybe_connect() );
		\parse_str( (string) \parse_url( $captured[0][ \CURLOPT_URL ], PHP_URL_QUERY ), $query );
		$this->assertSame( Consumer_Node::SEEK_END, \json_decode( $query['positions'], true )['firehose.p0'] );
		$this->assertSame( '', $this->read_private( $node, 'buffer' ), 'a seek abandons what was in flight' );
	}

	public function test_seal_grace_seeds_a_patron_created_after_the_verb(): void {
		// The aggregator configures its spokes before anything connects, so the
		// flag has to survive until the patron exists.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->set_multi_writer( true );

		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertTrue( $this->read_private( $sse, 'multi_writer' ) );
	}

	public function test_seal_grace_reaches_a_live_patron_and_drops_the_stream(): void {
		// It rides a connect-time query parameter, so the current stream has to
		// go for the far-side reader to pick the change up.
		[ $node ] = $this->make_remote();
		$sse = new class() extends SSE_In_Node {
			public ?bool $seal_grace = null;
			public int $disconnects  = 0;
			public function set_multi_writer( bool $flag ): void {
				$this->seal_grace = $flag; }
			public function disconnect(): void {
				++$this->disconnects; }
		};
		( new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' ) )->setValue( $node, $sse );

		$node->set_multi_writer( true );

		$this->assertTrue( $sse->seal_grace );
		$this->assertSame( 1, $sse->disconnects, 'the stream is re-established to carry the new parameter' );
	}

	public function test_dropping_the_stream_discards_the_undrained_buffer(): void {
		// SSE_In's resume position only advances after a successful forward, so
		// anything still buffered sits AHEAD of it and the spoke re-sends it on
		// reconnect. Keeping the buffer would forward those lines twice.
		[ $node ] = $this->make_remote();
		$sse      = $this->seal_grace_spy();
		$sse->restore_position( 0, 512 ); // forwarded this far; the spoke replays from here
		( new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' ) )
			->setValue( $node, $sse );
		$buffer = new \ReflectionProperty( Remote_Source_Node::class, 'buffer' );
		$buffer->setValue( $node, "an undrained line\n" );

		$node->set_multi_writer( true );

		$this->assertSame( '', $buffer->getValue( $node ) );
	}

	public function test_a_stream_that_never_forwarded_keeps_its_buffer(): void {
		// A {0,0} cursor sends no `positions` at all, so the spoke tail-seeks to
		// `end` and replays NOTHING — the buffer is then the only copy of those
		// records, and dropping it loses them outright rather than duplicating.
		[ $node ] = $this->make_remote();
		( new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' ) )
			->setValue( $node, $this->seal_grace_spy() );
		$buffer = new \ReflectionProperty( Remote_Source_Node::class, 'buffer' );
		$buffer->setValue( $node, "the only copy\n" );

		$node->set_multi_writer( true );

		$this->assertSame( "the only copy\n", $buffer->getValue( $node ) );
	}

	public function test_reasserting_the_same_seal_grace_leaves_the_stream_up(): void {
		// The verb is what an operator or an idempotent apply script invokes, and
		// re-asserting a value the source already holds should cost nothing.
		[ $node ] = $this->make_remote();
		$sse = $this->seal_grace_spy();
		( new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' ) )->setValue( $node, $sse );
		$node->set_multi_writer( true );

		$node->set_multi_writer( true );

		$this->assertSame( 1, $sse->disconnects, 'only the change drops the stream' );
	}

	public function test_an_arriving_line_takes_the_busy_cadence_immediately(): void {
		// A push source learns of data in on_message, during the curl drain —
		// between fires. Waiting out the channel tick to notice would put up to
		// TICK_INTERVAL_MS on the front of every arrival burst, and the busy
		// cadence at the bottom of fire() cannot help: it only runs after a fire
		// has already observed the buffer.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$tick = ( new \ReflectionClassConstant( \Newspack_Nodes\Remote_Link_Node::class, 'TICK_INTERVAL_MS' ) )->getValue();
		$this->assertSame( $tick, $node->interval_ms, 'idle at the channel tick' );

		( $sse->on_message )( 'a line off the wire' );

		$this->assertSame( 0, $node->interval_ms, 'the arrival itself schedules the drain' );
	}

	public function test_a_buffered_backlog_re_arms_for_the_next_event_cycle(): void {
		// line_mode is GRANULARITY — one line per event cycle — not a rate limit.
		// The pump's own fire() re-arms at POLL_INTERVAL_BUSY_MS (0) whenever it is
		// not at EOF; Remote_Source rides Remote_Link's 100ms CHANNEL timer, so
		// leaving that cadence in place while lines are buffered would pace a
		// backlog at 10 lines/sec however deep it is.
		[ $node, $sink ] = $this->make_remote();
		( new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' ) )
			->setValue( $node, $this->seal_grace_spy() );
		$node->set_line_mode( true );
		( new \ReflectionProperty( Remote_Source_Node::class, 'buffer' ) )
			->setValue( $node, $this->stream_lines( 5 ) );

		$node->fire();

		$this->assertCount( 1, $sink->captured, 'still one line per cycle' );
		$this->assertSame( 0, $node->interval_ms, 'and the next cycle is immediate' );
		$this->assertFalse( $node->oneshot, 'recurring, so a skipped re-arm cannot strand it' );
	}

	public function test_losing_the_patron_drops_the_busy_cadence(): void {
		// reload() -> drop_patrons() nulls sse_in. A tick that had armed the 0ms
		// busy cadence and then skips straight past the drain leaves the loop
		// spinning at full speed with nothing to do until housekeeping — latched
		// to the wall-second — rebuilds the patron.
		[ $node ] = $this->make_remote();
		$sse_in   = new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' );
		$sse_in->setValue( $node, $this->seal_grace_spy() );
		$node->set_line_mode( true ); // one line per cycle, so a backlog survives the tick
		( new \ReflectionProperty( Remote_Source_Node::class, 'buffer' ) )
			->setValue( $node, $this->stream_lines( 3 ) );
		$node->fire();
		$this->assertSame( 0, $node->interval_ms, 'armed busy while draining' );

		$sse_in->setValue( $node, null );
		$node->fire();

		$tick = ( new \ReflectionClassConstant( \Newspack_Nodes\Remote_Link_Node::class, 'TICK_INTERVAL_MS' ) )->getValue();
		$this->assertSame( $tick, $node->interval_ms, 'nothing to drain: back to the channel tick' );
	}

	public function test_an_empty_buffer_keeps_the_channel_cadence(): void {
		// Nothing to drain: fall back to the recurring tick that carries the
		// heartbeat and reconnect, rather than spinning the loop at 0ms.
		[ $node ] = $this->make_remote();
		( new \ReflectionProperty( \Newspack_Nodes\Remote_Link_Node::class, 'sse_in' ) )
			->setValue( $node, $this->seal_grace_spy() );

		$node->fire();

		$tick = ( new \ReflectionClassConstant( \Newspack_Nodes\Remote_Link_Node::class, 'TICK_INTERVAL_MS' ) )->getValue();
		$this->assertSame( $tick, $node->interval_ms );
		$this->assertFalse( $node->oneshot );
	}

	/** $count packed TM_STRUCT lines with sequential breadcrumbs, as SSE_In would buffer them. */
	private function stream_lines( int $count ): string {
		$out = '';
		for ( $i = 0; $i < $count; $i++ ) {
			$m                   = Message::new_message();
			$m[ Message::TYPE ]  = Message::TM_STRUCT;
			$m[ Message::ID ]    = '0:' . ( $i * 100 ) . ':100';
			$m[ Message::VALUE ] = [ 'n' => $i ];
			$out                .= Message::packed( $m ) . "\n";
		}
		return $out;
	}

	/** SSE_In double recording the seal-grace pushed to it and every disconnect. */
	private function seal_grace_spy(): SSE_In_Node {
		return new class() extends SSE_In_Node {
			public ?bool $seal_grace = null;
			public int $disconnects  = 0;
			public function set_multi_writer( bool $flag ): void {
				$this->seal_grace = $flag; }
			public function disconnect(): void {
				++$this->disconnects; }
		};
	}

	public function test_set_multi_writer_is_a_declared_verb(): void {
		$verbs = \array_column( Remote_Source_Node::node_schema()['commands'], 'name' );
		$this->assertContains( 'set_multi_writer', $verbs );
	}

	public function test_dump_config_roundtrips_set_multi_writer(): void {
		// A console serialize → replay that dropped the flag would silently put
		// the hub back on a reader that orphans stragglers.
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->set_multi_writer( true );

		$matched = \preg_match(
			'/command_node remote-austin:config set_multi_writer (\S+)/',
			$node->dump_config(),
			$matches
		);

		$this->assertSame( 1, $matched, 'the flag is emitted with an explicit argument' );
		$replayed = new Remote_Source_Node();
		$replayed->name( 'remote-austin-replayed' );
		$replayed->arguments( $this->remote_args( 'remote-austin-replayed' ) );
		$interpreter = $this->read_private( $replayed, 'interpreter' );
		$interpreter->commands()['set_multi_writer']( $interpreter, [ $matches[1] ] );
		$this->assertTrue( $this->read_private( $replayed, 'multi_writer' ), 'and replays back to on' );
	}

	/**
	 * Renaming a Remote_Source must carry its sidecars with it. The suffix is
	 * interpolated, so a compound one moves whole: each lands on
	 * `{new}:{remote_partition}:offsetlog` / `:deadletter` and nothing is left
	 * squatting the old slot.
	 */
	public function test_renaming_a_remote_source_moves_its_sidecars(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$node    = new Remote_Source_Node();
		$node->name( 'lighthouse-keeper' );
		$node->arguments( [ 'galveston', 'beacon.p7', "{$offsets}/lighthouse-keeper.beacon.p7", "{$base}/deadletter/lighthouse-keeper.beacon.p7" ] );
		( new \ReflectionMethod( $node, 'ensure_offsetlog' ) )->invoke( $node );
		( new \ReflectionMethod( $node, 'ensure_deadletter' ) )->invoke( $node );

		$node->name( 'harbourwatch' );

		$offsetlog  = $this->read_private( $node, 'offsetlog' );
		$deadletter = $this->read_private( $node, 'deadletter' );
		$this->assertSame( 'harbourwatch:beacon.p7:offsetlog', $offsetlog->name() );
		$this->assertSame( $offsetlog, Core::node( 'harbourwatch:beacon.p7:offsetlog' ) );
		$this->assertSame( 'harbourwatch:beacon.p7:deadletter', $deadletter->name() );
		$this->assertSame( $deadletter, Core::node( 'harbourwatch:beacon.p7:deadletter' ) );
		$this->assertNull( Core::node( 'lighthouse-keeper:beacon.p7:offsetlog' ) );
		$this->assertNull( Core::node( 'lighthouse-keeper:beacon.p7:deadletter' ) );
	}

	/**
	 * `arguments()` is a replay setter here too, and a replay may name a new
	 * spoke AND new dirs. The next restore_position() has to commit the cursor
	 * into the dir the args just gave it, never into the superseded one.
	 */
	public function test_replayed_arguments_commits_the_cursor_into_the_new_offsetlog_dir(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$stale   = "{$offsets}/quarterdeck-stale.binnacle.p5";
		$fresh   = "{$offsets}/quarterdeck-fresh.gimbal.p9";
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$node    = new Remote_Source_Node();
		$node->name( 'quarterdeck-pull' );
		$node->arguments( [ 'austin', 'binnacle.p5', $stale, "{$base}/deadletter/quarterdeck-stale.binnacle.p5" ] );
		$this->seed_position( $node );

		$node->arguments( [ 'austin', 'gimbal.p9', $fresh, "{$base}/deadletter/quarterdeck-fresh.gimbal.p9" ] );
		$this->seed_position( $node );
		$node->next_offset( 0 );
		$node->checkpoint();

		$this->assertNotNull( $this->last_frame_in( $fresh ), 'the cursor commits into the replayed dir' );
		$this->assertNull( $this->last_frame_in( $stale ), 'nothing reaches the superseded dir' );
		$this->assertSame(
			$this->read_private( $node, 'offsetlog' ),
			Core::node( 'quarterdeck-pull:gimbal.p9:offsetlog' ),
			'the rebuilt cursor is published under the replayed spoke key'
		);
		$this->assertNull(
			Core::node( 'quarterdeck-pull:binnacle.p5:offsetlog' ),
			'and the superseded sidecar is unregistered, not orphaned'
		);
	}

	/**
	 * A replay may name a new spoke while keeping the dirs. The dir guard hands
	 * back the incumbent, so nothing rebuilds — but its registered name still
	 * spells the superseded spoke, and the slot it occupies must not be one the
	 * next retract computes past.
	 */
	public function test_replayed_spoke_renames_the_sidecar_even_when_the_dirs_are_unchanged(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$dir     = "{$offsets}/sextant-pull.shared";
		$dead    = "{$base}/deadletter/sextant-pull.shared";
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$node = new Remote_Source_Node();
		$node->name( 'sextant-pull' );
		$node->arguments( [ 'austin', 'astrolabe.p3', $dir, $dead ] );
		( new \ReflectionMethod( $node, 'ensure_offsetlog' ) )->invoke( $node );

		$node->arguments( [ 'austin', 'chronometer.p8', $dir, $dead ] );
		( new \ReflectionMethod( $node, 'ensure_offsetlog' ) )->invoke( $node );

		$this->assertNull( Core::node( 'sextant-pull:astrolabe.p3:offsetlog' ), 'the superseded name is released' );
		$this->assertSame(
			$this->read_private( $node, 'offsetlog' ),
			Core::node( 'sextant-pull:chronometer.p8:offsetlog' ),
			'and the incumbent answers to the replayed spoke'
		);
	}

	/**
	 * The quarantine is superseded the same way: a replay naming a different
	 * deadletter_dir has to quarantine poison into the dir it was just given.
	 */
	public function test_replayed_arguments_quarantines_into_the_new_deadletter_dir(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$stale   = "{$base}/deadletter/mizzen-stale.p2";
		$fresh   = "{$base}/deadletter/mizzen-fresh.p2";
		$node    = new Remote_Source_Node();
		$node->name( 'mizzen-pull' );
		$node->arguments( [ 'galveston', 'mizzen.p2', "{$offsets}/mizzen-pull.mizzen.p2", $stale ] );
		( new \ReflectionMethod( $node, 'ensure_deadletter' ) )->invoke( $node );

		$node->arguments( [ 'galveston', 'mizzen.p2', "{$offsets}/mizzen-pull.mizzen.p2", $fresh ] );
		( new \ReflectionMethod( $node, 'ensure_deadletter' ) )->invoke( $node );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'brackish-water';
		( new \ReflectionMethod( $node, 'dead_letter' ) )->invoke( $node, $message, 'throw', null );

		$this->assertSame( [ 'brackish-water' ], $this->values_in( $fresh ), 'poison lands in the replayed dir' );
		$this->assertSame( [], $this->values_in( $stale ), 'nothing reaches the superseded dir' );
	}

	/**
	 * Committing into the replayed dir is half the invariant; RESUMING from it
	 * is the other half. The restore latch therefore has to name the offsetlog
	 * it read, not a bare `true` — a bool outlives the sidecar a replay
	 * supersedes and pins the cursor to the dir the args just dropped.
	 */
	public function test_replayed_arguments_resumes_the_cursor_from_the_new_offsetlog_dir(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$stale   = "{$offsets}/binnacle-stale.p5";
		$fresh   = "{$offsets}/binnacle-fresh.p9";
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->commit_frame_at( $fresh, 7, 4242 );

		$node = new Remote_Source_Node();
		$node->name( 'binnacle-pull' );
		$node->arguments( [ 'austin', 'binnacle.p5', $stale, "{$base}/deadletter/binnacle-stale.p5" ] );
		$this->seed_position( $node );

		$node->arguments( [ 'austin', 'binnacle.p9', $fresh, "{$base}/deadletter/binnacle-fresh.p9" ] );
		$this->seed_position( $node );

		$this->assertSame( 7, $this->read_private( $node, 'cursor_segment' ), 'the replayed dir seats the segment' );
		$this->assertSame( 4242, $this->read_private( $node, 'cursor_offset' ), 'and the offset' );
	}

	/** Leave one durable frame at {segment,offset} in $dir, written by a real reader. */
	private function commit_frame_at( string $dir, int $segment, int $offset ): void {
		$base   = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$scribe = new Remote_Source_Node();
		$scribe->name( 'binnacle-scribe' );
		$scribe->arguments( [ 'austin', 'binnacle.p9', $dir, "{$base}/deadletter/binnacle-scribe.p9" ] );
		$scribe->next_offset( [ 'segment' => $segment, 'offset' => $offset ] );
		$scribe->checkpoint();
		$scribe->remove_node();
	}

	/** Seed the durable read position the way both production callers do. */
	private function seed_position( Remote_Source_Node $node ): void {
		( new \ReflectionMethod( $node, 'restore_position' ) )->invoke( $node );
	}

	/** @return array<array-key,mixed>|null */
	private function last_frame_in( string $dir ): ?array {
		$partition = new Partition_Node();
		$partition->arguments( [ $dir ] );
		return Remote_Source_Node::last_frame_of( $partition );
	}

	/** @return array<int,mixed> Every record VALUE written into $dir. */
	private function values_in( string $dir ): array {
		$partition = new Partition_Node();
		$partition->arguments( [ $dir ] );
		return $this->read_partition_values( $partition );
	}

	/**
	 * Teardown cascades into the sidecars, so the slots must be cleared with
	 * them. A slot still pointing at a torn-down node hands `ensure_offsetlog()`
	 * a node whose name, sink and patron are gone: its writes reach disk and
	 * nothing can address it.
	 */
	public function test_teardown_clears_the_sidecar_slots(): void {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$node    = new Remote_Source_Node();
		$node->name( 'capstan-watch' );
		$node->arguments( [ 'galveston', 'beacon.p7', "{$offsets}/capstan-watch.beacon.p7", "{$base}/deadletter/capstan-watch.beacon.p7" ] );
		$offsetlog = ( new \ReflectionMethod( $node, 'ensure_offsetlog' ) )->invoke( $node );

		$node->remove_node();

		$this->assertNull( $this->read_private( $node, 'offsetlog' ), 'the torn-down offsetlog is dropped' );
		$this->assertNull( $this->read_private( $node, 'deadletter' ), 'the torn-down quarantine is dropped' );
		$this->assertNotSame( $offsetlog, ( new \ReflectionMethod( $node, 'ensure_offsetlog' ) )->invoke( $node ) );
	}

	// ---------------------------------------------------------------------
	// Poison / crash lifecycle ([42]) — Consumer-style fair-shot + crawl.
	// ---------------------------------------------------------------------

	public function test_downstream_throw_dead_letters_immediately_and_advances(): void {
		// Consumer's model (all the way down): a downstream throw dead-letters the message ON
		// SIGHT (won't-forward → never will) and the cursor advances PAST it — no head-block,
		// no fair-shot climb. A following healthy message forwards normally.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', 'boom' ); // downstream throws → dead-letter immediately.
		$this->deliver( $sse, '7:300:40', '' );     // NOT blocked: forwards.

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'poison dead-lettered on the first throw' );
		$this->assertCount( 1, $spy->captured, 'the following message is not head-blocked' );

		// A clean shutdown commits PAST the last forwarded message — its crumb start plus the
		// crumb's own length, which is the next unread position and never a record already read.
		$node->checkpoint_shutdown();
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'] );
		$this->assertSame( 340, $frame['offset'] );
		$this->assertSame( 0, $frame['attempts'], 'no fair-shot climb — a clean handoff' );
	}

	public function test_resume_position_uses_the_crumb_length_not_the_local_line(): void {
		// The resume offset is in REMOTE coordinates, so only the crumb's on-disk
		// length is authoritative. The delivered line is re-stamped in transit and
		// runs longer, which pushed the resume INTO the next record: production saw
		// `57:40959889:177` resumed at 40959916 — 27 bytes in — and the spoke then
		// dead-lettered a 150-byte tail fragment, losing exactly one record.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		// A fat VALUE so the local line is nowhere near the 177-byte on-disk record.
		$this->deliver( $sse, '57:40959889:177', '', [ 'pad' => \str_repeat( 'x', 400 ) ] );

		$this->assertSame(
			40959889 + 177,
			$this->read_private( $node, 'cursor_offset' ),
			'the cursor must land on the next record boundary, not inside it'
		);
		$node->fire(); // the tick hands the cursor to the stream for its next connect.
		$this->assertSame(
			40959889 + 177,
			$sse->position()['offset'],
			'and the resume position is that same cursor — one position, not two'
		);
	}

	public function test_crumbless_throw_dead_letters_without_moving_the_cursor(): void {
		// A crumb-less throwing message has no position of its own: it cannot be placed in the
		// spoke's bytes, so it moves the cursor by nothing. The disposal still commits, and that
		// commit must land PAST the prior healthy record — never rewound onto it.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:100:40', '' ); // healthy → cursor advances past it.
		$this->assertSame( 140, $this->read_private( $node, 'cursor_offset' ) );

		$this->deliver( $sse, '', 'boom' ); // crumb-less, downstream throws.

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'the crumb-less throw IS dead-lettered' );
		$this->assertSame( 140, $this->read_private( $node, 'cursor_offset' ), 'an unplaceable record moves the cursor by nothing' );
		$node->checkpoint_shutdown();
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 140, $frame['offset'], 'and the handoff sits past the healthy record, never rewound onto it' );
	}

	public function test_caught_throw_commits_past_the_poison_and_a_reboot_moves_on(): void {
		// A caught-throw poison is dead-lettered ON SIGHT, so its position is resolved: the cursor
		// advances past it by its own crumb length and the disposal commits there GRACEFULLY. A
		// respawn therefore resumes past it — it is never re-delivered, and never re-quarantined.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', 'boom' ); // last message → dead-lettered, then idle.
		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ) );
		$this->assertSame( 172, $this->read_private( $node, 'cursor_offset' ), 'the cursor moves PAST the poison (128 + 44)' );

		$node->checkpoint_shutdown();
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 172, $frame['offset'], 'and the handoff commits there' );
		$this->assertSame( 0, $frame['attempts'], 'a disposed record leaves no lineage behind' );
		$node->remove_node();
		$spy->remove_node();
		[ $node2, $spy2 ] = $this->make_remote_spy( 'remote-austin' );
		$node2->fire();
		$this->assertSame( 172, $this->read_private( $node2, 'cursor_offset' ), 'the respawn resumes past the poison' );
		$this->assertFalse( $this->read_private( $node2, 'crawl_skip_head' ), 'and arms no head sacrifice on a resolved position' );

		$sse2 = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse2, '7:200:40', '' );
		$this->assertCount( 1, $spy2->captured, 'the next message forwards normally' );
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'and nothing is re-quarantined' );
	}

	public function test_a_disposal_ends_a_climbing_crash_lineage(): void {
		// The record the lineage was climbing for is now IN the dead-letter queue — the suspect is
		// resolved. Committing the live streak instead would leave the next boot arming a head
		// sacrifice at a clean position, condemning whichever innocent message arrived there.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 2, '' ); // climbing lineage: resume -> attempts=3.
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$this->assertSame( 3, $this->read_private( $node, 'attempts' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', 'boom' ); // caught throw on the boot message.

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 172, $frame['offset'], 'committed past the disposed record' );
		$this->assertSame( 0, $frame['attempts'], 'the lineage ends with the record it was about' );
	}

	public function test_unparseable_tail_is_quarantined_where_the_cursor_stands(): void {
		// A torn frame carries no crumb, so it cannot be placed in the spoke's bytes by anything
		// this node measures. It is dead-lettered where the cursor stands — the next unread
		// position, the one place available — and moves it by nothing, never by a local line
		// length, which is in the wrong byte space entirely.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 0, '' ); // boot = {7,128}; SSE_In is seeded there.
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$sse->process_sse_chunk( "event: msg\ndata: not-a-valid-message\n\n" ); // torn frame buffered.
		$node->poll(); // drain: forward_line owns the torn-line DLQ (SSE_In no longer unpacks).
		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'the unparseable frame is quarantined once' );
		$this->assertSame( 128, $this->read_private( $node, 'cursor_offset' ), 'the cursor stands where the record was placed' );
		$this->assertCount( 0, $spy->captured, 'and nothing is forwarded' );

		// The stream moves on: the next crumb-bearing record places itself and forwards.
		$this->deliver( $sse, '7:400:40', '' );
		$this->assertCount( 1, $spy->captured );
		$this->assertSame( 440, $this->read_private( $node, 'cursor_offset' ) );
	}

	public function test_unparseable_past_the_boot_head_is_dead_lettered(): void {
		// A torn frame is genuinely new poison wherever it lands: the stream resuming PAST a
		// GC'd crash suspect does not make the next torn frame that suspect.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' ); // crash lineage, boot={7,128}.
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$this->assertTrue( $this->read_private( $node, 'crawl_skip_head' ) );
		$sse = Core::node( 'remote-austin:sse-in' );
		$sse->restore_position( 7, 500 ); // the stream resumed PAST the boot head (suspect GC'd).

		$sse->process_sse_chunk( "event: msg\ndata: not-a-valid-message\n\n" );
		$node->poll();

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'a torn frame PAST the boot head is DLQ\'d, not silently dropped' );
	}

	public function test_hard_crash_lineage_climbs_attempts_across_respawn(): void {
		// A hard-crash lineage (NO reason — an uncatchable death, not a caught throw) restores
		// and resumes at attempts+1: the climb that eventually reaches CRASH_MAX and crawls.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 1, '' );

		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore_position applies the frame → attempts+1.

		$this->assertSame( 2, $this->read_private( $node, 'attempts' ) );
	}

	public function test_transient_hard_crash_recovered_resets_streak_on_forward_progress(): void {
		// A hard-crash lineage that turns out transient (the next message forwards fine) must
		// clear its climbing streak the moment a message forwards successfully — else the next
		// unclean recycle would falsely keep climbing toward the crawl threshold.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 1, '' ); // prior cycle's crash.

		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → attempts = 2 (lineage in flight).
		$this->assertSame( 2, $this->read_private( $node, 'attempts' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', '' ); // downstream healthy now → forwards successfully.

		$this->assertCount( 1, $spy->captured );
		$this->assertSame( 1, $this->read_private( $node, 'attempts' ), 'forward progress clears the streak' );
		$this->assertSame( 0, $this->newest_offsetlog_frame( $node )['attempts'], 'and commits a clean handoff frame' );
	}

	public function test_hard_crash_crawl_checkpoints_each_message_then_exits(): void {
		// A hard-crash lineage (NO reason, attempts ≥ CRASH_MAX) enters crawl: checkpoint
		// per relayed message (pins the culprit on a re-crash), attempts pinned — until a
		// full checkpoint interval of forward progress, then reset to the healthy baseline.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 0, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → crawl, attempts pinned at CRASH_MAX, crawl_started = 1000.
		$this->assertTrue( $this->read_private( $node, 'crawl' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:100:40', '' );
		$this->deliver( $sse, '7:200:40', '' );
		$this->assertSame( 2, $spy->fill_count, 'crawl still forwards each message' );
		$this->assertGreaterThanOrEqual( 2, $this->count_offsetlog_records( $node ), 'crawl checkpoints per message' );
		$this->assertSame( Remote_Source_Node::CRASH_MAX_ATTEMPTS, $this->newest_offsetlog_frame( $node )['attempts'], 'attempts pinned during crawl' );

		// A full interval elapses crash-free → the next message exits crawl to the baseline.
		Core::$now = 1000.0 + Remote_Source_Node::CHECKPOINT_INTERVAL_S + 1.0;
		$this->deliver( $sse, '7:300:40', '' );
		$this->assertFalse( $this->read_private( $node, 'crawl' ) );
		$this->assertSame( 1, $this->newest_offsetlog_frame( $node )['attempts'], 'crawl exits to the healthy baseline' );
	}

	public function test_crawl_pre_dispatch_commit_pins_line_before_fill(): void {
		// Fix #1: in crawl, forward_line writes a FORCED checkpoint at the in-hand line's OWN start
		// BEFORE $sink->fill — so an uncatchable crash mid-dispatch re-resumes at exactly it (the
		// advance-on-next cursor pins the in-hand line, unlike Consumer's chop cursor). Prove the
		// ordering: a sink that reads the newest committed frame at fill() time already sees THIS
		// line's start committed. (The trait's poll_crawl checkpoint runs only AFTER the fill.)
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 0, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' ); // boot into crawl at {7,0}.

		Core::$now = 1000.0;
		$node = new Remote_Source_Node();
		$node->name( 'remote-austin' );
		$probe = new class() extends Node {
			public ?Partition_Node $offsetlog = null;
			/** @var array<int,array{segment:int,offset:int}> */
			public array $committed_at_fill = [];
			public function fill( array $message ): void {
				$segments = $this->offsetlog?->get_segments( true ) ?? [];
				$last     = \end( $segments );
				if ( false === $last ) {
					$this->committed_at_fill[] = [ 'segment' => -1, 'offset' => -1 ];
					return;
				}
				$content = (string) $this->offsetlog?->read_at( $last['id'], 0, $last['size'] );
				$lines   = \array_values( \array_filter( \explode( "\n", $content ), static fn ( $l ) => '' !== $l ) );
				$v       = Message::unpacked( \end( $lines ) )[ Message::VALUE ];
				$this->committed_at_fill[] = [ 'segment' => (int) $v['segment'], 'offset' => (int) $v['offset'] ];
			}
		};
		$probe->name( 'downstream' );
		$node->sink( $probe );
		$node->target( 'downstream' );
		$node->arguments( $this->remote_args() );
		$node->fire(); // enter crawl; offsetlog materialized (newest frame is the boot seed {7,0}).
		$probe->offsetlog = $this->read_private( $node, 'offsetlog' );
		$sse = Core::node( 'remote-austin:sse-in' );

		// A line PAST the boot pin: sacrifice_boot_head disarms (stream resumed past the GC'd
		// suspect) and forwards it in crawl — exercising the crawl FORWARD path (not the sacrifice).
		$this->deliver( $sse, '7:100:40', '' );

		$this->assertSame(
			[ [ 'segment' => 7, 'offset' => 100 ] ],
			$probe->committed_at_fill,
			'the pinned cursor is committed BEFORE the fill in crawl'
		);
	}

	public function test_crawl_entry_sacrifices_matching_head_to_dlq_then_forwards(): void {
		// Consumer-parity head-sacrifice: booting into a hard-crash lineage (crawl) pins the
		// boot cursor and arms a one-shot head-sacrifice. The first relayed message whose crumb
		// START matches the pin is the in-flight-at-crash suspect — dead-lettered with reason
		// 'crash' (NOT forwarded, even though it is otherwise healthy), the local cursor advances
		// PAST it (offset+length), the flag clears, and the next message forwards normally.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → crawl, boot pinned at {7,128}, head-sacrifice armed.
		$this->assertTrue( $this->read_private( $node, 'crawl' ) );
		$this->assertTrue( $this->read_private( $node, 'crawl_skip_head' ), 'crawl entry arms the head sacrifice' );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:128:44', '' ); // matches the pin → sacrificed even though healthy.

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'suspect head dead-lettered' );
		$this->assertCount( 0, $spy->captured, 'suspect head is NOT forwarded downstream' );
		$this->assertFalse( $this->read_private( $node, 'crawl_skip_head' ), 'head sacrifice is one-shot' );
		// The suspect is resolved: the cursor moves PAST it (128 + 44).
		$this->assertSame( 7, $this->read_private( $node, 'cursor_segment' ) );
		$this->assertSame( 172, $this->read_private( $node, 'cursor_offset' ), 'cursor lands past the sacrificed head' );
		// And the disposal commits there, closing the sacrifice-to-next-arrival crash window: a
		// reboot inside it resumes past the suspect instead of producing a second DLQ entry.
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 172, $frame['offset'] );
		$this->assertSame( Remote_Source_Node::CRASH_MAX_ATTEMPTS, $frame['attempts'], 'crawl keeps its accounting pinned until it survives a clean interval' );

		$this->deliver( $sse, '7:172:40', '' ); // past the pin, flag cleared → forwards normally.
		$this->assertCount( 1, $spy->captured, 'the next message forwards normally' );
		$this->assertSame( 212, $this->read_private( $node, 'cursor_offset' ), 'and the cursor lands past it' );
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'only the head was dead-lettered' );
	}

	public function test_crawl_entry_disarms_without_sacrifice_when_first_message_past_pin(): void {
		// Stale suspect: the remote GC'd the suspect's segment (or the stream resumed beyond it),
		// so the first relayed crumb START is PAST the boot pin. The suspect no longer exists —
		// disarm WITHOUT sacrificing and forward the message normally. Only an exact match sacrifices.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$this->assertTrue( $this->read_private( $node, 'crawl_skip_head' ) );
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:500:40', '' ); // start PAST the {7,128} pin → stale suspect.

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 0, $this->count_log_records( $dlq ), 'a past-the-pin message is not sacrificed' );
		$this->assertCount( 1, $spy->captured, 'and it forwards normally' );
		$this->assertFalse( $this->read_private( $node, 'crawl_skip_head' ), 'a stale suspect disarms the head sacrifice' );
	}

	public function test_crawl_does_not_exit_while_head_sacrifice_armed(): void {
		// The crawl-exit guard mirrors Consumer: an elapsed interval must NOT exit crawl while the
		// head sacrifice is still armed, or an un-sacrificed poison re-arms the crash loop next boot.
		// Only after the suspect is sacrificed (flag cleared) may an elapsed interval exit crawl.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Source_Node::CRASH_MAX_ATTEMPTS, '' );

		Core::$now = 1000.0;
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → crawl, crawl_started = 1000, head-sacrifice armed.
		$sse = Core::node( 'remote-austin:sse-in' );

		// Interval elapsed, but a message with no usable breadcrumb keeps the flag armed.
		Core::$now = 1000.0 + Remote_Source_Node::CHECKPOINT_INTERVAL_S + 1.0;
		$this->deliver( $sse, '', '' ); // null crumb → flag stays armed, cursor un-advanced.
		$this->assertTrue( $this->read_private( $node, 'crawl' ), 'does not exit crawl while the head sacrifice is armed' );

		// Now the suspect arrives and is sacrificed → flag clears → the elapsed interval exits crawl.
		$this->deliver( $sse, '7:128:44', '' );
		$this->assertFalse( $this->read_private( $node, 'crawl_skip_head' ) );
		$this->assertFalse( $this->read_private( $node, 'crawl' ), 'exits crawl after the sacrifice once the interval has elapsed' );
	}

	public function test_cooperative_stop_below_threshold_freezes_at_message_start(): void {
		// EXACTLY Consumer's fair-shot: a timeout on the BOOT message (the replay resumes at the
		// boot cursor, so the in-hand start == boot — cursor not advanced past boot) below COOP_MAX
		// records a strike at the message's OWN start with the climbing attempts/reason — no
		// quarantine — so the respawn re-pulls exactly it and climbs.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 0, '' ); // boot = {7,128}; the stream replays the boot message there.
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → attempts=1, boot cursor = {7,128}.
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->stop_message( '7:128:44' ) ); // deadline mid-forward on the boot message.
		$node->cooperative_stop( 'timeout', false );

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 0, $this->count_log_records( $dlq ), 'below threshold → not quarantined' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'] );
		$this->assertSame( 128, $frame['offset'], 'frozen at the poison message start (offset, not offset+length)' );
		$this->assertSame( 1, $frame['attempts'] );
		$this->assertSame( 'timeout', $frame['reason'] );
		// New-hazard guard: a below-threshold strike frame must carry NO quarantine marker, or the
		// successor would silently drop a message that still had fair shots left (data loss).
		$this->assertArrayNotHasKey( 'quarantined', $frame, 'a below-threshold strike is NOT a quarantine marker' );
	}

	public function test_cooperative_stop_at_threshold_quarantines_and_hands_off_past_it(): void {
		// At COOP_MAX the in-flight boot message is dead-lettered and the shutdown frame is a
		// quarantine MARKER at the message's own START (advance-on-next — no offset+length), at the
		// virgin baseline. The successor boots onto it, DROPS it (already in the DLQ), and advances.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, Remote_Source_Node::COOP_MAX_ATTEMPTS - 1, 'timeout' );
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // restore → attempts = COOP_MAX, boot = {7,128}.
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->stop_message( '7:128:44' ) ); // boot message, stopped mid-forward.
		$node->cooperative_stop( 'timeout', false );

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 1, $this->count_log_records( $dlq ), 'quarantined at COOP_MAX' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'] );
		$this->assertSame( 172, $frame['offset'], 'hands off PAST the quarantined message (128 + 44)' );
		$this->assertSame( 0, $frame['attempts'], 'clean handoff at the virgin baseline' );
	}

	public function test_cooperative_stop_clean_handoff_when_cursor_advanced(): void {
		// A stop AFTER the cursor advanced past boot is a normal recycle, not poison: clean
		// graceful handoff, no strike, no quarantine (EXACTLY Consumer).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->healthy_message( '7:100:40' ) ); // forwards → cursor advances past boot.
		$this->deliver_built( $sse, $this->stop_message( '7:300:44' ) );    // a later stop.
		$node->cooperative_stop( 'timeout', false );

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 0, $this->count_log_records( $dlq ), 'advanced cursor → no strike' );
		$this->assertCount( 1, $spy->captured );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 300, $frame['offset'], 'graceful commit at the in-hand (stopped) message start' );
		$this->assertSame( 0, $frame['attempts'] );
		// Fair-shot absence: a routine cooperative stop is NEVER a quarantine — the successor
		// re-delivers the in-flight message (that re-delivery IS the fair shot).
		$this->assertArrayNotHasKey( 'quarantined', $frame, 'a routine cooperative stop writes no marker' );
	}

	public function test_assume_clean_shutdown_commits_past_the_stopped_message(): void {
		// With assume_clean_shutdown, a plain cooperative stop commits PAST the in-flight
		// message using the crumb's own LENGTH (seg:offset:length), so the restart resumes
		// after it and the hub isn't re-sent the already-written message. Contrast the
		// default, which commits at the message START and re-delivers it.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->set_assume_clean_shutdown( true );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->stop_message( '7:300:44' ) ); // plain stop; crumb length 44.
		$node->cooperative_stop( 'timeout', false );

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 344, $frame['offset'], 'commits past the message: start 300 + crumb length 44' );
		$this->assertSame( 0, $frame['attempts'], 'a clean-shutdown stop advances the cursor — no strike' );
	}

	public function test_assume_clean_shutdown_does_not_advance_past_a_crumbless_message(): void {
		// A crumb-less message has no position of its own — the cursor stands PAST the prior
		// healthy record. assume_clean_shutdown must NOT advance from that base (that would
		// be prior_end + this_line_len = a bogus offset that misaligns the stream); it
		// falls through to the normal mid-dispatch replay, committing where the cursor stands.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->set_assume_clean_shutdown( true );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:100:40', '' );                  // healthy → cursor advances to 140.
		$this->deliver_built( $sse, $this->stop_message( '' ) ); // crumb-less stop.
		$node->cooperative_stop( 'timeout', false );

		$this->assertSame( 140, $this->newest_offsetlog_frame( $node )['offset'], 'a crumb-less stop moves the cursor by nothing' );
	}

	public function test_cooperative_stop_memory_watermark_exemption_does_not_strike(): void {
		// A memory stop with the fresh baseline already near the watermark blames a leak /
		// undersized limit, NOT the in-flight message: clean handoff, no strike (EXACTLY Consumer).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$this->seed_offsetlog_frame( 7, 128, 0, '' ); // clean prior frame → resume attempts=1, boot={7,128}.
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver_built( $sse, $this->stop_message( '7:128:44' ) ); // boot message, stopped mid-forward.
		$node->cooperative_stop( 'memory', true );

		$dlq = \Newspack_Nodes\Config::get_base_directory() . '/deadletter/remote-austin.firehose.p0';
		$this->assertSame( 0, $this->count_log_records( $dlq ), 'watermark exemption → not struck' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 128, $frame['offset'], 'graceful commit at the boot cursor' );
		$this->assertSame( 0, $frame['attempts'], 'clean handoff, no strike' );
	}

	public function test_the_cursor_lands_past_each_forwarded_message(): void {
		// The cursor names the next UNREAD byte, the same as Consumer's: a record's
		// own crumb gives its start and size, and forwarding it moves the cursor
		// past both. Pinned at the start instead, every resume re-delivers it.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:100:40', '' );
		$this->assertSame( 140, $this->read_private( $node, 'cursor_offset' ), 'past message N (100 + 40)' );

		$this->deliver( $sse, '7:140:30', '' );
		$this->assertSame( 170, $this->read_private( $node, 'cursor_offset' ), 'past N+1 (140 + 30)' );
		$this->assertCount( 2, $spy->captured );
	}

	public function test_reconnect_resumes_from_the_crumb_stamped_record_end(): void {
		// Resume at `crumb offset + crumb length` — exactly-once, no boot replay. Asserted the
		// reverse until 2.2.1 (local strlen), which mixed a remote offset with a local length and
		// drifted 27 bytes into the next record on every reconnect.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured_urls = [];
		SSE_In_Node::$curl_dispatch = static function ( array $opts ) use ( &$captured_urls ): \CurlHandle {
			$captured_urls[] = Core::as_string( $opts[ \CURLOPT_URL ] );
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire(); // first connect: position is boot (0:0) → no `positions` param.
		$sse = Core::node( 'remote-austin:sse-in' );

		// The stamp (999) is what the resume must honor — it is the on-disk record size.
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = '7:200:999';
		$m[ Message::VALUE ] = [ 'p' => 1 ];
		$packed              = Message::packed( $m );
		$sse->process_sse_chunk( "event: msg\ndata: {$packed}\n\n" );
		$node->poll();
		$this->assertCount( 1, $spy->captured );

		// A reconnect: drop the handle, clear backoff, tick → maybe_connect rebuilds `positions`.
		$sse->disconnect();
		Core::$now = \microtime( true ) + 100;
		$node->fire();
		$this->drain_connect_queue();

		$last_url = (string) \end( $captured_urls );
		\parse_str( (string) \parse_url( $last_url, \PHP_URL_QUERY ), $query );
		$positions = \json_decode( (string) ( $query['positions'] ?? '' ), true );
		$this->assertIsArray( $positions, 'the reconnect carries a positions param (not a boot replay)' );
		$this->assertSame(
			[ 'segment' => 7, 'offset' => 200 + 999 ],
			$positions['firehose.p0'] ?? null,
			'resume at the crumb-stamped record end, never a locally measured line length'
		);
		$this->assertCount( 1, $spy->captured, 'the reconnect itself re-forwards nothing' );
	}

	public function test_crumb_from_line_accepts_a_two_part_crumb(): void {
		// Wire-compat: after the crumb shrinks from seg:off:len to seg:off, the reader must still
		// pin the cursor from a two-part crumb (nothing reads the retired length anymore).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:200', '' ); // two-part crumb, no length.

		$this->assertCount( 1, $spy->captured, 'a two-part crumb still forwards' );
		$this->assertSame( 7, $this->read_private( $node, 'cursor_segment' ) );
		$this->assertSame( 200, $this->read_private( $node, 'cursor_offset' ), 'a length-less crumb pins its start and advances by nothing' );
	}

public function test_relay_with_null_sink_fails_loud(): void {
		// Bug D: a null/unwired downstream must FAIL LOUD — never silently no-op while the
		// stream is consumed (which would advance the cursor past undelivered messages). The
		// stream now arrives via the SSE_In buffer; forward_line throws on the null sink at drain.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = new Remote_Source_Node();
		$node->name( 'remote-austin' );
		$node->arguments( $this->remote_args() ); // no sink wired.
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->expectException( \RuntimeException::class );
		$this->deliver( $sse, '7:1:20', '' ); // drain with a null sink → fail loud.
	}

	public function test_stream_data_relayed_downstream_not_to_http_out(): void {
		// Stream data flows via the SSE_In buffer → forward_line → downstream; it never touches
		// the outbound send()/HTTP_Out path (that carries commands + the heartbeat only). A message
		// whose FROM does not match the SSE_In name still relays — routing is by the buffer path,
		// not a FROM-prefix match.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node, $spy ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$http = Core::node( 'remote-austin:http-out' );
		$sse  = Core::node( 'remote-austin:sse-in' );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::FROM ]  = 'some-unrelated-node';
		$m[ Message::ID ]    = '7:1:20';
		$m[ Message::VALUE ] = [ 'p' => 1 ];
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );
		$node->poll();

		$this->assertCount( 1, $spy->captured, 'stream data is relayed downstream regardless of FROM' );
		$this->assertCount( 0, $this->read_private( $http, 'batch' ), 'stream data must NOT be misrouted to HTTP_Out' );
	}

	public function test_checkpoint_shutdown_commits_healthy_cursor(): void {
		// Bug C: Remote_Source isn't a Consumer, so the worker's
		// checkpoint_durable_consumers() must commit its live cursor at shutdown — else
		// healthy progress is lost on every ~10-min recycle. The committed cursor is the
		// node-owned after-forward boundary (a forwarded message's END).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse, '9:512:40', '' ); // healthy forward → cursor lands past it.

		$node->checkpoint_shutdown();

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 9, $frame['segment'] );
		$this->assertSame( 552, $frame['offset'], 'the handoff names the next unread record (512 + 40)' );
		$this->assertSame( 0, $frame['attempts'], 'a healthy shutdown is a clean handoff (attempts=0)' );
	}

	public function test_checkpoint_shutdown_commits_a_paused_seek_position(): void {
		// Fix #6: a paused time-travel SEEK sets the cursor + offset_set but leaves poll_initialized
		// false (no poll runs while paused). checkpoint_shutdown must still commit the seeked
		// position — guarding on poll_initialized ALONE silently drops it. Aligns the guard with
		// checkpoint() / cooperative_stop (both: ! poll_initialized && ! offset_set).
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		// No fire() — a SEEK issued while paused, before the first tick, so poll_initialized stays false.
		$node->next_offset( [ 'segment' => 3, 'offset' => 256 ] );
		$this->assertFalse( $this->read_private( $node, 'poll_initialized' ), 'no poll ran' );
		$this->assertTrue( $this->read_private( $node, 'offset_set' ), 'the SEEK set the cursor explicitly' );

		$node->checkpoint_shutdown();

		$this->assertSame( 1, $this->count_offsetlog_records( $node ), 'the seeked position is committed at shutdown' );
		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 3, $frame['segment'] );
		$this->assertSame( 256, $frame['offset'] );
	}

	public function test_durable_cursor_is_node_owned_not_sse_in_position(): void {
		// Remote_Source owns cursor_segment/off, advanced AFTER a successful forward from the
		// message's OWN breadcrumb (offset+length) — never SSE_In's connection position, which
		// advances eagerly and can lead an in-flight message. Prove independence: forward one
		// healthy message, then shove SSE_In's position far ahead, then commit at shutdown —
		// the frame must record the forwarded boundary, not SSE_In's lead.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$this->deliver( $sse, '7:300:40', '' ); // healthy forward → node cursor lands past it.
		$sse->restore_position( 9, 99999 );      // desync SSE_In's connection cursor far ahead.

		$node->checkpoint_shutdown();

		$frame = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $frame['segment'], 'committed the node-owned cursor, not SSE_In lead' );
		$this->assertSame( 340, $frame['offset'] );
	}

	/** Build a named Remote_Source wired to a Relay_Sink_Spy downstream + target. */
	/**
	 * The dirs are ARGUMENTS, like Consumer's — there is no derived fallback, so a
	 * node that wants a durable cursor or a quarantine must be told where they live.
	 *
	 * @return list<string> Positional ctor tokens.
	 */
	private function remote_args( string $name = 'remote-austin', string $vault = 'austin' ): array {
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		return [ $vault, 'firehose.p0', "{$offsets}/{$name}.firehose.p0", "{$base}/deadletter/{$name}.firehose.p0" ];
	}

	/** @param list<string>|null $args Positional ctor tokens (null = derive via remote_args). */
	private function make_remote_spy( string $name = 'remote-austin', ?array $args = null ): array {
		$args ??= $this->remote_args( $name );
		$node = new Remote_Source_Node();
		$node->name( $name );
		$spy = new Relay_Sink_Spy();
		$spy->name( 'downstream' );
		$node->sink( $spy );
		$node->target( 'downstream' );
		$node->arguments( $args );
		return [ $node, $spy ];
	}

	/**
	 * Push one TM_STRUCT stream message through the SSE_In parser (keyed `boom` to poison the
	 * relay), then drive one pump tick to drain it. Under the Durable_Reader pump model SSE_In's raw
	 * `msg` payload only lands in the owner's buffer; the production tick drains it, so this makes
	 * that tick explicit (crawl caps drain at one line per poll — one poll per delivered line).
	 */
	private function deliver( SSE_In_Node $sse, string $id, string $key = '', array $value = [ 'p' => 1 ] ): void {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = $id;
		$m[ Message::KEY ]   = $key;
		$m[ Message::VALUE ] = $value;
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );
		$patron = $sse->patron();
		if ( $patron instanceof Remote_Source_Node ) {
			$patron->poll();
		}
	}

	/**
	 * Deliver a pre-built message, then drive one pump tick — swallowing the Worker_Should_Stop a
	 * `stop`-keyed one raises when the tick dispatches it (it propagates up like the real drain
	 * loop; the worker then routes to cooperative_stop).
	 */
	private function deliver_built( SSE_In_Node $sse, array $m ): void {
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );
		$patron = $sse->patron();
		try {
			if ( $patron instanceof Remote_Source_Node ) {
				$patron->poll();
			}
		} catch ( Worker_Should_Stop $e ) {
			// Expected for a `stop`-keyed message.
		}
	}

	/** A TM_STRUCT stream message keyed `stop` (downstream raises Worker_Should_Stop on it). */
	private function stop_message( string $id ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = $id;
		$m[ Message::KEY ]   = 'stop';
		$m[ Message::VALUE ] = [ 'p' => 1 ];
		return $m;
	}

	/** A healthy TM_STRUCT stream message (forwards cleanly). */
	private function healthy_message( string $id ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = $id;
		$m[ Message::KEY ]   = '';
		$m[ Message::VALUE ] = [ 'p' => 1 ];
		return $m;
	}

	/** Write a single committed offsetlog frame (with attempt accounting) for the default remote node. */
	private function seed_offsetlog_frame( int $segment, int $offset, int $attempts, string $reason, string $name = 'remote-austin', bool $quarantined = false ): void {
		$dir = \Newspack_Nodes\Config::get_offsets_directory() . "/{$name}.firehose.p0";
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		$value = [ 'segment' => $segment, 'offset' => $offset, 'attempts' => $attempts, 'reason' => $reason, 'first_crash_ts' => null, '_ts' => 1 ];
		if ( $quarantined ) {
			$value['quarantined'] = true;
		}
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::VALUE ] = $value;
		\file_put_contents( "{$dir}/0.log", Message::packed( $m ) . "\n" );
	}

	/** @return array<array-key,mixed> The newest committed offsetlog frame VALUE. */
	private function newest_offsetlog_frame( Remote_Source_Node $node ): array {
		$offsetlog = $this->read_private( $node, 'offsetlog' );
		$this->assertInstanceOf( Partition_Node::class, $offsetlog );
		$segments = $offsetlog->get_segments( true );
		$last     = \end( $segments );
		$content  = $offsetlog->read_at( $last['id'], 0, $last['size'] );
		$lines    = \array_values( \array_filter( \explode( "\n", $content ), static fn ( $l ) => '' !== $l ) );
		return Message::unpacked( \end( $lines ) )[ Message::VALUE ];
	}

	private function count_offsetlog_records( Remote_Source_Node $node ): int {
		$offsetlog = $this->read_private( $node, 'offsetlog' );
		if ( ! $offsetlog instanceof Partition_Node ) {
			return 0;
		}
		$count = 0;
		foreach ( $offsetlog->get_segments( true ) as $s ) {
			foreach ( \explode( "\n", $offsetlog->read_at( $s['id'], 0, $s['size'] ) ) as $l ) {
				if ( '' !== $l ) {
					++$count;
				}
			}
		}
		return $count;
	}

	private function count_log_records( string $dir ): int {
		$count = 0;
		foreach ( (array) \glob( "{$dir}/*.log" ) as $path ) {
			foreach ( \explode( "\n", (string) \file_get_contents( (string) $path ) ) as $line ) {
				if ( '' !== $line ) {
					++$count;
				}
			}
		}
		return $count;
	}

	public function test_first_tick_creates_http_out_patron(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		$node->fire();

		$http = Core::node( 'remote-austin:http-out' );
		$this->assertInstanceOf( HTTP_Out_Node::class, $http );
		$this->assertSame( 'austin', $this->read_private( $http, 'vault_id' ) );
	}

	public function test_delegates_counter_bytes_read_largest_msg_to_its_sse_in(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$sse->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::KEY ]   = 'k';
		$m[ Message::VALUE ] = [ 'a' => 1 ];
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );

		// The aggregator's Remote_Source reports the stream stats of its SSE_In
		// child, not its own (which never reads the wire).
		$this->assertGreaterThan( 0, $sse->bytes_read() );
		$this->assertSame( $sse->bytes_read(), $node->bytes_read() );
		$this->assertSame( $sse->counter(), $node->counter() );
		$this->assertSame( $sse->largest_msg_sent(), $node->largest_msg_sent() );
	}

	public function test_missing_vault_entry_stays_disconnected_no_patrons(): void {
		[ $node ] = $this->make_remote( 'remote-ghost', [ 'ghost', 'firehose.p0' ] );

		$node->fire();

		$this->assertNull( Core::node( 'remote-ghost:sse-in' ) );
		$this->assertNull( Core::node( 'remote-ghost:http-out' ) );
	}

	public function test_remove_node_tears_down_patrons_and_offsetlog(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$this->assertInstanceOf( SSE_In_Node::class, Core::node( 'remote-austin:sse-in' ) );
		$this->assertInstanceOf( HTTP_Out_Node::class, Core::node( 'remote-austin:http-out' ) );

		$node->remove_node();

		$this->assertNull( Core::node( 'remote-austin:sse-in' ) );
		$this->assertNull( Core::node( 'remote-austin:http-out' ) );
		$this->assertNull( Core::node( 'remote-austin:firehose.p0:offsetlog' ) );
		$this->assertNull( Core::node( 'remote-austin:firehose.p0:deadletter' ) );
	}

	public function test_node_schema_visible_io_with_args(): void {
		$schema = Remote_Source_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertArrayNotHasKey( 'hidden', $schema );
		$names = \array_column( $schema['arguments'], 'name' );
		// [147] Reads like the Consumer it is: the cursor + DLQ dirs are ARGS, so
		// a topology can write them — and therefore scope them with `<topology>`.
		$this->assertSame(
			[ 'vault_id', 'remote_partition', 'offsetlog_dir', 'deadletter_dir' ],
			$names
		);
	}

	// ---------------------------------------------------------------------
	// Task 5 — self-sufficiency: offsetlog, tick, heartbeat, status.
	// ---------------------------------------------------------------------

	public function test_committed_offsetlog_restored_into_sse_in_before_connect(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );

		// Pre-seed the per-node offsetlog with a committed {seg,off} line.
		$offsets_dir = \Newspack_Nodes\Config::get_offsets_directory();
		$dir         = "{$offsets_dir}/remote-austin.firehose.p0";
		\mkdir( $dir, 0755, true );
		$pre = new Partition_Node();
		$pre->name( 'preseed:offsetlog' );
		$pre->arguments( [ $dir ] );
		$entry                       = Message::new_message();
		$entry[ Message::TYPE ]      = Message::TM_STRUCT;
		$entry[ Message::VALUE ]     = [ 'segment' => 4, 'offset' => 256, '_ts' => 123 ];
		$pre->fill( $entry );
		$pre->flush();

		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertSame( [ 'segment' => 4, 'offset' => 256 ], $sse->position() );
	}

	public function test_offsetlog_inherits_its_patrons_sink(): void {
		// A sidecar sinks where its patron sinks. make_node sinks every node into
		// _command_interpreter and flow is steered by target(), so inheriting the
		// patron's sink IS how the offsetlog's replies reach the interpreter.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();

		$offsetlog = $this->read_private( $node, 'offsetlog' );
		$this->assertInstanceOf( Partition_Node::class, $offsetlog );
		$this->assertSame( $node->sink(), $offsetlog->sink() );
	}

	public function test_fire_commits_node_cursor(): void {
		// The throttled per-tick checkpoint commits the node-owned after-forward cursor
		// (a forwarded message's END), not SSE_In's connection position.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse, '7:99:40', '' ); // healthy forward → cursor lands PAST it (99 + 40).

		// Advance clock past the commit interval and tick again.
		Core::$now = \microtime( true ) + 100;
		$node->fire();

		$value = $this->newest_offsetlog_frame( $node );
		$this->assertSame( 7, $value['segment'] );
		$this->assertSame( 139, $value['offset'] );
	}

	public function test_throttled_checkpoint_does_not_recommit_an_unchanged_position(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote_spy( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse, '5:5:40', '' ); // healthy forward advances the node cursor.
		Core::$now = \microtime( true ) + 100;
		$node->fire(); // commits the moved cursor
		$baseline = $this->count_offsetlog_records( $node );
		$this->assertGreaterThanOrEqual( 1, $baseline, 'a moved cursor is committed' );

		// Idle stream: no new message, the node cursor is unchanged, another interval elapses.
		Core::$now = \microtime( true ) + 200;
		$node->fire();
		$this->assertSame( $baseline, $this->count_offsetlog_records( $node ), 'an unchanged node cursor must not spam a duplicate keyframe (advance-guard, matching Consumer)' );
	}

	public function test_heartbeat_skipped_when_slot_unknown(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$http = Core::node( 'remote-austin:http-out' );
		$this->assertCount( 0, $this->read_private( $http, 'batch' ) );
	}

	public function test_heartbeat_command_contains_exact_slot_and_owner(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		// Give the SSE_In a complete lease via the connected handshake.
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->set_slot( $sse, 7, 42424243 );

		// Advance clock past the heartbeat interval (16s) but under the stale timeout (45s).
		Core::$now = \microtime( true ) + 16;
		$node->fire();

		$http  = Core::node( 'remote-austin:http-out' );
		$batch = $this->read_private( $http, 'batch' );
		$this->assertCount( 1, $batch );
		$envelope = $batch[0];
		$this->assertSame( Message::TM_COMMAND, $envelope[ Message::TYPE ] );
		$this->assertSame( 'remote-austin', $envelope[ Message::FROM ] );
		$this->assertSame( 'workers', $envelope[ Message::TO ] );
		$value = $envelope[ Message::VALUE ];
		$this->assertSame( 'heartbeat', $value['name'] );
		$this->assertSame( [ '7', '42424243' ], $value['arguments'] );
	}

	public function test_heartbeat_reply_into_fill_records_rtt_and_response(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->set_slot( $sse, 5 );
		Core::$now = \microtime( true ) + 16;
		$node->fire(); // sends heartbeat, records send-time

		// Simulate the spoke's heartbeat reply routed back into fill(). The spoke's
		// interpreter wraps a command response as TM_COMMAND|TM_RESPONSE; fill()
		// records the RTT for that type and relays anything else to HTTP_Out.
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]    = 'remote-austin';
		$reply[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [ 'success' => true, 'slot' => 5 ],
		];
		$node->fill( $reply );

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertIsArray( $status );
		$this->assertArrayHasKey( 'last_heartbeat_response', $status );
		$this->assertArrayHasKey( 'last_heartbeat_rtt', $status );
		$this->assertNotNull( $status['last_heartbeat_response'] );
	}

	public function test_heartbeat_command_error_clears_prior_success_and_records_reason(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$this->set_slot( Core::node( 'remote-austin:sse-in' ), 7, 42424243 );
		Core::$now = 1748960000.0;
		$node->fire();

		$success                   = Message::new_message();
		$success[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$success[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [ 'success' => true, 'slot' => 7 ],
		];
		$node->fill( $success );
		$this->assertNotNull(
			Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) )['last_heartbeat_response']
		);

		$lines = [];
		Core::set_stderr_handler(
			static function ( string $line ) use ( &$lines ): void {
				$lines[] = $line;
			}
		);
		$error                   = Message::new_message();
		$error[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_ERROR;
		$error[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => 'SSE slot lease not owned',
		];
		$node->fill( $error );

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertNull( $status['last_heartbeat_response'] );
		$this->assertNull( $status['last_heartbeat_rtt'] );
		$this->assertSame(
			'Client heartbeat failed: SSE slot lease not owned',
			$status['last_error']
		);
		$this->assertStringContainsString( 'SSE slot lease not owned', \implode( '', $lines ) );
		$this->assertStringNotContainsString( '42424243', \implode( '', $lines ) );
	}

	public function test_heartbeat_success_false_clears_prior_success_and_records_reason(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$this->set_slot( Core::node( 'remote-austin:sse-in' ), 7, 42424243 );
		Core::$now = 1748960000.0;
		$node->fire();

		$success                   = Message::new_message();
		$success[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$success[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [ 'success' => true, 'slot' => 7 ],
		];
		$node->fill( $success );

		$rejected                   = Message::new_message();
		$rejected[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$rejected[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [
				'success' => false,
				'error'   => 'slot lease ownership mismatch',
			],
		];
		$node->fill( $rejected );

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertNull( $status['last_heartbeat_response'] );
		$this->assertNull( $status['last_heartbeat_rtt'] );
		$this->assertSame(
			'Client heartbeat failed: slot lease ownership mismatch',
			$status['last_error']
		);
	}

	public function test_publish_status_ages_out_stale_heartbeat_response(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->set_slot( $sse, 5 );

		Core::$now = 1000.0;
		$node->fire(); // mints the heartbeat (records send-time)
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]    = 'remote-austin';
		$reply[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => [ 'success' => true, 'slot' => 5 ],
		];
		$node->fill( $reply ); // records last_heartbeat_response at t=1000

		// A tick right after the reply keeps the fresh response in the snapshot.
		$node->fire();
		$this->assertNotNull(
			Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) )['last_heartbeat_response']
		);

		// No further reply; advance past the HEARTBEAT_INTERVAL*4 staleness window.
		// The Status badge must not latch 'success' on a stale timestamp, so the
		// snapshot ages the response out to null (mirrors the old clear-on-disconnect).
		Core::$now = 1000.0 + ( Remote_Source_Node::HEARTBEAT_INTERVAL * 4 ) + 5;
		$node->fire();
		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertNull( $status['last_heartbeat_response'] );
		$this->assertNull( $status['last_heartbeat_rtt'] );
	}

	public function test_publish_status_carries_the_schedule_a_stream_closed_at_eof_returns_on(): void {
		// The dashboard must tell "closed on purpose, back at T" from "failed",
		// and a null last_error also means "never attempted" — so the schedule
		// itself rides the snapshot as its own field.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		Core::$now = 1748970000.0;
		$node->fire();
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$handle = $sse->test_get_handle();
		$this->assertInstanceOf( \CurlHandle::class, $handle );

		$sse->process_sse_chunk( "retry: 9000\n\n" );
		$this->set_slot( $sse, 5 );
		// The stub handle never transferred, so seed the status a live 200
		// stream would have observed while its bytes arrived.
		( new \ReflectionProperty( SSE_In_Node::class, 'last_http_code' ) )->setValue( $sse, 200 );
		$sse->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $handle, 'result' => \CURLE_OK ] );
		Core::$now = 1748970001.0;
		$node->fire();

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertFalse( $status['connected'] );
		$this->assertNull( $status['last_error'], 'a scheduled close is not a failure' );
		$this->assertSame( 1748970009, $status['scheduled_reconnect_at'] );
	}

	public function test_publish_status_reports_an_opening_stream_as_connecting(): void {
		// A socket mid-open is neither up nor down; publishing it as connected
		// is what made a card read CONNECTED seconds before it timed out.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		Core::$now = 1748970000.0;
		$node->fire();
		$this->drain_connect_queue();
		// fire() housekeeps once per wall-second; the publish rides the next one.
		Core::$now = 1748970001.0;
		$node->fire();

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertFalse( $status['connected'], 'no handshake yet' );
		$this->assertTrue( $status['connecting'] );
	}

	public function test_publish_status_reports_a_handshaken_stream_as_connected(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		Core::$now = 1748970000.0;
		$node->fire();
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->set_slot( $sse, 5 );
		Core::$now = 1748970001.0;
		$node->fire();

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertTrue( $status['connected'] );
		$this->assertFalse( $status['connecting'] );
	}

	public function test_a_released_slot_never_reaches_the_dashboard(): void {
		// An idle stream ends and releases its own slot; a heartbeat already in
		// flight lands on the tombstone. Latching that into last_error paints a
		// healthy link with a failure banner it will never clear on its own.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		$node->fill( $this->heartbeat_error( 'remote-austin', 'SSE slot lease not owned: slot_released' ) );

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertNull( ( $status ?: [] )['last_error'] ?? null );
	}

	public function test_a_stolen_slot_still_reaches_the_dashboard(): void {
		// The counterpart guard: an eviction is a real fault and must surface.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		$node->fill( $this->heartbeat_error( 'remote-austin', 'SSE slot lease not owned: pointer_owner_mismatch' ) );

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertStringContainsString( 'pointer_owner_mismatch', (string) $status['last_error'] );
	}

	/**
	 * A `workers.heartbeat` error reply addressed back to the link that minted it.
	 *
	 * @return array<int,mixed> The 7-field positional message array.
	 */
	private function heartbeat_error( string $link, string $payload ): array {
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_ERROR;
		$reply[ Message::TO ]    = $link;
		$reply[ Message::VALUE ] = [
			'name'    => 'heartbeat',
			'payload' => $payload,
		];
		return $reply;
	}

	public function test_tick_publishes_status_snapshot(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		$node->fire();

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertIsArray( $status );
		$this->assertArrayHasKey( 'connected', $status );
		$this->assertArrayHasKey( 'current_backoff', $status );
		$this->assertArrayHasKey( 'last_connection_attempt', $status );
		$this->assertArrayHasKey( 'last_sse_heartbeat', $status );
	}

	public function test_publish_status_noop_when_no_cache(): void {
		Core::$memd = null;
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		// Without a cache, the tick still runs cleanly — write_status short-circuits.
		$node->fire();

		$this->assertInstanceOf( SSE_In_Node::class, Core::node( 'remote-austin:sse-in' ) );
	}

	public function test_connection_attempt_reflects_actual_connect_not_each_tick(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );

		Core::$now = 1000.0;
		$node->fire(); // queues the connect at t=1000
		$this->drain_connect_queue();

		// Later ticks keep firing without a reconnect (the handle persists), so
		// "Connected" must stay pinned to the real connect time — not creep with the tick clock.
		Core::$now = 1030.0;
		$node->fire();

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertSame( 1000, $status['last_connection_attempt'] );
	}

	public function test_published_status_carries_sse_heartbeat_receipt(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		Core::$now = 1748960000;
		$sse->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );

		$node->fire();

		$status = Core::$memd->get( Remote_Source_Node::status_key_for( 'remote-austin', 'firehose.p0' ) );
		$this->assertSame( 1748960000, $status['last_sse_heartbeat'] );
	}

	public function test_restore_position_ignores_unparseable_offsetlog_entry(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->seed_offsetlog_file( "this is not a packed message\n" );

		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		// A junk line can't be unpacked → restore yields nothing → default cursor.
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( [ 'segment' => 0, 'offset' => 0 ], $sse->position() );
	}

	public function test_restore_position_ignores_non_array_value(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = 'scalar-not-a-cursor';
		$this->seed_offsetlog_file( Message::packed( $message ) . "\n" );

		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( [ 'segment' => 0, 'offset' => 0 ], $sse->position() );
	}

	public function test_restore_position_falls_back_to_prior_segment_when_last_empty(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'segment' => 4, 'offset' => 256, '_ts' => 1 ];
		// Last segment is empty (a rotated-but-unwritten tail); the committed cursor
		// lives in the prior segment and restore must fall back to it.
		$this->seed_offsetlog_file( Message::packed( $message ) . "\n", 0 );
		$this->seed_offsetlog_file( '', 1 );

		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( [ 'segment' => 4, 'offset' => 256 ], $sse->position() );
	}

	public function test_restore_position_returns_empty_when_all_segments_empty(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		// Both the tail and the prior segment are empty — nothing to restore.
		$this->seed_offsetlog_file( '', 0 );
		$this->seed_offsetlog_file( '', 1 );

		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertSame( [ 'segment' => 0, 'offset' => 0 ], $sse->position() );
	}

	/** Write a raw offsetlog segment file (`<seg>.log`) for the default remote node. */
	private function seed_offsetlog_file( string $contents, int $segment_id = 0 ): void {
		$dir = \Newspack_Nodes\Config::get_offsets_directory() . '/remote-austin.firehose.p0';
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		\file_put_contents( "{$dir}/{$segment_id}.log", $contents );
	}

	/** Install an SSE_In connect seam returning a real idle handle (never transferred). */
	private function stub_sse_connect(): void {
		SSE_In_Node::$curl_dispatch = static function ( array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}

	/** Push an exact slot lease into an SSE_In via its `connected` handshake parser. */
	private function set_slot( SSE_In_Node $sse, int $slot, int $owner = 42424243 ): void {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = '';
		$m[ Message::KEY ]   = 'connected';
		$m[ Message::VALUE ] = "PID 9007 SLOT {$slot} OWNER {$owner}";
		$sse->process_sse_chunk( "event: connected\ndata: " . Message::packed( $m ) . "\n\n" );
	}

	/**
	 * [147] Remote_Source is a Consumer that reads over the wire, so its arguments
	 * should read like one: vault_id, remote_partition, offsetlog_dir, deadletter_dir.
	 *
	 * It used to HARDCODE both dirs (Config::get_offsets_directory(), and
	 * <base>/deadletter). That is not just an asymmetry — it means the cursor path
	 * is not something a topology can write, so it cannot carry `<topology>`, and
	 * two aggregator fleets pulling the same spoke partition would silently share
	 * one offsetlog. Every other Consumer got fleet-scoped cursors; this one could
	 * not.
	 */
	public function test_offsetlog_dir_is_an_argument_not_a_hardcoded_config_read(): void {
		$node = new Remote_Source_Node();
		$node->name( 'src-a' );
		$node->sink( new Capture_Sink_Node() );
		$node->arguments( [ "zebra-vault", "firehose.p0", "{$this->base_dir}/offsets/firehose.combined.p0", "{$this->base_dir}/dead/firehose.combined.p0" ] );

		$this->assertSame(
			"{$this->base_dir}/offsets/firehose.combined.p0",
			$this->read_private( $node, 'offsetlog_dir' )
		);
		$this->assertSame(
			"{$this->base_dir}/dead/firehose.combined.p0",
			$this->read_private( $node, 'deadletter_dir' )
		);
	}

	/** The dirs are optional, like Consumer's: empty disables checkpointing / DLQ. */
	public function test_offsetlog_dir_defaults_to_empty(): void {
		$node = new Remote_Source_Node();
		$node->name( 'src-b' );
		$node->sink( new Capture_Sink_Node() );
		$node->arguments( [ 'zebra-vault', 'firehose.p0' ] );

		$this->assertSame( '', $this->read_private( $node, 'offsetlog_dir' ) );
	}

	// ── DLQ triage: list / purge on the remote-qualified sidecar; requeue is N/A ──

	public function test_deadletter_triage_verbs_are_wired_into_the_schema(): void {
		$verbs = \array_column( Remote_Source_Node::node_schema()['commands'], 'name' );
		$this->assertContains( 'dl_list', $verbs );
		$this->assertContains( 'dl_show', $verbs );
		$this->assertContains( 'dl_requeue', $verbs );
		$this->assertContains( 'dl_purge', $verbs );
	}

	public function test_list_and_purge_operate_on_the_remote_qualified_sidecar(): void {
		[ $node ] = $this->make_remote();
		// The sidecar is named `{name}:{remote_partition}:deadletter`; build + quarantine.
		( new \ReflectionMethod( Remote_Source_Node::class, 'ensure_deadletter' ) )->invoke( $node );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'remote-poison';
		$message[ Message::ID ]    = '7:12:30';
		( new \ReflectionMethod( Remote_Source_Node::class, 'dead_letter' ) )->invoke( $node, $message, 'timeout', null );

		$page = $node->list_deadletter( 50 );
		$this->assertSame( 1, $page['total'] );
		$this->assertSame( 'timeout', $page['rows'][0]['reason'] );
		$this->assertSame( '7:12:30', $page['rows'][0]['source'] );

		$this->assertStringStartsWith( 'ok', $node->purge_deadletter() );
		$this->assertSame( 0, $node->list_deadletter( 50 )['total'] );
	}

	/**
	 * Delivering rather than re-injecting gives a remote SSE pull a working
	 * requeue: it has no local source log to append to, but it has a sink.
	 */
	public function test_requeue_redelivers_for_a_remote_source(): void {
		[ $node, $sink ] = $this->make_remote();
		( new \ReflectionMethod( Remote_Source_Node::class, 'ensure_deadletter' ) )->invoke( $node );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'remote-retry';
		$message[ Message::ID ]    = '7:12:30';
		( new \ReflectionMethod( Remote_Source_Node::class, 'dead_letter' ) )->invoke( $node, $message, 'timeout', null );

		$loc = $node->list_deadletter( 50 )['rows'][0]['locator'];

		$this->assertStringStartsWith( 'ok', $node->requeue_deadletter( $loc ) );
		$this->assertSame( [ 'remote-retry' ], \array_column( $sink->captured, Message::VALUE ) );
	}
}
