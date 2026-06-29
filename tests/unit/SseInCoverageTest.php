<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Drives the cURL lifecycle, stale check, teardown, and parser edge cases that
 * the happy-path SseInTest leaves uncovered. cURL is isolated via the
 * $curl_dispatch seam returning a real-but-idle easy handle (never executed),
 * so the on_curl_* paths run as production code without a live network.
 */
#[CoversClass( SSE_In_Node::class )]
class SseInCoverageTest extends TestCase {

	protected function tearDown(): void {
		SSE_In_Node::$curl_dispatch = null;
		Event_Framework::reset();
		parent::tearDown();
	}

	/** A configured node wired to a capture sink + target, ready to parse frames. */
	private function configured_node(): array {
		$node = new SSE_In_Node();
		$node->name( 'sse-in' );
		$sink = new Capture_Sink_Node();
		$sink->name( 'merger' );
		$node->sink( $sink );
		$node->target( 'merger' );
		$node->configure( 'https://austin.example', 'u', 'p', '', 'firehose.p0', [], 'austin', true, false );
		return [ $node, $sink ];
	}

	/** Install a dispatch seam that hands back a real idle easy handle (never transferred). */
	private function dispatch_returns_handle(): void {
		SSE_In_Node::$curl_dispatch = static function ( \CurlMultiHandle $multi, array $opts ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}

	/** Connect the node and return its active easy handle. */
	private function connect( SSE_In_Node $node ): \CurlHandle {
		$this->dispatch_returns_handle();
		$this->assertTrue( $node->maybe_connect() );
		$handle = $node->test_get_handle();
		$this->assertInstanceOf( \CurlHandle::class, $handle );
		return $handle;
	}

	/** A `msg` SSE frame whose data is a packed 7-field Message envelope. */
	private function msg_frame( string $id, string $key, $value ): string {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_STRUCT;
		$m[ Message::ID ]    = $id;
		$m[ Message::KEY ]   = $key;
		$m[ Message::VALUE ] = $value;
		return "event: msg\ndata: " . Message::packed( $m ) . "\n\n";
	}

	// ----- fill -----

	public function test_fill_is_source_noop_but_increments_counter(): void {
		[ $node ] = $this->configured_node();
		$before   = $node->counter();
		$m        = Message::new_message();
		$node->fill( $m );
		$this->assertSame( $before + 1, $node->counter() );
	}

	// ----- maybe_connect -----

	public function test_maybe_connect_returns_false_when_already_connected(): void {
		[ $node ] = $this->configured_node();
		$this->connect( $node );
		$this->assertFalse( $node->maybe_connect() );
	}

	public function test_maybe_connect_returns_false_inside_backoff_window(): void {
		[ $node ]  = $this->configured_node();
		Core::$now = 1000.0;
		$handle    = $this->connect( $node );

		// Server-side close detaches the handle and grows the backoff.
		$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $handle, 'result' => \CURLE_OK ] );
		$this->assertNull( $node->test_get_handle() );
		$this->assertGreaterThan( 1, $node->connection()['current_backoff'] );

