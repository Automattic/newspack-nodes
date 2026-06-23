<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( SSE_In_Node::class )]
class SseInTest extends TestCase {

	protected function tearDown(): void {
		SSE_In_Node::$curl_dispatch = null;
		parent::tearDown();
	}

	/** Build a configured SSE_In node wired to a capture sink with a target. */
	private function configured_node( string $source = 'austin', array $positions = [] ): array {
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
			$source,
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

	public function test_msg_frame_forwarded_to_target_with_position_update(): void {
		[ $node, $sink ] = $this->configured_node( 'austin' );

		$node->process_sse_chunk( $this->msg_frame( '3:128', 'req', [ 'rid' => 'abc', 'url' => '/x' ] ) );

		$this->assertCount( 1, $sink->captured );
		$fwd = $sink->captured[0];
		$this->assertSame( 'merger', $fwd[ Message::TO ] );
		$this->assertIsArray( $fwd[ Message::VALUE ] );
		$this->assertSame( 'abc', $fwd[ Message::VALUE ]['rid'] );
		$this->assertSame( [ 'segment_id' => 3, 'offset' => 128 ], $node->position() );
	}

	public function test_connected_handshake_consumed_and_captures_slot(): void {
		[ $node, $sink ] = $this->configured_node();

		$node->process_sse_chunk( $this->msg_frame( '', 'connected', [ 'slot' => 7 ] ) );

		$this->assertCount( 0, $sink->captured );
		$this->assertSame( 7, $node->slot() );
		$this->assertTrue( $node->connection()['connected'] );
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

		SSE_In_Node::$curl_dispatch = static function ( \CurlMultiHandle $multi, array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
		$node->maybe_connect();

		$this->assertNull( $node->connection()['last_sse_heartbeat'] );
	}

	public function test_oversized_message_is_forwarded_no_size_gate(): void {
		// SSE_In no longer enforces the Partition PIPE_BUF cap on forward — the
		// downstream Partition owns size policy. An oversized frame flows through.
		[ $node, $sink ] = $this->configured_node();
		$huge = \str_repeat( 'x', 8000 );

		$node->process_sse_chunk( $this->msg_frame( '1:0', 'big', [ 'blob' => $huge ] ) );

		$this->assertCount( 1, $sink->captured );
	}

	public function test_restore_position_then_connect_carries_positions_and_subscribe(): void {
		[ $node ] = $this->configured_node( 'austin' );
		$node->restore_position( 5, 10 );

		$captured = [];
		SSE_In_Node::$curl_dispatch = function ( \CurlMultiHandle $multi, array $opts ) use ( &$captured ): \CurlHandle {
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
		$this->assertSame( 5, $positions['firehose.p0']['seg'] );
		$this->assertSame( 10, $positions['firehose.p0']['off'] );
	}

	public function test_require_https_refuses_http_url(): void {
		$node = new SSE_In_Node();
		$node->name( 'sse-in' );
		$sink = new Capture_Sink_Node();
		$node->sink( $sink );
		$node->configure( 'http://austin.example', 'u', 'p', '', 'firehose.p0', [], 'austin', true, true );

		$captured = [];
		SSE_In_Node::$curl_dispatch = function ( \CurlMultiHandle $multi, array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};

		$this->assertFalse( $node->maybe_connect() );
		$this->assertCount( 0, $captured );
		$this->assertNull( $node->test_get_handle() );
	}

	public function test_target_is_a_thing(): void {
		[ $node, $sink ] = $this->configured_node();

		$node->process_sse_chunk( $this->msg_frame( '1:0', 'k', [ 'x' => 1 ] ) );

		$this->assertSame( 'merger', $sink->captured[0][ Message::TO ] );
	}

	public function test_no_target_is_also_a_thing(): void {
		[ $node, $sink ] = $this->configured_node();
		$node->target( '' );

		// A pivoted worker reply carries its own TO (the TO=FROM breadcrumb); IPC
		// mode must route by that, not overwrite it with the link's target.
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = '2:64';
		$m[ Message::TO ]    = '_metadata';
		$m[ Message::KEY ]   = 'meta';
		$m[ Message::VALUE ] = [ 'x' => 1 ];
		$node->process_sse_chunk( "event: msg\ndata: " . Message::packed( $m ) . "\n\n" );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( '_metadata', $sink->captured[0][ Message::TO ] );
	}

	public function test_connected_handshake_captures_session_pid(): void {
		[ $node ] = $this->configured_node();
		$this->assertNull( $node->pid() );

		$node->process_sse_chunk( $this->msg_frame( '', 'connected', [ 'slot' => 7, 'pid' => 4242 ] ) );

		$this->assertSame( 4242, $node->pid() );
	}

	public function test_node_schema_is_hidden_io(): void {
		$schema = SSE_In_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertTrue( $schema['hidden'] );
	}
}
