<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Remote_Link_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Remote_Link_Node::class )]
class RemoteLinkNodeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$this->use_base_dir( $this->make_temp_dir() );
		Core::$memd = new InMemoryMemcached();
		// arguments() arms a 1000ms TICK timer that router-hitchhikes (>=1000),
		// which needs _router present — as it always is in a live graph.
		( new Router_Node() )->name( '_router' );
	}

	protected function tearDown(): void {
		Core::$memd                   = null;
		SSE_In_Node::$curl_dispatch   = null;
		HTTP_Out_Node::$curl_dispatch = null;
		// The SSE_In patrons register CurlMultiHandles with the process-lifetime
		// Event_Framework singleton; reset it so handles don't leak into later suites.
		Event_Framework::reset();
		Vault::get_instance()->reset_cache();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	private function seed_vault( string $id = 'austin' ): void {
		\update_option( Vault::OPTION_KEY, [ $id => [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'token' => 't' ] ] );
		Vault::get_instance()->reset_cache();
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
		$m[ Message::KEY ]   = 'connected';
		$m[ Message::VALUE ] = "PID 1 SLOT {$slot}";
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );
	}

	/** Build a named base Remote_Link wired to a capture sink + downstream target. */
	private function make_link( string $name = 'link-austin', string $args = 'austin firehose.p0' ): array {
		$node = new Remote_Link_Node();
		$node->name( $name );
		$sink = new Capture_Sink_Node();
		$sink->name( 'downstream' );
		$node->sink( $sink );
		$node->target( 'downstream' );
		$node->arguments( $args );
		return [ $node, $sink ];
	}

	// ---------------------------------------------------------------------
	// arguments() + schema.
	// ---------------------------------------------------------------------

	public function test_arguments_parses_positional_tokens_and_arms_timer(): void {
		[ $node ] = $this->make_link();
		$this->assertSame( 'austin', $this->read_private( $node, 'vault_id' ) );
		$this->assertSame( 'firehose.p0', $this->read_private( $node, 'remote_partition' ) );
		$this->assertGreaterThan( 0, $node->interval_ms );
		$this->assertFalse( $node->oneshot );
	}

	public function test_arguments_null_returns_canonical_form(): void {
		[ $node ] = $this->make_link();
		$this->assertSame( 'austin firehose.p0', $node->arguments( null ) );
	}

	public function test_node_schema_is_visible_io_not_fillable(): void {
		$schema = Remote_Link_Node::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertArrayNotHasKey( 'hidden', $schema );
		$this->assertFalse( $schema['accepts_fill'] );
		$names = \array_column( $schema['arguments'], 'name' );
		$this->assertSame( [ 'vault_id', 'remote_partition' ], $names );
	}

	public function test_vault_id_arg_uses_vault_id_type(): void {
		$schema = Remote_Link_Node::node_schema();
		$this->assertSame( 'vault_id', $schema['arguments'][0]['name'] );
		$this->assertSame( 'vault_id', $schema['arguments'][0]['type'] );
	}

	// ---------------------------------------------------------------------
	// Patron lifecycle — ensure_patrons.
	// ---------------------------------------------------------------------

	public function test_first_fire_creates_and_configures_patrons(): void {
		$this->seed_vault();
		[ $node, $sink ] = $this->make_link( 'link-austin' );

		$node->fire();

		$sse = Core::node( 'link-austin:sse-in' );
		$this->assertInstanceOf( SSE_In_Node::class, $sse );
		$this->assertSame( 'https://austin.example', $this->read_private( $sse, 'url' ) );
		$this->assertSame( 'u', $this->read_private( $sse, 'auth_username' ) );
		$this->assertSame( 'firehose.p0', $this->read_private( $sse, 'subscribe' ) );
		// SSE_In forwards to the link's OWN downstream target, not back to it.
		$this->assertSame( $sink, $sse->sink() );
		$this->assertSame( 'downstream', $sse->target() );

		$http = Core::node( 'link-austin:http-out' );
		$this->assertInstanceOf( HTTP_Out_Node::class, $http );
		$this->assertSame( 'austin', $this->read_private( $http, 'vault_id' ) );
	}

	public function test_ensure_patrons_idempotent_returns_same_sse(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();
		$first = Core::node( 'link-austin:sse-in' );

		$node->fire();
		$this->assertSame( $first, Core::node( 'link-austin:sse-in' ) );
	}

	public function test_missing_vault_entry_stays_disconnected_no_patrons(): void {
		[ $node ] = $this->make_link( 'link-ghost', 'ghost firehose.p0' );

		$node->fire();

		$this->assertNull( Core::node( 'link-ghost:sse-in' ) );
		$this->assertNull( Core::node( 'link-ghost:http-out' ) );
	}

	public function test_vault_entry_without_url_stays_disconnected(): void {
		\update_option( Vault::OPTION_KEY, [ 'austin' => [ 'url' => '', 'auth_username' => 'u' ] ] );
		Vault::get_instance()->reset_cache();
		[ $node ] = $this->make_link( 'link-austin' );

		$node->fire();

		$this->assertNull( Core::node( 'link-austin:sse-in' ) );
	}

	// ---------------------------------------------------------------------
	// fill() — reply bookkeeping vs send relay.
	// ---------------------------------------------------------------------

	public function test_fill_relays_non_command_message_through_http_out(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ] = 'payload';
		$node->fill( $m );

		$http  = Core::node( 'link-austin:http-out' );
		$batch = $this->read_private( $http, 'batch' );
		$this->assertCount( 1, $batch );
		$this->assertSame( 'payload', $batch[0][ Message::VALUE ] );
	}

	public function test_fill_command_response_is_reply_not_relayed(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );

		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::TO ]    = 'link-austin';
		$reply[ Message::VALUE ] = [ 'success' => true ];
		$node->fill( $reply );

		// A reply is RTT bookkeeping — it neither relays nor creates patrons.
		$this->assertNull( Core::node( 'link-austin:http-out' ) );
	}

	public function test_fill_command_error_is_reply_not_relayed(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );

		$reply                  = Message::new_message();
		$reply[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_ERROR;
		$reply[ Message::TO ]   = 'link-austin';
		$node->fill( $reply );

		$this->assertNull( Core::node( 'link-austin:http-out' ) );
	}

	// ---------------------------------------------------------------------
	// Heartbeat — minted as a workers.heartbeat command through HTTP_Out.
	// ---------------------------------------------------------------------

	public function test_heartbeat_skipped_when_slot_unknown(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$http = Core::node( 'link-austin:http-out' );
		$this->assertCount( 0, $this->read_private( $http, 'batch' ) );
	}

	public function test_heartbeat_minted_into_http_out_when_slot_known(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$sse = Core::node( 'link-austin:sse-in' );
		$this->set_slot( $sse, 5 );

		// Past the heartbeat interval, under the stale timeout.
		Core::$now = \microtime( true ) + Remote_Link_Node::HEARTBEAT_INTERVAL + 1;
		$node->fire();

		$batch = $this->read_private( Core::node( 'link-austin:http-out' ), 'batch' );
		$this->assertCount( 1, $batch );
		$envelope = $batch[0];
		$this->assertSame( Message::TM_COMMAND, $envelope[ Message::TYPE ] );
		$this->assertSame( 'link-austin', $envelope[ Message::FROM ] );
		$this->assertSame( 'workers', $envelope[ Message::TO ] );
		$value = $envelope[ Message::VALUE ];
		$this->assertSame( 'heartbeat', $value['name'] );
		[ $slot, $ttl ] = \explode( ' ', $value['arguments'] );
		$this->assertSame( '5', $slot );
		$this->assertGreaterThan( Remote_Link_Node::HEARTBEAT_INTERVAL, (int) $ttl );
	}

	// The dashboard status snapshot (publish_status / record_heartbeat_* / write_status)
	// is Remote_Source-only now — the base publishes nothing, so those cases live in
	// RemoteSourceNodeTest. The base still SENDS the slot-keepalive heartbeat (above).

	// ---------------------------------------------------------------------
	// connect / close / is_streaming.
	// ---------------------------------------------------------------------

	public function test_connect_opens_the_inbound_stream(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );

		$node->connect();

		$this->assertTrue( Core::node( 'link-austin:sse-in' )->connection()['connected'] );
	}

	public function test_close_disconnects_the_stream(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->connect();
		$this->assertTrue( Core::node( 'link-austin:sse-in' )->connection()['connected'] );

		$node->close();

		$this->assertFalse( Core::node( 'link-austin:sse-in' )->connection()['connected'] );
	}

	public function test_close_before_patrons_is_safe(): void {
		[ $node ] = $this->make_link( 'link-austin' );
		$node->close();
		$this->assertNull( Core::node( 'link-austin:sse-in' ) );
	}

	public function test_is_streaming_reflects_live_connection(): void {
		$this->seed_vault();
		$this->stub_sse_connect();
		[ $node ] = $this->make_link( 'link-austin' );

		$ref = new \ReflectionMethod( $node, 'is_streaming' );
		$this->assertFalse( $ref->invoke( $node ) );

		$node->connect();
		$this->assertTrue( $ref->invoke( $node ) );
	}

	// ---------------------------------------------------------------------
	// connect_node — target propagation.
	// ---------------------------------------------------------------------

	public function test_connect_node_propagates_target_to_sse_in(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();

		$node->connect_node( 'new-downstream' );

		$this->assertSame( 'new-downstream', $this->read_private( $node, 'target' ) );
		$this->assertSame( 'new-downstream', Core::node( 'link-austin:sse-in' )->target() );
	}

	public function test_connect_node_before_patrons_only_sets_target(): void {
		[ $node ] = $this->make_link( 'link-austin' );
		$node->connect_node( 'new-downstream' );
		$this->assertSame( 'new-downstream', $this->read_private( $node, 'target' ) );
	}

	// ---------------------------------------------------------------------
	// Composite-node stat delegation to the patrons.
	// ---------------------------------------------------------------------

	public function test_stats_default_to_zero_before_patrons(): void {
		[ $node ] = $this->make_link( 'link-austin' );
		$this->assertSame( 0, $node->bytes_read() );
		$this->assertSame( 0, $node->bytes_written() );
		$this->assertSame( 0, $node->largest_msg_sent() );
	}

	public function test_stats_delegate_to_patrons_once_built(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();
		$sse = Core::node( 'link-austin:sse-in' );

		$sse->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::KEY ]   = 'k';
		$m[ Message::VALUE ] = [ 'a' => 1 ];
		$sse->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );

		$this->assertGreaterThan( 0, $sse->bytes_read() );
		$this->assertSame( $sse->bytes_read(), $node->bytes_read() );
		$this->assertSame( $sse->counter(), $node->counter() );
		$this->assertSame( $sse->largest_msg_sent(), $node->largest_msg_sent() );
	}

	// ---------------------------------------------------------------------
	// remove_node — patron teardown.
	// ---------------------------------------------------------------------

	public function test_remove_node_tears_down_both_patrons(): void {
		$this->seed_vault();
		[ $node ] = $this->make_link( 'link-austin' );
		$node->fire();
		$this->assertInstanceOf( SSE_In_Node::class, Core::node( 'link-austin:sse-in' ) );
		$this->assertInstanceOf( HTTP_Out_Node::class, Core::node( 'link-austin:http-out' ) );

		$node->remove_node();

		$this->assertNull( Core::node( 'link-austin:sse-in' ) );
		$this->assertNull( Core::node( 'link-austin:http-out' ) );
	}
}
