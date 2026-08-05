<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\SSE_In_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

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
		$node->configure( 'https://austin.example', 'u', 'p', '', 'firehose.p0', [], true, false );
		return [ $node, $sink ];
	}

	/** Install a dispatch seam that hands back a real idle easy handle (never transferred). */
	private function dispatch_returns_handle(): void {
		SSE_In_Node::$curl_dispatch = static function ( array $opts ): \CurlHandle {
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

	/** A `connected` SSE frame (its own event type, mirroring `heartbeat`). */
	private function connected_frame( $value ): string {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_INFO;
		$m[ Message::KEY ]   = 'connected';
		$m[ Message::VALUE ] = $value;
		return "event: connected\ndata: " . Message::packed( $m ) . "\n\n";
	}

	/** A terminal `disconnect` SSE frame. */
	private function disconnect_frame( string $key, string $value ): string {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_ERROR;
		$m[ Message::KEY ]   = $key;
		$m[ Message::VALUE ] = $value;
		return "event: disconnect\ndata: " . Message::packed( $m ) . "\n\n";
	}

	/** Seed the HTTP status observed while response bytes were arriving. */
	private function set_http_code( SSE_In_Node $node, int $code ): void {
		$property = new \ReflectionProperty( SSE_In_Node::class, 'last_http_code' );
		$property->setValue( $node, $code );
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
		SSE_In_Node::$curl_dispatch = static fn ( array $o ): bool => false;

		$this->assertFalse( $node->maybe_connect() );
		$this->assertNull( $node->test_get_handle() );
		$this->assertStringContainsString( 'curl_init', (string) $node->connection()['last_error'] );
		$this->assertSame( 2, $node->connection()['current_backoff'] );
	}

	public function test_maybe_connect_emits_bearer_authorization_header(): void {
		$node = new SSE_In_Node();
		$node->name( 'sse-in' );
		$node->sink( new Capture_Sink_Node() );
		$node->configure( 'https://austin.example', '', '', 'tok-123', 'firehose.p0', [], true, false );

		$captured = [];
		SSE_In_Node::$curl_dispatch = function ( array $o ) use ( &$captured ): \CurlHandle {
			$captured[] = $o;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};

		$this->assertTrue( $node->maybe_connect() );
		$this->assertContains( 'Authorization: Bearer tok-123', $captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	public function test_reconnect_reuses_the_shared_multi(): void {
		Event_Framework::reset();
		[ $node ]  = $this->configured_node();
		Core::$now = 1000.0;
		$this->connect( $node );
		$multi     = $this->read_private( Event_Framework::instance(), 'curl_multi' );
		$this->assertInstanceOf( \CurlMultiHandle::class, $multi );

		// Drop the handle and step past the backoff window so a second connect runs.
		$node->disconnect();
		Core::$now = 2000.0;
		$this->connect( $node );

		$this->assertSame( $multi, $this->read_private( Event_Framework::instance(), 'curl_multi' ) );
	}

	// ----- on_curl_data -----

	public function test_on_curl_data_foreign_handle_consumes_without_processing(): void {
		[ $node, $sink ] = $this->configured_node();
		// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
		$foreign = \curl_init();

		$this->assertSame( 3, $node->on_curl_data( $foreign, 'abc' ) );
		$this->assertCount( 0, $sink->captured );
	}

	public function test_on_curl_data_zero_length_returns_zero(): void {
		[ $node ] = $this->configured_node();
		$handle   = $this->connect( $node );
		$this->assertSame( 0, $node->on_curl_data( $handle, '' ) );
	}

	public function test_on_curl_data_processes_chunk_and_delivers_raw(): void {
		[ $node ] = $this->configured_node();
		$handle   = $this->connect( $node );
		$captured = [];
		$node->on_message = static function ( string $raw ) use ( &$captured ): void {
			$captured[] = $raw;
		};
		$frame = $this->msg_frame( '1:0', 'req', [ 'rid' => 'abc' ] );

		$this->assertSame( \strlen( $frame ), $node->on_curl_data( $handle, $frame ) );
		$this->assertCount( 1, $captured );
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
		$this->assertSame(
			'cURL error 7 (Could not connect to server)',
			$node->connection()['last_error']
		);
		$this->assertSame( 2, $node->connection()['current_backoff'] );
	}

	public function test_on_curl_message_includes_safe_libcurl_detail_when_available(): void {
		[ $node ] = $this->configured_node();
		$handle   = $this->connect( $node );
		Event_Framework::instance()->unregister_curl_easy( $handle );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_setopt
		\curl_setopt( $handle, \CURLOPT_URL, '://bad' );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_exec
		\curl_exec( $handle );
		// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_error
		$detail = \curl_error( $handle );
		$this->assertNotSame( '', $detail, 'fixture must produce a real libcurl detail' );

		$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $handle, 'result' => \CURLE_URL_MALFORMAT ] );

		$this->assertSame(
			'cURL error 3 (URL using bad/illegal format or missing URL): ' . $detail,
			$node->connection()['last_error']
		);
	}

	public function test_terminal_server_reason_wins_over_curl_failure(): void {
		[ $node ] = $this->configured_node();
		$handle   = $this->connect( $node );
		$node->process_sse_chunk(
			$this->disconnect_frame( 'slot_lease_lost', 'SSE slot lease lost' )
		);

		$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $handle, 'result' => \CURLE_COULDNT_CONNECT ] );

		$this->assertFalse( $node->connection()['connected'] );
		$this->assertSame(
			'Server closed stream: SSE slot lease lost',
			$node->connection()['last_error']
		);
	}

	public function test_parser_error_wins_over_server_and_curl_reasons(): void {
		[ $node ] = $this->configured_node();
		$handle   = $this->connect( $node );
		$node->process_sse_chunk( \str_repeat( 'x', SSE_In_Node::MAX_BUFFER_SIZE + 1 ) );
		$node->process_sse_chunk(
			$this->disconnect_frame( 'slot_lease_lost', 'SSE slot lease lost' )
		);

		$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $handle, 'result' => \CURLE_COULDNT_CONNECT ] );

		$this->assertSame(
			'Buffer overflow (no newline in ' . SSE_In_Node::MAX_BUFFER_SIZE . ' bytes)',
			$node->connection()['last_error']
		);
	}

	public function test_non_200_http_status_is_reported_after_clean_transport(): void {
		[ $node ] = $this->configured_node();
		$handle   = $this->connect( $node );
		$this->set_http_code( $node, 503 );

		$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $handle, 'result' => \CURLE_OK ] );

		$this->assertSame( 'HTTP 503', $node->connection()['last_error'] );
	}

	public function test_clean_http_200_eof_reports_pid_and_connected_duration(): void {
		[ $node ]  = $this->configured_node();
		Core::$now = 1748960000.25;
		$handle    = $this->connect( $node );
		$node->process_sse_chunk(
			$this->connected_frame( 'PID 9007 SLOT 7 OWNER 42424243' )
		);
		$this->set_http_code( $node, 200 );
		Core::$now = 1748960012.59;

		$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $handle, 'result' => \CURLE_OK ] );

		$this->assertSame(
			'HTTP 200 SSE stream ended without a server disconnect reason (remote PID 9007, connected 12.34s)',
			$node->connection()['last_error']
		);
	}

	public function test_reconnect_resets_complete_per_connection_state(): void {
		[ $node ]  = $this->configured_node();
		Core::$now = 1748960000.25;
		$this->connect( $node );
		$node->process_sse_chunk(
			$this->connected_frame( 'PID 9007 SLOT 7 OWNER 42424243' )
		);
		$node->process_sse_chunk( "event: heartbeat\ndata: {}\n\n" );
		$node->process_sse_chunk(
			$this->disconnect_frame( 'slot_lease_lost', 'SSE slot lease lost' )
		);
		$node->disconnect();
		Core::$now = 1748960002.25;

		$this->assertTrue( $node->maybe_connect() );
		$this->assertNull( $node->slot() );
		$this->assertNull( $node->pid() );
		$this->assertTrue( \method_exists( $node, 'owner' ), 'SSE_In must expose the parsed lease owner' );
		$this->assertNull( $node->owner() );
		$this->assertNull( $node->connection()['last_error'] );
		$this->assertNull( $node->connection()['last_sse_heartbeat'] );
		$this->assertTrue( \property_exists( $node, 'connected_at' ) );
		$this->assertNull( $this->read_private( $node, 'connected_at' ) );
		$this->assertTrue( \property_exists( $node, 'terminal_disconnect_key' ) );
		$this->assertNull( $this->read_private( $node, 'terminal_disconnect_key' ) );
		$this->assertTrue( \property_exists( $node, 'terminal_disconnect_reason' ) );
		$this->assertNull( $this->read_private( $node, 'terminal_disconnect_reason' ) );
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

	// ----- msg delivery (raw seam) -----

	public function test_msg_delivered_raw_regardless_of_id_shape(): void {
		// SSE_In no longer parses the ID or tracks a per-message cursor — any msg is handed raw to
		// the delivery seam and the connect position stays put (the owner owns the durable cursor).
		[ $node ] = $this->configured_node();
		$captured = [];
		$node->on_message = static function ( string $raw ) use ( &$captured ): void {
			$captured[] = $raw;
		};
		$node->process_sse_chunk( $this->msg_frame( 'plainid', 'req', [ 'x' => 1 ] ) );
		$this->assertCount( 1, $captured );
		$this->assertSame( [ 'segment' => 0, 'offset' => 0 ], $node->position() );
	}

	public function test_msg_with_null_delivery_seam_is_dropped(): void {
		// No owner wired the seam → the msg is silently dropped (no throw), the stream keeps draining.
		[ $node ] = $this->configured_node();
		$this->assertTrue( $node->process_sse_chunk( $this->msg_frame( 'a:b', 'req', [ 'x' => 1 ] ) ) );
	}

	public function test_connected_envelope_with_non_string_value_is_error_not_forwarded(): void {
		[ $node, $sink ] = $this->configured_node();
		$node->process_sse_chunk( $this->connected_frame( [ 'SLOT' => 7 ] ) );
		$this->assertCount( 0, $sink->captured );
		$this->assertFalse( $node->connection()['connected'] );
		$this->assertStringContainsString( 'malformed connected envelope', (string) $node->connection()['last_error'] );
	}

	// ----- delivery seam -----

	public function test_msg_without_delivery_seam_does_not_throw(): void {
		// SSE_In no longer forwards to a sink, so a msg with no owner-wired delivery seam is a
		// silent drop — never a throw (the null-sink fail-loud now lives in the owner's forward_line).
		$node = new SSE_In_Node();
		$node->name( 'sse-in' );
		$node->configure( 'https://austin.example', '', '', '', 'firehose.p0', [], true, false );

		$this->assertTrue( $node->process_sse_chunk( $this->msg_frame( '1:0', 'req', [ 'x' => 1 ] ) ) );
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

	public function test_remove_node_unregisters_handle_and_drops_it(): void {
		Event_Framework::reset();
		[ $node ] = $this->configured_node();
		$this->connect( $node );
		$this->assertArrayHasKey( \spl_object_id( $node ), Event_Framework::instance()->curl_handles() );

		$node->remove_node();

		$this->assertSame( [], Event_Framework::instance()->curl_handles() );
		$this->assertNull( $node->test_get_handle() );
	}

	public function test_remove_node_without_a_connection_does_not_throw(): void {
		[ $node ] = $this->configured_node();
		$node->remove_node();
		$this->assertNull( $node->test_get_handle() );
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

	public function test_maybe_connect_default_dispatch_sets_up_a_real_handle(): void {
		// No $curl_dispatch seam: exercise the production curl_init + curl_setopt_array +
		// curl_multi_add_handle path (setup only — no perform, so no network).
		[ $node ] = $this->configured_node();
		$this->assertTrue( $node->maybe_connect() );
		$this->assertInstanceOf( \CurlHandle::class, $node->test_get_handle() );
		$node->disconnect(); // detach + close the real handle.
	}

	public function test_arm_and_disarm_toggle_event_loop_registration(): void {
		// The Durable_Reader pump valve: arm registers the live handle with the drain loop,
		// disarm unregisters it. Both are no-ops without a live handle.
		[ $node ] = $this->configured_node();
		$this->connect( $node );
		$node->arm();
		$node->disarm();
		$node->disconnect();
		$this->addToAssertionCount( 1 );
	}
}
