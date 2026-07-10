<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( HTTP_Out_Node::class )]
class HttpOutTest extends TestCase {

	/** Install a $curl_dispatch seam that records the opts and returns a real idle handle (never executed). */
	private function capture_dispatch( array &$captured ): void {
		HTTP_Out_Node::$curl_dispatch = function ( \CurlMultiHandle $multi, array $opts ) use ( &$captured ): \CurlHandle {
			$captured[] = $opts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init(); // idle handle as an opaque token; never transferred.
		};
	}

	private function seed_vault( string $id, array $entry ): void {
		\update_option( Vault::OPTION_KEY, [ $id => $entry ] );
		Vault::get_instance()->reset_cache();
	}

	protected function tearDown(): void {
		HTTP_Out_Node::$curl_dispatch = null;
		HTTP_Out_Node::$curl_result   = null;
		Vault::get_instance()->reset_cache();
		// Drop any per-test config overlay so vault_require_ssl set via
		// use_base_dir() doesn't bleed into the next test.
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		\Newspack_Nodes\Config::reset();
		parent::tearDown();
	}

	private function make_node( string $id ): HTTP_Out_Node {
		$node = new HTTP_Out_Node();
		$node->name( 'remote:' . $id );
		$node->arguments( $id );
		return $node;
	}

