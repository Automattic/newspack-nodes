<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;

#[CoversClass( SSE_In_Node::class )]
class SseInTest extends TestCase {

	protected function tearDown(): void {
		SSE_In_Node::$curl_dispatch = null;
		parent::tearDown();
	}

	/** Build a configured SSE_In node wired to a capture sink with a target. */
	private function configured_node( array $positions = [] ): array {
		$node = new SSE_In_Node();
		$node->name( 'sse-in' );
		$sink = new Capture_Sink_Node();
		$sink->name( 'merger' );
		$node->sink( $sink );
		$node->target( 'merger' );
		$node->configure(
			'https://austin.example',
			'u',
			'p',
			'',
			'firehose.p0',
			$positions,
			true,
			false
		);
		return [ $node, $sink ];
	}

	/** Build a `msg` SSE frame whose data is a packed 7-field Message envelope. */
	private function msg_frame( string $id, string $key, $value ): string {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = $id;
		$m[ Message::KEY ]   = $key;
		$m[ Message::VALUE ] = $value;
		return "event: msg\ndata: " . Message::packed( $m ) . "\n\n";
	}

	/** Build a `connected` SSE frame (its own event type, mirroring `heartbeat`). */
	private function connected_frame( $value ): string {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_INFO;
		$m[ Message::KEY ]   = 'connected';
		$m[ Message::VALUE ] = $value;
		return "event: connected\ndata: " . Message::packed( $m ) . "\n\n";
	}

	/** Build a terminal `disconnect` SSE frame. */
	private function disconnect_frame( string $key, string $value ): string {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_ERROR;
		$m[ Message::KEY ]   = $key;
		$m[ Message::VALUE ] = $value;
		return "event: disconnect\ndata: " . Message::packed( $m ) . "\n\n";
	}

	public function test_bytes_read_accumulates_received_wire_bytes(): void {
		[ $node ] = $this->configured_node();
		$chunk1   = "event: heartbeat\ndata: {}\n\n";
		$chunk2   = $this->msg_frame( '1:0', 'k', [ 'a' => 1 ] );
		$node->process_sse_chunk( $chunk1 );
		$node->process_sse_chunk( $chunk2 );
		$this->assertSame(
			\strlen( $chunk1 ) + \strlen( $chunk2 ),
			$node->bytes_read()
		);
	}

	public function test_largest_msg_sent_tracks_the_biggest_forwarded_msg(): void {
		[ $node ] = $this->configured_node();
		$node->process_sse_chunk( $this->msg_frame( '1:0', 'k', [ 'a' => 1 ] ) );
		$small = $node->largest_msg_sent();
		$this->assertGreaterThan( 0, $small );
		$node->process_sse_chunk(
			$this->msg_frame( '2:0', 'k', [ 'blob' => \str_repeat( 'x', 1000 ) ] )
		);
		$this->assertGreaterThan( $small, $node->largest_msg_sent() );
		$this->assertGreaterThanOrEqual( 1000, $node->largest_msg_sent() );
	}

	public function test_counter_advances_once_per_delivered_msg_event(): void {
		// The per-node dashboard stat re-exports SSE_In's counter (via Remote_Link_Node), so the
		// increment belongs at the delivery point here — NOT on Remote_Source_Node, whose counter
		// nothing reads. Each `msg` event must bump it exactly once.
		[ $node ] = $this->configured_node();
		$this->assertSame( 0, $node->counter() );
		$node->process_sse_chunk( $this->msg_frame( '1:0', 'k', [ 'a' => 1 ] ) );
		$node->process_sse_chunk( $this->msg_frame( '2:0', 'k', [ 'b' => 2 ] ) );
		$this->assertSame( 2, $node->counter(), 'counter advances once per delivered msg event' );
	}