		// No handle, but still inside the backoff window from last_attempt.
		$this->assertFalse( $node->maybe_connect() );
	}

	public function test_maybe_connect_dispatch_failure_sets_error_and_backoff(): void {
		[ $node ] = $this->configured_node();
		SSE_In_Node::$curl_dispatch = static fn ( \CurlMultiHandle $m, array $o ): bool => false;

		$this->assertFalse( $node->maybe_connect() );
		$this->assertNull( $node->test_get_handle() );
		$this->assertStringContainsString( 'curl_init', (string) $node->connection()['last_error'] );
		$this->assertSame( 2, $node->connection()['current_backoff'] );
	}

	public function test_maybe_connect_emits_bearer_authorization_header(): void {
		$node = new SSE_In_Node();
		$node->name( 'sse-in' );
		$node->sink( new Capture_Sink_Node() );
		$node->configure( 'https://austin.example', '', '', 'tok-123', 'firehose.p0', [], 'austin', true, false );

		$captured = [];
		SSE_In_Node::$curl_dispatch = function ( \CurlMultiHandle $m, array $o ) use ( &$captured ): \CurlHandle {
			$captured[] = $o;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};

		$this->assertTrue( $node->maybe_connect() );
		$this->assertContains( 'Authorization: Bearer tok-123', $captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	public function test_maybe_connect_reuses_one_multi_across_reconnects(): void {
		[ $node ]  = $this->configured_node();
		Core::$now = 1000.0;
		$this->connect( $node );
		$multi     = $this->read_private( $node, 'multi' );
		$this->assertInstanceOf( \CurlMultiHandle::class, $multi );

		// Drop the handle and step past the backoff window so a second connect runs.
		$node->disconnect();
		Core::$now = 2000.0;
		$this->connect( $node );

		$this->assertSame( $multi, $this->read_private( $node, 'multi' ) );
	}

	// ----- on_curl_data -----

	public function test_on_curl_data_foreign_handle_consumes_without_processing(): void {
		[ $node, $sink ] = $this->configured_node();
		// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
		$foreign = \curl_init();

		$this->assertSame( 3, $node->on_curl_data( $foreign, 'abc' ) );
		$this->assertCount( 0, $sink->captured );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_close
		\curl_close( $foreign );
	}

	public function test_on_curl_data_zero_length_returns_zero(): void {
		[ $node ] = $this->configured_node();
		$handle   = $this->connect( $node );
		$this->assertSame( 0, $node->on_curl_data( $handle, '' ) );
	}

	public function test_on_curl_data_processes_chunk_and_forwards(): void {
		[ $node, $sink ] = $this->configured_node();
		$handle          = $this->connect( $node );
		$frame           = $this->msg_frame( '1:0', 'req', [ 'rid' => 'abc' ] );

		$this->assertSame( \strlen( $frame ), $node->on_curl_data( $handle, $frame ) );
		$this->assertCount( 1, $sink->captured );
	}

	// ----- on_curl_message -----

	public function test_on_curl_message_ignores_non_done(): void {
		[ $node ] = $this->configured_node();
		$handle   = $this->connect( $node );
		$node->on_curl_message( [ 'msg' => 0, 'handle' => $handle, 'result' => \CURLE_OK ] );
		$this->assertTrue( $node->connection()['connected'] );
		$this->assertSame( $handle, $node->test_get_handle() );
	}

	public function test_on_curl_message_foreign_handle_is_cleaned_up_without_state_change(): void {
		[ $node ] = $this->configured_node();
		$this->connect( $node );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
		$foreign = \curl_init();

		$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $foreign, 'result' => \CURLE_OK ] );

		// Our handle survives; the foreign one was best-effort closed.
		$this->assertInstanceOf( \CurlHandle::class, $node->test_get_handle() );
		$this->assertTrue( $node->connection()['connected'] );
	}

	public function test_on_curl_message_transport_error_disconnects_and_backs_off(): void {
		[ $node ] = $this->configured_node();
		$handle   = $this->connect( $node );

		$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $handle, 'result' => \CURLE_COULDNT_CONNECT ] );

		$this->assertNull( $node->test_get_handle() );
		$this->assertFalse( $node->connection()['connected'] );
		$this->assertStringContainsString( 'cURL error', (string) $node->connection()['last_error'] );
		$this->assertSame( 2, $node->connection()['current_backoff'] );
	}

	public function test_on_curl_message_clean_close_reports_server_closed(): void {
		[ $node ] = $this->configured_node();
		$handle   = $this->connect( $node );

		// Idle handle reports HTTP_CODE 0 + CURLE_OK -> "Connection closed by server".
		$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $handle, 'result' => \CURLE_OK ] );

		$this->assertFalse( $node->connection()['connected'] );
		$this->assertSame( 'Connection closed by server', $node->connection()['last_error'] );
	}

	// ----- SSE parsing edge cases -----

	public function test_comment_line_is_ignored(): void {
		[ $node, $sink ] = $this->configured_node();
		$this->assertTrue( $node->process_sse_chunk( ": keepalive\n" ) );
		$this->assertCount( 0, $sink->captured );
	}

	public function test_blank_only_line_dispatches_empty_event_as_noop(): void {
		[ $node, $sink ] = $this->configured_node();
		$this->assertTrue( $node->process_sse_chunk( "\n" ) );
		$this->assertCount( 0, $sink->captured );
	}

	public function test_unknown_event_type_is_silently_ignored(): void {
		[ $node, $sink ] = $this->configured_node();
		$this->assertTrue( $node->process_sse_chunk( "event: foo\ndata: {\"a\":1}\n\n" ) );
		$this->assertCount( 0, $sink->captured );
	}

	public function test_buffer_overflow_sets_error_state(): void {
		[ $node ] = $this->configured_node();
		$huge     = \str_repeat( 'x', SSE_In_Node::MAX_BUFFER_SIZE + 1 );

		$this->assertFalse( $node->process_sse_chunk( $huge ) );
		$this->assertStringContainsString( 'Buffer overflow', (string) $node->connection()['last_error'] );
		$this->assertFalse( $node->connection()['connected'] );
	}

	// ----- dispatch_message -----

	public function test_message_id_without_colon_leaves_position_unchanged(): void {
		[ $node, $sink ] = $this->configured_node();
		$node->process_sse_chunk( $this->msg_frame( 'plainid', 'req', [ 'x' => 1 ] ) );
		$this->assertSame( [ 'segment_id' => 0, 'offset' => 0 ], $node->position() );
		$this->assertCount( 1, $sink->captured );
	}

	public function test_message_id_with_non_digit_parts_leaves_position_unchanged(): void {
		[ $node ] = $this->configured_node();
		$node->process_sse_chunk( $this->msg_frame( 'a:b', 'req', [ 'x' => 1 ] ) );
		$this->assertSame( [ 'segment_id' => 0, 'offset' => 0 ], $node->position() );
	}

	public function test_connected_envelope_with_non_string_value_is_error_not_forwarded(): void {
		[ $node, $sink ] = $this->configured_node();
		$node->process_sse_chunk( $this->msg_frame( '', 'connected', [ 'SLOT' => 7 ] ) );
		$this->assertCount( 0, $sink->captured );
		$this->assertFalse( $node->connection()['connected'] );
		$this->assertStringContainsString( 'malformed connected envelope', (string) $node->connection()['last_error'] );
	}

	// ----- forward -----

	public function test_forward_without_sink_throws(): void {
		$node = new SSE_In_Node();
		$node->name( 'sse-in' );
		$node->configure( 'https://austin.example', '', '', '', 'firehose.p0', [], 'austin', true, false );

		$this->expectException( \RuntimeException::class );
		$node->process_sse_chunk( $this->msg_frame( '1:0', 'req', [ 'x' => 1 ] ) );
	}

	// ----- check_stale -----

	public function test_check_stale_noop_when_not_connected(): void {
		[ $node ] = $this->configured_node();
		$node->check_stale();
		$this->assertFalse( $node->connection()['connected'] );
		$this->assertNull( $node->connection()['last_error'] );
	}

	public function test_check_stale_noop_within_heartbeat_timeout(): void {
		[ $node ]  = $this->configured_node();
		Core::$now = 1000.0;
		$this->connect( $node );
		$node->check_stale();
		$this->assertTrue( $node->connection()['connected'] );
		$this->assertNull( $node->connection()['last_error'] );
	}

	public function test_check_stale_reconnects_when_idle_past_timeout(): void {
		[ $node ]  = $this->configured_node();
		Core::$now = 1000.0;
		$this->connect( $node );

		Core::$now = 1000.0 + SSE_In_Node::HEARTBEAT_TIMEOUT + 5;
		$node->check_stale();

		$this->assertNull( $node->test_get_handle() );
		$this->assertFalse( $node->connection()['connected'] );
		$this->assertStringContainsString( 'Stale connection', (string) $node->connection()['last_error'] );
	}

	// ----- teardown -----

	public function test_remove_node_closes_multi_and_drops_handle(): void {
		[ $node ] = $this->configured_node();
		$this->connect( $node );
		$this->assertInstanceOf( \CurlMultiHandle::class, $this->read_private( $node, 'multi' ) );

		$node->remove_node();

		$this->assertNull( $this->read_private( $node, 'multi' ) );
		$this->assertNull( $node->test_get_handle() );
	}

	public function test_remove_node_without_multi_does_not_throw(): void {
		[ $node ] = $this->configured_node();
		$node->remove_node();
		$this->assertNull( $this->read_private( $node, 'multi' ) );
	}

	public function test_disconnect_detaches_active_handle(): void {
		[ $node ] = $this->configured_node();
		$this->connect( $node );
		$node->disconnect();
		$this->assertNull( $node->test_get_handle() );
		$this->assertFalse( $node->connection()['connected'] );
	}

	public function test_disconnect_on_fresh_node_is_idempotent_noop(): void {
		[ $node ] = $this->configured_node();
		$node->disconnect();
		$this->assertNull( $node->test_get_handle() );
	}
}