	private function command_message( string $to, string $verb, string $value_args ): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_COMMAND;
		$m[ Message::TO ]    = $to;
		$m[ Message::VALUE ] = [ 'name' => $verb, 'arguments' => $value_args ];
		return $m;
	}

	public function test_multi_registered_with_drain_only_while_a_transfer_is_in_flight(): void {
		// An idle registered multi (no in-flight transfer) makes curl_multi_select
		// spin. HTTP_Out registers with the drain loop only while a POST is in
		// flight and unregisters when the last completes.
		Event_Framework::reset();
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		HTTP_Out_Node::$curl_result = static fn ( \CurlHandle $easy ): array => [ 'code' => 200, 'body' => '' ];
		$node = $this->make_node( 'austin' );

		$this->assertSame( [], Event_Framework::instance()->curl_handles(), 'idle: not registered' );

		$node->fill( $this->command_message( 'settings', 'set', 'x y' ) );
		$node->fire();
		$this->assertArrayHasKey(
			\spl_object_id( $node ),
			Event_Framework::instance()->curl_handles(),
			'in flight: registered'
		);

		foreach ( $this->read_private( $node, 'inflight' ) as $entry ) {
			$node->on_curl_message( [ 'msg' => \CURLMSG_DONE, 'handle' => $entry['handle'], 'result' => \CURLE_OK ] );
		}
		$this->assertSame( [], Event_Framework::instance()->curl_handles(), 'idle again: unregistered' );
	}

	public function test_fill_buffers_without_posting_and_arms_timer(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$a    = $this->command_message( 'settings', 'set', 'newspack_nodes_num_segments 8' );
		$b    = $this->command_message( 'settings', 'set', 'newspack_nodes_segment_size 65536' );
		$node->fill( $a );
		$node->fill( $b );
		$this->assertCount( 0, $captured );                                  // no POST during fill
		$this->assertCount( 2, $this->read_private( $node, 'batch' ) );       // buffered
		$this->assertTrue( $this->read_private( $node, 'batch_timer_armed' ) ); // explicit flag (NOT a Timer_Node field)
	}

	public function test_fire_posts_one_batched_jsonl_request(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$a    = $this->command_message( 'settings', 'set', 'newspack_nodes_num_segments 8' );
		$b    = $this->command_message( 'performance', 'set', 'x y' );
		$node->fill( $a );
		$node->fill( $b );
		$node->fire();
		$this->assertCount( 1, $captured );                                   // ONE POST
		$lines = array_values( array_filter( explode( "\n", $captured[0][ \CURLOPT_POSTFIELDS ] ) ) );
		$this->assertCount( 2, $lines );                                      // both commands, JSONL
		$this->assertSame( 'performance', Message::unpacked( $lines[1] )[ Message::TO ] );
		$this->assertCount( 0, $this->read_private( $node, 'batch' ) );        // cleared
	}

	public function test_fire_tallies_bytes_written_and_largest_msg_sent(): void {
		// PHP/JS parity: HTTP_Out tallies the per-message packed size on POST so
		// Remote_Link::bytes_written() (which delegates to it) isn't stuck at 0.
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node  = $this->make_node( 'austin' );
		$small = $this->command_message( 'settings', 'set', 'a b' );
		$large = $this->command_message( 'performance', 'set', 'a much longer argument string here' );
		$node->fill( $small );
		$node->fill( $large );
		$node->fire();
		$lines = array_values( array_filter( explode( "\n", $captured[0][ \CURLOPT_POSTFIELDS ] ) ) );
		$sizes = array_map( 'strlen', $lines );
		$this->assertSame( array_sum( $sizes ), $node->bytes_written() );
		$this->assertSame( max( $sizes ), $node->largest_msg_sent() );
	}

	public function test_fire_empty_batch_does_not_post(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$node->fire();
		$this->assertCount( 0, $captured );
		$this->assertNull( $this->read_private( $node, 'multi' ) ); // never created the multi
	}

	public function test_fire_clears_armed_flag_for_next_cycle(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node  = $this->make_node( 'austin' );
		$first = $this->command_message( 'settings', 'set', 'k v' );
		$node->fill( $first );
		$node->fire();
		$this->assertFalse( $this->read_private( $node, 'batch_timer_armed' ) );
		// Next fill re-arms and re-buffers.
		$second = $this->command_message( 'settings', 'set', 'k2 v2' );
		$node->fill( $second );
		$this->assertTrue( $this->read_private( $node, 'batch_timer_armed' ) );
		$this->assertCount( 1, $this->read_private( $node, 'batch' ) );
	}

	public function test_fire_builds_command_envelope_to_spoke(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );

		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'performance', 'settings_update', 'newspack_nodes_segment_size=64' );
		$node->fill( $msg );
		$node->fire();

		$this->assertCount( 1, $captured );
		$opts = $captured[0];
		$this->assertSame( 'https://austin.example/wp-json/newspack-nodes/v1/command', $opts[ \CURLOPT_URL ] );
		// Body is JSONL: one packed TM_COMMAND with TO=performance, FROM=_http.
		$line     = rtrim( $opts[ \CURLOPT_POSTFIELDS ], "\n" );
		$envelope = Message::unpacked( $line );
		$this->assertSame( Message::TM_COMMAND, $envelope[ Message::TYPE ] );
		$this->assertSame( 'performance', $envelope[ Message::TO ] );
		$this->assertSame( '_http', $envelope[ Message::FROM ] );
		$this->assertSame( [ 'name' => 'settings_update', 'arguments' => 'newspack_nodes_segment_size=64' ], $envelope[ Message::VALUE ] );
		$this->assertContains( 'Content-Type: text/plain; charset=UTF-8', $opts[ \CURLOPT_HTTPHEADER ] );
	}

	public function test_fire_sends_basic_auth_from_vault(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'alice', 'auth_password' => 'secret', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		$node->fire();
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		$expected = 'Authorization: Basic ' . \base64_encode( 'alice:secret' );
		$this->assertContains( $expected, $captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	public function test_fire_falls_back_to_bearer_token(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'token' => 'tok123', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		$node->fire();
		$this->assertContains( 'Authorization: Bearer tok123', $captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	public function test_fire_drops_when_vault_entry_missing(): void {
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'ghost' ); // nothing seeded
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		$node->fire();
		$this->assertCount( 0, $captured ); // dropped, no throw
		$this->assertNull( $this->read_private( $node, 'multi' ) ); // never created the multi
	}

	public function test_fire_drops_when_url_empty(): void {
		$this->seed_vault( 'austin', [ 'url' => '', 'auth_username' => 'u', 'auth_password' => 'p', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		$node->fire();
		$this->assertCount( 0, $captured );
	}

	public function test_fire_verify_ssl_default_on(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		$node->fire();
		$this->assertTrue( $captured[0][ \CURLOPT_SSL_VERIFYPEER ] );
		$this->assertSame( 2, $captured[0][ \CURLOPT_SSL_VERIFYHOST ] );
	}

	public function test_fire_lazily_creates_and_reuses_one_multi(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node  = $this->make_node( 'austin' );
		$first = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $first );
		$node->fire();
		$multi = $this->read_private( $node, 'multi' );
		$this->assertInstanceOf( \CurlMultiHandle::class, $multi );
		// A second batch reuses the same multi and adds one more in-flight handle.
		$second = $this->command_message( 'settings', 'update', 'k=w' );
		$node->fill( $second );
		$node->fire();
		$this->assertSame( $multi, $this->read_private( $node, 'multi' ) ); // idempotent
		$this->assertCount( 2, $this->read_private( $node, 'inflight' ) );  // two in-flight
	}

	public function test_arguments_round_trip_via_dump_config(): void {
		$node = new HTTP_Out_Node();
		$node->name( 'remote:austin' );
		$node->arguments( 'austin' );
		$this->assertSame( 'austin', $this->read_private( $node, 'vault_id' ) );
		// dump_config emits a round-trippable `make_node` line ending in the args.
		$this->assertStringEndsWith( 'austin', trim( $node->dump_config() ) );
	}

	public function test_fill_preserves_caller_from(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node                 = $this->make_node( 'austin' );
		$m                    = $this->command_message( 'workers', 'heartbeat', '3 60 0' );
		$m[ Message::FROM ]   = 'spoke-austin';
		$node->fill( $m );
		$node->fire();
		$envelope = Message::unpacked( rtrim( $captured[0][ \CURLOPT_POSTFIELDS ], "\n" ) );
		$this->assertSame( 'spoke-austin', $envelope[ Message::FROM ] );
	}

	public function test_fill_falls_back_to_http_when_caller_from_empty(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$m    = $this->command_message( 'workers', 'heartbeat', '3 60 0' ); // FROM left empty
		$node->fill( $m );
		$node->fire();
		$envelope = Message::unpacked( rtrim( $captured[0][ \CURLOPT_POSTFIELDS ], "\n" ) );
		$this->assertSame( '_http', $envelope[ Message::FROM ] );
	}

	public function test_on_curl_message_strips_output_prefix_from_reply_to(): void {
		[ $node, $easy ] = $this->node_with_one_inflight();

		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$reply[ Message::TO ]    = '_output/spoke-austin';
		$reply[ Message::VALUE ] = 'status';

		HTTP_Out_Node::$curl_result = static fn ( \CurlHandle $h ): array => [ 'code' => 200, 'body' => Message::packed( $reply ) . "\n" ];
		$sink                       = new Capture_Sink_Node();
		$sink->name( '_command_interpreter' );
		$node->sink( $sink );

		$node->on_curl_message( $this->done_info( $easy ) );

		$this->assertSame( 'spoke-austin', $sink->captured[0][ Message::TO ] );
	}

	public function test_on_curl_message_leaves_reply_to_without_prefix_unchanged(): void {
		[ $node, $easy ] = $this->node_with_one_inflight();

		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$reply[ Message::TO ]    = 'settings-sync';
		$reply[ Message::VALUE ] = 'ok';

		HTTP_Out_Node::$curl_result = static fn ( \CurlHandle $h ): array => [ 'code' => 200, 'body' => Message::packed( $reply ) . "\n" ];
		$sink                       = new Capture_Sink_Node();
		$sink->name( '_command_interpreter' );
		$node->sink( $sink );

		$node->on_curl_message( $this->done_info( $easy ) );

		$this->assertSame( 'settings-sync', $sink->captured[0][ Message::TO ] );
	}

	public function test_fire_refuses_non_https_when_require_ssl(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_require_ssl' => true ] );
		$this->seed_vault( 'austin', [ 'url' => 'http://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$m    = $this->command_message( 'workers', 'heartbeat', '3 60 0' );
		$node->fill( $m );
		$node->fire();
		$this->assertCount( 0, $captured );
	}

	public function test_fire_allows_https_when_require_ssl(): void {
		$this->use_base_dir( $this->make_temp_dir(), [ 'vault_require_ssl' => true ] );
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$m    = $this->command_message( 'workers', 'heartbeat', '3 60 0' );
		$node->fill( $m );
		$node->fire();
		$this->assertCount( 1, $captured );
	}

	public function test_fire_allows_non_https_by_default(): void {
		// Default off (opt-in): no overlay set → plaintext spoke is allowed.
		$this->use_base_dir( $this->make_temp_dir() );
		$this->seed_vault( 'austin', [ 'url' => 'http://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$m    = $this->command_message( 'workers', 'heartbeat', '3 60 0' );
		$node->fill( $m );
		$node->fire();
		$this->assertCount( 1, $captured );
	}

	public function test_node_schema_shape(): void {
		$schema = HTTP_Out_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertFalse( $schema['has_target'] );
		$this->assertSame( 'vault_id', $schema['arguments'][0]['name'] );
		$this->assertSame( 'vault_id', $schema['arguments'][0]['type'] );
		$this->assertTrue( $schema['arguments'][0]['required'] );
	}

	public function test_constructor_does_no_io(): void {
		// Constructing must not create a curl-multi (ADR-5: no event-loop work in ctor).
		$node = new HTTP_Out_Node();
		$this->assertNull( $this->read_private( $node, 'multi' ) );
	}

	/** Drive a node to one in-flight handle, then return [node, easy-handle]. */
	private function node_with_one_inflight(): array {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'enabled' => true ] );
		$easies = [];
		HTTP_Out_Node::$curl_dispatch = function ( \CurlMultiHandle $m, array $o ) use ( &$easies ): \CurlHandle {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			$ch       = \curl_init();
			$easies[] = $ch;
			return $ch;
		};
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		$node->fire();
		return [ $node, $easies[0] ];
	}

	private function done_info( \CurlHandle $easy, int $result = \CURLE_OK ): array {
		return [ 'msg' => \CURLMSG_DONE, 'handle' => $easy, 'result' => $result ];
	}

	public function test_on_curl_message_forwards_reply_messages_to_sink(): void {
		[ $node, $easy ] = $this->node_with_one_inflight();

		$reply1                   = Message::new_message();
		$reply1[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$reply1[ Message::TO ]    = 'settings-sync'; // reply carries TO=FROM
		$reply1[ Message::VALUE ] = 'ok-1';
		$reply2                   = Message::new_message();
		$reply2[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$reply2[ Message::TO ]    = 'settings-sync';
		$reply2[ Message::VALUE ] = 'ok-2';
		$body = Message::packed( $reply1 ) . "\n" . Message::packed( $reply2 ) . "\n";

		HTTP_Out_Node::$curl_result = static fn ( \CurlHandle $h ): array => [ 'code' => 200, 'body' => $body ];

		$sink = new Capture_Sink_Node();
		$sink->name( '_command_interpreter' );
		$node->sink( $sink );

		$node->on_curl_message( $this->done_info( $easy ) );

		$this->assertCount( 2, $sink->captured );
		$this->assertSame( 'ok-1', $sink->captured[0][ Message::VALUE ] );
		$this->assertSame( 'ok-2', $sink->captured[1][ Message::VALUE ] );
		$this->assertCount( 0, $this->read_private( $node, 'inflight' ) ); // cleaned up
	}

	public function test_on_curl_message_empty_body_forwards_nothing(): void {
		[ $node, $easy ] = $this->node_with_one_inflight();
		HTTP_Out_Node::$curl_result = static fn ( \CurlHandle $h ): array => [ 'code' => 202, 'body' => '' ];
		$sink = new Capture_Sink_Node();
		$sink->name( '_command_interpreter' );
		$node->sink( $sink );
		$node->on_curl_message( $this->done_info( $easy ) );
		$this->assertCount( 0, $sink->captured );
		$this->assertCount( 0, $this->read_private( $node, 'inflight' ) );
	}

	public function test_on_curl_message_non_200_logs_and_cleans_up(): void {
		[ $node, $easy ] = $this->node_with_one_inflight();
		HTTP_Out_Node::$curl_result = static fn ( \CurlHandle $h ): array => [ 'code' => 503, 'body' => 'down' ];
		$node->on_curl_message( $this->done_info( $easy ) ); // no sink wired — must not throw
		$this->assertCount( 0, $this->read_private( $node, 'inflight' ) );
	}

	public function test_on_curl_message_transport_error_logs_and_cleans_up(): void {
		[ $node, $easy ] = $this->node_with_one_inflight();
		// curl_result not consulted on transport error.
		$node->on_curl_message( $this->done_info( $easy, \CURLE_COULDNT_CONNECT ) );
		$this->assertCount( 0, $this->read_private( $node, 'inflight' ) );
	}

	public function test_on_curl_message_ignores_non_done(): void {
		[ $node, $easy ] = $this->node_with_one_inflight();
		$node->on_curl_message( [ 'msg' => 0, 'handle' => $easy, 'result' => \CURLE_OK ] );
		$this->assertCount( 1, $this->read_private( $node, 'inflight' ) ); // untouched
	}

	public function test_on_curl_message_no_sink_does_not_throw_on_200_body(): void {
		[ $node, $easy ] = $this->node_with_one_inflight();
		$reply                   = Message::new_message();
		$reply[ Message::VALUE ] = 'x';
		HTTP_Out_Node::$curl_result = static fn ( \CurlHandle $h ): array => [ 'code' => 200, 'body' => Message::packed( $reply ) . "\n" ];
		$node->on_curl_message( $this->done_info( $easy ) ); // sink is null
		$this->assertCount( 0, $this->read_private( $node, 'inflight' ) );
	}

	public function test_remove_node_unregisters_and_closes_multi(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		$node->fire();
		$this->assertInstanceOf( \CurlMultiHandle::class, $this->read_private( $node, 'multi' ) );

		$node->remove_node();
		$this->assertNull( $this->read_private( $node, 'multi' ) );
		$this->assertCount( 0, $this->read_private( $node, 'inflight' ) );
	}

	public function test_remove_node_clears_pending_batch(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'set', 'k v' );
		$node->fill( $msg );
		$this->assertCount( 1, $this->read_private( $node, 'batch' ) );
		$node->remove_node();
		$this->assertCount( 0, $this->read_private( $node, 'batch' ) );
	}

	public function test_arguments_null_returns_stored_vault_id(): void {
		// arguments(null) is the getter — it returns the vault_id last set.
		$node = $this->make_node( 'austin' );
		$this->assertSame( 'austin', $node->arguments() );
	}

	public function test_fire_uses_real_libcurl_dispatch_when_no_seam_installed(): void {
		// With no $curl_dispatch seam the default closure runs for real: curl_init,
		// curl_setopt_array, curl_multi_add_handle. No transfer happens (the EF drain
		// never runs in unit tests), so the handle just sits in-flight until teardown.
		HTTP_Out_Node::$curl_dispatch = null;
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'set', 'k v' );
		$node->fill( $msg );
		$node->fire();

		$this->assertInstanceOf( \CurlMultiHandle::class, $this->read_private( $node, 'multi' ) );
		$this->assertCount( 1, $this->read_private( $node, 'inflight' ) );
		$node->remove_node(); // detach + close the real handle (no network transfer occurred)
	}

	public function test_fire_logs_and_tracks_nothing_when_dispatch_returns_false(): void {
		// A dispatch seam that fails to produce a CurlHandle is logged rate-limited;
		// fire() returns without tracking an in-flight handle (and never throws).
		HTTP_Out_Node::$curl_dispatch = static fn ( \CurlMultiHandle $m, array $o ): bool => false;
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'set', 'k v' );
		$node->fill( $msg );
		$node->fire();
		$this->assertCount( 0, $this->read_private( $node, 'inflight' ) );
	}

	public function test_on_curl_message_done_without_handle_is_ignored(): void {
		// A CURLMSG_DONE info lacking a CurlHandle returns early. Seed one in-flight
		// request first so the guard has something to leave alone: the no-handle
		// message must NOT touch it (a regression that unset by a null/zero id, or
		// cleared inflight on this path, would drop the live request).
		[ $node, $easy ] = $this->node_with_one_inflight();
		$before          = $this->read_private( $node, 'inflight' );
		$this->assertCount( 1, $before );

		$node->on_curl_message( [ 'msg' => \CURLMSG_DONE ] );

		$after = $this->read_private( $node, 'inflight' );
		$this->assertSame( $before, $after );
		$this->assertArrayHasKey( \spl_object_id( $easy ), $after );
		$node->remove_node(); // detach + close the real handle (no transfer occurred)
	}

	public function test_on_curl_message_reads_real_curl_result_when_no_seam(): void {
		// With no $curl_result seam, read_result reads libcurl directly. An
		// un-transferred handle reports HTTP 0 → non-200 logged, handle cleaned up.
		[ $node, $easy ] = $this->node_with_one_inflight();
		HTTP_Out_Node::$curl_result = null;
		$node->on_curl_message( $this->done_info( $easy ) );
		$this->assertCount( 0, $this->read_private( $node, 'inflight' ) );
	}

	public function test_on_curl_message_malformed_line_is_skipped_not_fatal(): void {
		[ $node, $easy ] = $this->node_with_one_inflight();
		$reply                   = Message::new_message();
		$reply[ Message::VALUE ] = 'good';
		// First line is not a 7-element positional array; Message::unpacked() throws on it.
		$body = '{"not":"a positional array"}' . "\n" . Message::packed( $reply ) . "\n";
		HTTP_Out_Node::$curl_result = static fn ( \CurlHandle $h ): array => [ 'code' => 200, 'body' => $body ];
		$sink = new Capture_Sink_Node();
		$sink->name( '_command_interpreter' );
		$node->sink( $sink );
		$node->on_curl_message( $this->done_info( $easy ) ); // must not throw past the bad line
		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'good', $sink->captured[0][ Message::VALUE ] );
		$this->assertCount( 0, $this->read_private( $node, 'inflight' ) );
	}
}