	public function test_counter_ignores_non_msg_events(): void {
		// Liveness (`heartbeat`) and the bookkeeping `connected` handshake both return before the
		// `msg` branch, so neither may inflate the message counter.
		[ $node ] = $this->configured_node();
		$node->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );
		$node->process_sse_chunk( $this->connected_frame( 'PID 9007 SLOT 7 OWNER 42424243' ) );
		$this->assertSame( 0, $node->counter(), 'heartbeat/connected frames do not bump the message counter' );
	}

	public function test_msg_frame_handed_raw_to_delivery_seam(): void {
		// SSE_In no longer unpacks or forwards a `msg` — it hands the RAW `data:` payload (the
		// packed line, byte-identical to the remote's on-disk encoding) to the owner's on_message
		// seam. It no longer tracks a per-message cursor; the owner owns the durable position.
		[ $node ] = $this->configured_node();
		$captured = [];
		$node->on_message = static function ( string $raw ) use ( &$captured ): void {
			$captured[] = $raw;
		};

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = '3:128:50';
		$m[ Message::KEY ]   = 'req';
		$m[ Message::VALUE ] = [ 'rid' => 'abc', 'url' => '/x' ];
		$packed              = Message::packed( $m );

		$node->process_sse_chunk( "event: msg\ndata: {$packed}\n\n" );

		$this->assertSame( [ $packed ], $captured, 'the raw packed payload is handed to the owner unparsed' );
		$this->assertSame( [ 'segment' => 0, 'offset' => 0 ], $node->position(), 'the per-message cursor no longer advances in SSE_In' );
	}

	public function test_msg_with_large_from_still_handed_raw(): void {
		// SSE_In hands the raw payload regardless of the message's FROM. The FROM-overflow drop is
		// now the owner's deliver_downstream / forward_line concern, not SSE_In's.
		[ $node ] = $this->configured_node();
		$captured = [];
		$node->on_message = static function ( string $raw ) use ( &$captured ): void {
			$captured[] = $raw;
		};

		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::FROM ]  = \str_repeat( 'a', \Newspack_Nodes\Node::MAX_FROM_SIZE );
		$m[ Message::ID ]    = '5:64:50';
		$m[ Message::KEY ]   = 'k';
		$m[ Message::VALUE ] = [ 'p' => 1 ];
		$packed              = Message::packed( $m );

		$node->process_sse_chunk( "event: msg\ndata: {$packed}\n\n" );

		$this->assertSame( [ $packed ], $captured, 'the raw payload is handed to the owner regardless of FROM size' );
	}

	public function test_unparseable_frame_handed_raw_to_delivery_seam(): void {
		// A torn/non-envelope `msg` frame is handed to the owner as raw bytes (SSE_In no longer
		// unpacks it); the owner's forward_line owns the unparse/DLQ. Nothing is dropped here.
		[ $node ] = $this->configured_node();
		$captured = null;
		$node->on_message = static function ( string $raw ) use ( &$captured ): void {
			$captured = $raw;
		};

		$node->process_sse_chunk( "event: msg\ndata: {not a message}\n\n" );

		$this->assertSame( '{not a message}', $captured, 'raw torn frame handed to the delivery seam' );
	}

	public function test_connected_handshake_consumed_and_captures_exact_lease(): void {
		[ $node, $sink ] = $this->configured_node();

		$node->process_sse_chunk( $this->connected_frame( 'PID 9007 SLOT 7 OWNER 42424243' ) );

		$this->assertCount( 0, $sink->captured );
		$this->assertSame( 7, $node->slot() );
		$this->assertTrue( \method_exists( $node, 'owner' ), 'SSE_In must expose the parsed lease owner' );
		$this->assertSame( 42424243, $node->owner() );
		$this->assertTrue( $node->connection()['connected'] );
	}

	public function test_connected_handshake_without_pid_is_error_not_connected(): void {
		[ $node, $sink ] = $this->configured_node();

		$node->process_sse_chunk( $this->connected_frame( 'SLOT 7 OWNER 42424243' ) );

		$this->assertCount( 0, $sink->captured );
		$this->assertNull( $node->pid() );
		$this->assertFalse( $node->connection()['connected'] );
	}

	public function test_disconnect_frame_is_consumed_and_retains_machine_key_and_display_value(): void {
		[ $node, $sink ] = $this->configured_node();
		$node->process_sse_chunk( $this->connected_frame( 'PID 9007 SLOT 7 OWNER 42424243' ) );

		$this->assertTrue(
			$node->process_sse_chunk(
				$this->disconnect_frame( 'slot_lease_lost', 'SSE slot lease lost' )
			)
		);

		$this->assertCount( 0, $sink->captured, 'terminal control frames are consumed' );
		$this->assertTrue(
			\property_exists( $node, 'terminal_disconnect_key' ),
			'SSE_In must retain the terminal event machine key separately'
		);
		$this->assertSame( 'slot_lease_lost', $this->read_private( $node, 'terminal_disconnect_key' ) );
		$this->assertSame(
			'SSE slot lease lost',
			$this->read_private( $node, 'terminal_disconnect_reason' )
		);
	}

	/**
	 * @return array<string,array{0:string}>
	 */
	public static function malformed_connected_leases(): array {
		return [
			'missing owner'       => [ 'PID 9007 SLOT 7' ],
			'non-decimal owner'   => [ 'PID 9007 SLOT 7 OWNER 42424243x' ],
			'zero owner'          => [ 'PID 9007 SLOT 7 OWNER 0' ],
			'negative owner'      => [ 'PID 9007 SLOT 7 OWNER -42424243' ],
			'non-canonical owner' => [ 'PID 9007 SLOT 7 OWNER 042424243' ],
			'owner out of range'  => [ 'PID 9007 SLOT 7 OWNER ' . \PHP_INT_MAX . '0' ],
			'missing slot'        => [ 'PID 9007 OWNER 42424243' ],
		];
	}

	#[DataProvider( 'malformed_connected_leases' )]
	public function test_malformed_connected_lease_never_arms_heartbeat( string $value ): void {
		[ $node, $sink ] = $this->configured_node();

		$node->process_sse_chunk( $this->connected_frame( $value ) );

		$this->assertCount( 0, $sink->captured );
		$this->assertNull( $node->slot() );
		$this->assertFalse( $node->connection()['connected'] );
		$this->assertNotNull( $node->connection()['last_error'] );
	}

	public function test_heartbeat_frame_recorded_not_forwarded(): void {
		[ $node, $sink ] = $this->configured_node();

		$node->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );

		$this->assertCount( 0, $sink->captured );
	}

	public function test_heartbeat_frame_records_last_sse_heartbeat(): void {
		[ $node ] = $this->configured_node();
		Core::$now = 1748960000;

		$node->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );

		$this->assertSame( 1748960000, $node->connection()['last_sse_heartbeat'] );
	}

	public function test_fresh_node_has_null_last_sse_heartbeat(): void {
		[ $node ] = $this->configured_node();

		$this->assertNull( $node->connection()['last_sse_heartbeat'] );
	}

	public function test_reconnect_resets_last_sse_heartbeat_to_null(): void {
		[ $node ] = $this->configured_node();
		Core::$now = 1748960000;
		$node->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );
		$this->assertSame( 1748960000, $node->connection()['last_sse_heartbeat'] );

		SSE_In_Node::$curl_dispatch = static function ( array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		$node->maybe_connect();

		$this->assertNull( $node->connection()['last_sse_heartbeat'] );
	}

	public function test_fresh_node_has_null_last_attempt(): void {
		[ $node ] = $this->configured_node();

		$this->assertNull( $node->connection()['last_attempt'] );
	}

	public function test_connection_exposes_actual_attempt_time(): void {
		[ $node ] = $this->configured_node();
		SSE_In_Node::$curl_dispatch = static function ( array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		Core::$now = 1748960000;

		$node->maybe_connect();

		$this->assertSame( 1748960000, $node->connection()['last_attempt'] );
	}

	public function test_disconnect_unregisters_the_multi_from_the_drain_loop(): void {
		// A disconnected multi has no fd; leaving it registered spins curl_multi_select
		// during reconnect backoff. Disconnect must unregister.
		Event_Framework::reset();
		[ $node ] = $this->configured_node();
		SSE_In_Node::$curl_dispatch = static function ( array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};

		$node->maybe_connect();
		$this->assertArrayHasKey(
			\spl_object_id( $node ),
			Event_Framework::instance()->curl_handles(),
			'connected: registered'
		);

		$node->disconnect();
		$this->assertSame( [], Event_Framework::instance()->curl_handles(), 'disconnected: unregistered' );
	}

	public function test_reconnect_reregisters_the_multi(): void {
		// After detach_handle unregisters, a reconnect must re-register — else a
		// base Remote_Link channel reconnects but is never serviced.
		Event_Framework::reset();
		[ $node ] = $this->configured_node();
		SSE_In_Node::$curl_dispatch = static function ( array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};

		Core::$now = 1000.0;
		$node->maybe_connect();
		$node->disconnect();
		$this->assertSame( [], Event_Framework::instance()->curl_handles() );

		Core::$now = 1100.0; // past reconnect backoff
		$this->assertTrue( $node->maybe_connect(), 'reconnect opens' );
		$this->assertArrayHasKey(
			\spl_object_id( $node ),
			Event_Framework::instance()->curl_handles(),
			'reconnect re-registers the multi'
		);
	}

	public function test_oversized_message_handed_raw_no_size_gate(): void {
		// SSE_In enforces no PIPE_BUF cap on delivery — the downstream Partition owns size policy.
		// An oversized frame is handed raw to the delivery seam.
		[ $node ] = $this->configured_node();
		$captured = [];
		$node->on_message = static function ( string $raw ) use ( &$captured ): void {
			$captured[] = $raw;
		};
		$huge = \str_repeat( 'x', 8000 );

		$node->process_sse_chunk( $this->msg_frame( '1:0', 'big', [ 'blob' => $huge ] ) );

		$this->assertCount( 1, $captured );
	}

	public function test_restore_position_then_connect_carries_positions_and_subscribe(): void {
		[ $node ] = $this->configured_node();
		$node->restore_position( 5, 10 );

		$captured = [];
		SSE_In_Node::$curl_dispatch = function ( array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};

		$this->assertTrue( $node->maybe_connect() );
		$url = $captured[0][ \CURLOPT_URL ];
		$this->assertStringContainsString( 'subscribe=' . \rawurlencode( 'firehose.p0' ), $url );
		\parse_str( (string) \parse_url( $url, PHP_URL_QUERY ), $query );
		// Flat `{ <concrete-dir>: {seg,off} }` — the subscription IS the dir name
		// (`open_subscription` seeds `$positions[$dir]`), not a nested topic→index.
		$positions = \json_decode( $query['positions'], true );
		$this->assertSame( 5, $positions['firehose.p0']['segment'] );
		$this->assertSame( 10, $positions['firehose.p0']['offset'] );
	}

	public function test_require_ssl_refuses_http_url(): void {
		$node = new SSE_In_Node();
		$node->name( 'sse-in' );
		$sink = new Capture_Sink_Node();
		$node->sink( $sink );
		$node->configure( 'http://austin.example', 'u', 'p', '', 'firehose.p0', [], true, true );

		$captured = [];
		SSE_In_Node::$curl_dispatch = function ( array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};

		$this->assertFalse( $node->maybe_connect() );
		$this->assertCount( 0, $captured );
		$this->assertNull( $node->test_get_handle() );
	}

	public function test_connected_handshake_captures_session_pid(): void {
		[ $node ] = $this->configured_node();
		$this->assertNull( $node->pid() );

		$node->process_sse_chunk( $this->connected_frame( 'PID 9007 SLOT 7 OWNER 42424243' ) );

		$this->assertSame( 9007, $node->pid() );
	}

	public function test_node_schema_is_hidden_io(): void {
		$schema = SSE_In_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertTrue( $schema['hidden'] );
	}
}
