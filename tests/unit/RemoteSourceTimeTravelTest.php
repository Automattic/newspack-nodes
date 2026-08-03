<?php
namespace Newspack_Nodes\Tests\Unit;

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
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Time-travel transport on Remote_Source_Node: the same Time_Travel surface the
 * Consumer carries (frames + cursor in dump_metadata, PAUSE/PLAY/SEEK_FRAME verbs),
 * mapped onto the push-driven SSE pull — seek reconnects SSE_In from the frame's
 * committed {seg,off}; STEP is a documented no-op (a push source can't single-step).
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

	private function seed_vault( string $id, array $entry ): void {
		\update_option( Vault::OPTION_KEY, [ $id => $entry ] );
		Vault::get_instance()->reset_cache();
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
		foreach ( [ 'add_snapshot_node', 'set_line_mode', 'SEEK_FRAME', 'PAUSE', 'PLAY', 'STEP' ] as $verb ) {
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
	// SEEK_FRAME: reconnect SSE_In from a committed frame's {seg,off}.
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

	public function test_seek_frame_errors_when_segment_absent(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();

		$this->assertStringContainsString( 'no frame', $node->seek_frame( 9999 ) );
	}

	// =========================================================================
	// PAUSE / PLAY: stop and resume the pull.
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
		$this->assertSame( 'event_framework', $this->read_private( $node, 'mode' ), 'PLAY re-arms the recurring tick' );
		$this->assertSame( 'ACTIVE', $node->dump_metadata()['polling'], 'PLAY flags the polling signal ACTIVE' );
	}

	// =========================================================================
	// STEP: a documented no-op for a push-driven source (returns the position).
	// =========================================================================

	public function test_step_is_a_noop_returning_the_current_position(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		$node = $this->make_remote( 'remote-austin' );
		Core::$now = 1000.0;
		$node->fire();
		$node->next_offset( [ 'segment' => 5, 'offset' => 55 ] );

		$result = $node->step();
		$this->assertSame( [ 'segment' => 5, 'offset' => 55, 'at_eof' => true ], $result, 'STEP reports the current position without advancing' );
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
		$cmd[ Message::VALUE ] = [ 'name' => 'PAUSE', 'arguments' => '' ];
		$interpreter->fill( $cmd );

		$this->assertSame( "ok\n", $cap->captured[0][ Message::VALUE ]['payload'] );
		$this->assertSame( 'inactive', $this->read_private( $node, 'mode' ), 'PAUSE via the interpreter stops the tick' );
	}
}
