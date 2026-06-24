<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Remote_Source_Node;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Remote_Source_Node::class )]
class RemoteSourceNodeTest extends TestCase {

	private string $base_dir = '';

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir();
		$this->use_base_dir( $this->base_dir );
		Core::$memd = new InMemoryMemcached();
	}

	protected function tearDown(): void {
		Core::$memd                = null;
		SSE_In_Node::$curl_dispatch = null;
		HTTP_Out_Node::$curl_dispatch = null;
		Vault::get_instance()->reset_cache();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	private function seed_vault( string $id, array $entry ): void {
		\update_option( Vault::OPTION_KEY, [ $id => $entry ] );
		Vault::get_instance()->reset_cache();
	}

	/** Build a named Remote_Source wired to a capture sink + downstream target. */
	private function make_remote( string $name = 'remote-austin', string $args = 'austin firehose.p0' ): array {
		$node = new Remote_Source_Node();
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

	public function test_first_tick_creates_and_configures_sse_in_patron(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node, $sink ] = $this->make_remote( 'remote-austin' );

		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertSame( 'https://austin.example', $this->read_private( $sse, 'url' ) );
		$this->assertSame( 'u', $this->read_private( $sse, 'auth_username' ) );
		$this->assertSame( 'firehose.p0', $this->read_private( $sse, 'subscribe' ) );
		// SSE_In forwards to the Remote_Source's OWN downstream target, not back to it.
		$this->assertSame( $sink, $sse->sink() );
		$this->assertSame( 'downstream', $sse->target() );
	}

	public function test_first_tick_creates_http_out_patron(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		$node->fire();

		$http = Core::node( 'remote-austin:http-out' );
		$this->assertInstanceOf( HTTP_Out_Node::class, $http );
		$this->assertSame( 'austin', $this->read_private( $http, 'server_id' ) );
	}

	public function test_missing_vault_entry_stays_disconnected_no_patrons(): void {
		[ $node ] = $this->make_remote( 'remote-ghost', 'ghost firehose.p0' );

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
	}

	public function test_node_schema_visible_io_with_args(): void {
		$schema = Remote_Source_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertArrayNotHasKey( 'hidden', $schema );
		$names = \array_column( $schema['arguments'], 'name' );
		$this->assertSame( [ 'vault_id', 'remote_partition' ], $names );
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
		$pre->arguments( $dir );
		$entry                       = Message::new_message();
		$entry[ Message::TYPE ]      = Message::TM_STRUCT;
		$entry[ Message::VALUE ]     = [ 'seg' => 4, 'off' => 256, '_ts' => 123 ];
		$pre->fill( $entry );
		$pre->flush();

		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertSame( [ 'segment_id' => 4, 'offset' => 256 ], $sse->position() );
	}

	public function test_fire_commits_position_from_sse_in(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$sse = Core::node( 'remote-austin:sse-in' );
		$sse->restore_position( 7, 99 );

		// Advance clock past the commit interval and tick again.
		Core::$now = \microtime( true ) + 100;
		$node->fire();

		$offsetlog = $this->read_private( $node, 'offsetlog' );
		$this->assertInstanceOf( Partition_Node::class, $offsetlog );
		$segments = $offsetlog->get_segments( true );
		$this->assertNotEmpty( $segments );
		$last    = \end( $segments );
		$content = $offsetlog->read_at( $last['id'], 0, $last['size'] );
		$lines   = \explode( "\n", \rtrim( $content, "\n" ) );
		$message = Message::unpacked( \end( $lines ) );
		$value   = $message[ Message::VALUE ];
		$this->assertSame( 7, $value['seg'] );
		$this->assertSame( 99, $value['off'] );
	}

	public function test_heartbeat_skipped_when_slot_unknown(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		$http = Core::node( 'remote-austin:http-out' );
		$this->assertCount( 0, $this->read_private( $http, 'batch' ) );
	}

	public function test_heartbeat_command_filled_into_http_out_when_slot_known(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );
		$node->fire();

		// Give the SSE_In a slot via the connected handshake.
		$sse = Core::node( 'remote-austin:sse-in' );
		$this->set_slot( $sse, 5 );

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
		// args: <slot> <ttl> — ttl must outlive the heartbeat interval.
		[ $slot, $ttl ] = \explode( ' ', $value['arguments'] );
		$this->assertSame( '5', $slot );
		$this->assertGreaterThan( Remote_Source_Node::HEARTBEAT_INTERVAL, (int) $ttl );
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
		$reply                  = Message::new_message();
		$reply[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]   = 'remote-austin';
		$reply[ Message::VALUE ] = [ 'success' => true ];
		$node->fill( $reply );

		$status = Core::$memd->get( 'np:remote:remote-austin:firehose.p0' );
		$this->assertIsArray( $status );
		$this->assertArrayHasKey( 'last_heartbeat_response', $status );
		$this->assertArrayHasKey( 'last_heartbeat_rtt', $status );
		$this->assertNotNull( $status['last_heartbeat_response'] );
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
		$reply[ Message::VALUE ] = [ 'success' => true ];
		$node->fill( $reply ); // records last_heartbeat_response at t=1000

		// A tick right after the reply keeps the fresh response in the snapshot.
		$node->fire();
		$this->assertNotNull(
			Core::$memd->get( 'np:remote:remote-austin:firehose.p0' )['last_heartbeat_response']
		);

		// No further reply; advance past the HEARTBEAT_INTERVAL*4 staleness window.
		// The Status badge must not latch 'success' on a stale timestamp, so the
		// snapshot ages the response out to null (mirrors the old clear-on-disconnect).
		Core::$now = 1000.0 + ( Remote_Source_Node::HEARTBEAT_INTERVAL * 4 ) + 5;
		$node->fire();
		$status = Core::$memd->get( 'np:remote:remote-austin:firehose.p0' );
		$this->assertNull( $status['last_heartbeat_response'] );
		$this->assertNull( $status['last_heartbeat_rtt'] );
	}

	public function test_tick_publishes_status_snapshot(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		[ $node ] = $this->make_remote( 'remote-austin' );

		$node->fire();

		$status = Core::$memd->get( 'np:remote:remote-austin:firehose.p0' );
		$this->assertIsArray( $status );
		$this->assertArrayHasKey( 'connected', $status );
		$this->assertArrayHasKey( 'current_backoff', $status );
		$this->assertArrayHasKey( 'last_connection_attempt', $status );
		$this->assertArrayHasKey( 'last_sse_heartbeat', $status );
	}

	public function test_connection_attempt_reflects_actual_connect_not_each_tick(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$this->stub_sse_connect();
		[ $node ] = $this->make_remote( 'remote-austin' );

		Core::$now = 1000.0;
		$node->fire(); // opens the connection at t=1000

		// Later ticks keep firing without a reconnect (the handle persists), so
		// "Connected" must stay pinned to the real connect time — not creep with the tick clock.
		Core::$now = 1030.0;
		$node->fire();

		$status = Core::$memd->get( 'np:remote:remote-austin:firehose.p0' );
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

		$status = Core::$memd->get( 'np:remote:remote-austin:firehose.p0' );
		$this->assertSame( 1748960000, $status['last_sse_heartbeat'] );
	}

	/** Install an SSE_In connect seam returning a real idle handle (never transferred). */
	private function stub_sse_connect(): void {
		SSE_In_Node::$curl_dispatch = static function ( \CurlMultiHandle $multi, array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}

	/** Push a slot into an SSE_In via its `connected` handshake parser. */
	private function set_slot( SSE_In_Node $sse, int $slot ): void {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = '';
		$m[ Message::KEY ]   = 'connected';
		$m[ Message::VALUE ] = [ 'slot' => $slot ];
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );
	}
}
