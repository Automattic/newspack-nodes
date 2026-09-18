<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Remote_Source_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * Time-travel transport on Remote_Source_Node: the same Time_Travel surface the
 * Consumer carries (frames + cursor in dump_metadata, `pause`/`play`/`seek_frame` verbs),
 * mapped onto the push-driven SSE pull — seek reconnects SSE_In from the frame's
 * committed {seg,off}; `step` forwards one record, from the buffer or a reconnected pull.
 */
#[CoversClass( Remote_Source_Node::class )]
class RemoteSourceTimeTravelTest extends TestCase {

	private string $base_dir = '';

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir();
		$this->use_base_dir( $this->base_dir );
		Core::$memd = new InMemoryMemcached();
		( new Router_Node() )->name( '_router' );
	}

	protected function tearDown(): void {
		Core::$memd                   = null;
		SSE_In_Node::$curl_dispatch   = null;
		HTTP_Out_Node::$curl_dispatch = null;
		Event_Framework::reset();
		Vault::get_instance()->reset_cache();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		Config::reset();
		parent::tearDown();
	}

	/** Stub the SSE dispatch; optionally capture each connect's opts. */
	private function stub_sse_connect( ?array &$captured = null ): void {
		SSE_In_Node::$curl_dispatch = static function ( array $opts ) use ( &$captured ): \CurlHandle {
			if ( null !== $captured ) {
				$captured[] = $opts;
			}
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}

	/**
	 * Build a named, wired Remote_Source pulling firehose.p0 from the austin vault entry.
	 *
	 * @param list<string>|null $args Positional ctor tokens (null = derive the default set).
	 */
	private function make_remote( string $name = 'remote-austin', ?array $args = null ): Remote_Source_Node {
		// The dirs are ARGUMENTS, like Consumer's — there is no derived fallback.
		$offsets = \Newspack_Nodes\Config::get_offsets_directory();
		$base    = \rtrim( \Newspack_Nodes\Config::get_base_directory(), '/' );
		$args  ??= [ 'austin', 'firehose.p0', "{$offsets}/{$name}.firehose.p0", "{$base}/deadletter/{$name}.firehose.p0" ];
		$node    = new Remote_Source_Node();
		$node->name( $name );
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$node->sink( $sink );
		$node->target( 'downstream' );
		$node->arguments( $args );
		return $node;
	}

	/** Decode the `positions` map for a connect's opts URL, keyed by subscribe dir. */
	private function positions_from_opts( array $opts ): array {
		$url = (string) ( $opts[ \CURLOPT_URL ] ?? '' );
		$qs  = \parse_url( $url, \PHP_URL_QUERY );
		\parse_str( Core::str( $qs ), $params );
		$raw = $params['positions'] ?? '';
		$dec = \json_decode( Core::str( $raw ), true );
		return Core::arr( $dec );
	}

	// =========================================================================
	// Schema: the shared time-travel verbs are registered on Remote_Source too.
	// =========================================================================

	public function test_node_schema_registers_the_time_travel_verbs(): void {
		$schema = Remote_Source_Node::node_schema();
		$verbs  = \array_column( $schema['commands'], 'name' );
		foreach ( [ 'add_snapshot_node', 'set_line_mode', 'seek_frame', 'pause', 'play', 'step' ] as $verb ) {
			$this->assertContains( $verb, $verbs, "Remote_Source must register the {$verb} verb" );
		}
	}

	public function test_dump_config_roundtrips_add_snapshot_node(): void {
		$node = $this->make_remote( 'remote-austin' );
		$node->add_snapshot_node( 'flame-builder' );

		$this->assertStringContainsString(
			'command_node remote-austin:config add_snapshot_node flame-builder',
			$node->dump_config(),
			'Remote_Source shares the Time_Travel surface and must round-trip its snapshot node too'
		);
	}

	// =========================================================================
	// dump_metadata: the frames + cursor read surface the panel gates on.
	// =========================================================================

	public function test_dump_metadata_emits_frames_array_and_cursor(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire(); // creates + connects SSE_In, commits a first frame.

		$meta = $node->dump_metadata();
		$this->assertIsArray( $meta['frames'], 'frames must be an array so the panel renders' );
		$this->assertArrayHasKey( 'segment', $meta['cursor'] );
		$this->assertArrayHasKey( 'offset', $meta['cursor'] );
	}

	public function test_dump_metadata_cursor_reports_the_node_cursor(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();

		// The reported cursor is the node-owned after-forward cursor, set here via a seek.
		$node->next_offset( [ 'segment' => 4, 'offset' => 42 ] );

		$meta = $node->dump_metadata();
		$this->assertSame( [ 'segment' => 4, 'offset' => 42 ], $meta['cursor'], 'cursor reports the node-owned read position' );
	}

	// =========================================================================
	// `seek_frame`: reconnect SSE_In from a committed frame's {seg,off}.
	// =========================================================================

	public function test_seek_frame_reseeds_sse_position_from_the_committed_frame(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		// Commit a durable frame at a known remote {seg,off} via the node cursor.
		$node->next_offset( [ 'segment' => 7, 'offset' => 128 ] );
		$node->checkpoint_shutdown();
		$segment_id = \end( $node->dump_metadata()['frames'] )['id'];

		// Drift the cursor away, then seek back to the committed frame.
		$node->next_offset( [ 'segment' => 3, 'offset' => 3 ] );
		$node->pause();
		$this->assertSame( "ok\n", $node->seek_frame( $segment_id ) );

		$this->assertSame(
			[ 'segment' => 7, 'offset' => 128 ],
			$sse->position(),
			'seek reconnects SSE_In from the frame offset'
		);
	}

	public function test_reconnect_after_seek_pulls_from_the_seeked_offset(): void {
		$captured = [];
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect( $captured );
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );

		$node->next_offset( [ 'segment' => 7, 'offset' => 128 ] );
		$node->checkpoint_shutdown();
		$segment_id = \end( $node->dump_metadata()['frames'] )['id'];

		$node->pause();
		$node->seek_frame( $segment_id );

		// The next reconnect must carry the seeked position in its request.
		Core::$now = 1100.0; // past backoff so maybe_connect fires.
		$sse->maybe_connect();

		$positions = $this->positions_from_opts( \end( $captured ) );
		$this->assertSame(
			[ 'segment' => 7, 'offset' => 128 ],
			$positions['firehose.p0'] ?? null,
			'the reconnect request replays from the seeked frame offset'
		);
	}

	public function test_seek_frame_refuses_when_segment_absent(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'no frame at segment 9999' );
		$node->seek_frame( 9999 );
	}

	// =========================================================================
	// `pause` / `play`: stop and resume the pull.
	// =========================================================================

	public function test_pause_disconnects_the_pull_and_flags_paused(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( \CurlHandle::class, $sse->test_get_handle(), 'precondition: connected' );

		$node->pause();

		$this->assertNull( $sse->test_get_handle(), 'pause drops the SSE stream (stops the pull)' );
		$this->assertSame( 'PAUSED', $node->dump_metadata()['polling'], 'pause flags the polling signal PAUSED' );
		$this->assertSame( 'inactive', $this->read_private( $node, 'mode' ), 'pause stops the tick timer' );
	}

	public function test_play_rearms_the_tick_timer(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();

		$node->pause();
		$this->assertSame( 'inactive', $this->read_private( $node, 'mode' ), 'precondition: paused' );

		$node->play();
		// 100ms tick = own framework slot (<1000ms never router-hitchhikes).
		$this->assertSame( 'event_framework', $this->read_private( $node, 'mode' ), '`play` re-arms the recurring tick' );
		$this->assertSame( 'ACTIVE', $node->dump_metadata()['polling'], '`play` flags the polling signal ACTIVE' );
	}

	// =========================================================================
	// `step`: forward exactly one record, from the buffer or the reconnected pull.
	// =========================================================================

	/** Deliver one spoke record, breadcrumb `$seg:$off:$len`, through SSE_In. */
	private function deliver( SSE_In_Node $sse, string $crumb, string $value ): void {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::ID ]    = $crumb;
		$m[ Message::VALUE ] = $value;
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );
	}

	/** The spoke's `connected` handshake, naming the stream's first position. */
	private function handshake( SSE_In_Node $sse, string $cursors ): void {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_INFO;
		$m[ Message::KEY ]   = 'connected';
		$m[ Message::VALUE ] = "PID 9007 SLOT 7 OWNER 42424243 CURSORS {$cursors}";
		$sse->process_sse_chunk( "event: connected\ndata: " . Message::packed( $m ) . "\n\n" );
	}

	/** Values the downstream sink has received, in order. */
	private function forwarded(): array {
		return \array_column( Core::node( 'downstream' )->captured, Message::VALUE );
	}

	public function test_a_step_taken_from_the_buffer_keeps_the_tick_paying_the_one_owed(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->next_offset( [ 'segment' => 7, 'offset' => 1 ] );
		$node->pause();
		$node->step(); // nothing buffered: owed one
		Core::$now = 1001.0;
		$node->fire();
		$this->drain_connect_queue();
		$this->deliver( $sse, '7:1:20', 'first-707' );
		$this->deliver( $sse, '7:21:20', 'second-808' );

		$node->step(); // a record is buffered: taken at once
		$this->assertSame( [ 'first-707' ], $this->forwarded() );
		$this->assertNotSame( 'inactive', $this->read_private( $node, 'mode' ), 'the owed step still has a tick to land on' );

		$node->fire();
		$this->assertSame( [ 'first-707', 'second-808' ], $this->forwarded(), 'two clicks, two records' );
		$this->assertSame( 'inactive', $this->read_private( $node, 'mode' ) );
		$this->assertSame( 'PAUSED', $node->dump_metadata()['polling'] );
	}

	public function test_step_with_nothing_buffered_pulls_exactly_one_record_then_holds(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->next_offset( [ 'segment' => 7, 'offset' => 1 ] );
		$node->pause();

		$node->step();
		$this->assertSame( [], $this->forwarded(), 'nothing to forward until the pull answers' );
		$this->assertNotSame( 'inactive', $this->read_private( $node, 'mode' ), 'the tick runs to reconnect' );

		Core::$now = 1001.0;
		$node->fire();
		$this->drain_connect_queue();
		$this->assertInstanceOf( \CurlHandle::class, $sse->test_get_handle(), 'the pull reconnects' );
		$this->deliver( $sse, '7:1:20', 'pulled-909' );
		$this->deliver( $sse, '7:21:20', 'held-1010' );
		$node->fire();

		$this->assertSame( [ 'pulled-909' ], $this->forwarded(), 'exactly one record per step' );
		$this->assertNull( $sse->test_get_handle(), 'the pull drops again once the step lands' );
		$this->assertSame( 'inactive', $this->read_private( $node, 'mode' ), 'and the tick stops' );
		$this->assertSame( 'PAUSED', $node->dump_metadata()['polling'] );
	}

	public function test_two_steps_before_the_pull_answers_forward_two_records(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->next_offset( [ 'segment' => 7, 'offset' => 1 ] );
		$node->pause();
		$node->step();
		$node->step();

		Core::$now = 1001.0;
		$node->fire();
		$this->drain_connect_queue();
		$this->deliver( $sse, '7:1:20', 'one-515' );
		$this->deliver( $sse, '7:21:20', 'two-616' );
		$this->deliver( $sse, '7:41:20', 'three-717' );
		$node->fire();
		$node->fire();
		$node->fire();

		$this->assertSame( [ 'one-515', 'two-616' ], $this->forwarded(), 'one record per click, and no more' );
		$this->assertSame( 'inactive', $this->read_private( $node, 'mode' ) );
	}

	public function test_play_after_pause_forwards_each_record_once(): void {
		$captured = [];
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect( $captured );
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->next_offset( [ 'segment' => 7, 'offset' => 1 ] );
		$this->deliver( $sse, '7:1:20', 'a-111' );
		$this->deliver( $sse, '7:21:20', 'b-222' );
		$node->pause();

		$node->play();
		Core::$now = 1001.0;
		$node->fire();
		$this->drain_connect_queue();

		$this->assertSame(
			[ 'segment' => 7, 'offset' => 41 ],
			$this->positions_from_opts( \end( $captured ) )['firehose.p0'] ?? null,
			'the reconnect asks past everything already held'
		);
		$this->deliver( $sse, '7:41:20', 'c-333' );
		$node->poll();

		$this->assertSame( [ 'a-111', 'b-222', 'c-333' ], $this->forwarded() );
	}

	public function test_a_step_from_the_buffer_still_ends_with_the_stream_dropped(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->deliver( $sse, '7:1:20', 'live-626' );
		$this->deliver( $sse, '7:21:20', 'live-727' );

		$node->step(); // a live source, stepped: one record from the buffer
		$this->assertSame( [ 'live-626' ], $this->forwarded() );
		$this->assertNotSame( 'inactive', $this->read_private( $node, 'mode' ), 'one tick left to settle the pause' );

		$node->fire();
		$this->assertNull( $sse->test_get_handle(), 'the stream drops, lease and all' );
		$this->assertSame( 'inactive', $this->read_private( $node, 'mode' ) );
	}

	public function test_a_reconnect_reopens_the_valve_the_last_stream_closed(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$this->drain_connect_queue();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->set_line_mode( true );
		$payload = \str_repeat( 'x', 2048 );
		for ( $i = 0; $i < 300; $i++ ) {
			$this->deliver( $sse, '7:' . ( 1 + 2100 * $i ) . ':2100', $payload );
		}
		$this->assertFalse( $this->read_private( $node, 'pump_armed' ), 'precondition: the valve closed' );
		$node->pause();

		$node->play();
		Core::$now = 1001.0;
		$node->fire();
		$this->drain_connect_queue();

		$this->assertTrue( $this->read_private( $node, 'pump_armed' ), 'the new stream opens armed' );
		$this->deliver( $sse, '7:630001:2100', $payload );
		$this->assertFalse( $this->read_private( $node, 'pump_armed' ), 'and closes again over the mark' );
	}

	public function test_a_seek_without_a_patron_still_forgives_a_step(): void {
		// No Vault entry, so no patron: nothing to pull, and nothing may stay owed.
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->pause();
		$node->step();

		$node->next_offset( [ 'segment' => 3, 'offset' => 33 ] );
		Core::$now = 1001.0;
		$node->fire();

		$this->assertSame( 'inactive', $this->read_private( $node, 'mode' ) );
	}

	public function test_a_seek_forgives_a_step_still_owed(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$node->next_offset( [ 'segment' => 7, 'offset' => 1 ] );
		$node->pause();
		$node->step(); // owed one

		$node->next_offset( [ 'segment' => 3, 'offset' => 33 ] );
		Core::$now = 1001.0;
		$node->fire();

		$this->assertSame( 'inactive', $this->read_private( $node, 'mode' ), 'the seek leaves nothing owed' );
	}

	public function test_a_paused_tick_writes_no_frame(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$sse = Core::node( 'remote-austin:sse-in' );
		$node->next_offset( [ 'segment' => 7, 'offset' => 1 ] );
		$node->checkpoint_shutdown();
		$node->pause();
		$node->step(); // owed one
		Core::$now = 5000.0; // well past the checkpoint interval
		$node->fire();
		$this->drain_connect_queue();
		$this->deliver( $sse, '7:1:20', 'stepped-828' );
		Core::$now = 9000.0; // the landing tick is due a checkpoint too
		$node->fire();

		$this->assertSame( [ 'stepped-828' ], $this->forwarded() );
		$this->assertSame( 1, $this->read_private( $node, 'checkpoint_offset' ), 'a step commits no cursor' );
	}

	public function test_pause_cancels_a_pending_step(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$node->next_offset( [ 'segment' => 7, 'offset' => 1 ] );
		$node->pause();
		$node->step();

		$node->pause();

		$this->assertSame( 'inactive', $this->read_private( $node, 'mode' ) );
		$this->assertNull( Core::node( 'remote-austin:sse-in' )->test_get_handle() );
	}

	// =========================================================================
	// Verb dispatch through the auto-wired {name}:config interpreter.
	// =========================================================================

	public function test_time_travel_verbs_dispatch_through_config_interpreter(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();

		$interpreter = $this->read_private( $node, 'interpreter' );
		$this->assertNotNull( $interpreter, 'Remote_Source auto-wires a {name}:config interpreter for its verbs' );
		$cap = new Capture_Sink_Node();
		$interpreter->sink( $cap );

		$cmd                   = Message::new_message();
		$cmd[ Message::TYPE ]  = Message::TM_COMMAND;
		$cmd[ Message::FROM ]  = 'asker';
		$cmd[ Message::TO ]    = '';
		$cmd[ Message::LOCAL ] = true;
		$cmd[ Message::VALUE ] = [ 'name' => 'pause', 'arguments' => '' ];
		$interpreter->fill( $cmd );

		$this->assertSame( "ok\n", $cap->captured[0][ Message::VALUE ]['payload'] );
		$this->assertSame( 'inactive', $this->read_private( $node, 'mode' ), '`pause` via the interpreter stops the tick' );
	}
}
