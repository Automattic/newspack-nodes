<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
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

	public function test_fill_builds_command_envelope_to_spoke(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );

		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'performance', 'settings_update', 'newspack_nodes_segment_size=64' );
		$node->fill( $msg );

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

	public function test_fill_sends_basic_auth_from_vault(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'alice', 'auth_password' => 'secret', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		$expected = 'Authorization: Basic ' . \base64_encode( 'alice:secret' );
		$this->assertContains( $expected, $captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	public function test_fill_falls_back_to_bearer_token(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'token' => 'tok123', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		$this->assertContains( 'Authorization: Bearer tok123', $captured[0][ \CURLOPT_HTTPHEADER ] );
	}

	public function test_fill_drops_when_vault_entry_missing(): void {
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'ghost' ); // nothing seeded
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		$this->assertCount( 0, $captured ); // dropped, no throw
		$this->assertNull( $this->read_private( $node, 'multi' ) ); // never created the multi
	}

	public function test_fill_drops_when_url_empty(): void {
		$this->seed_vault( 'austin', [ 'url' => '', 'auth_username' => 'u', 'auth_password' => 'p', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		$this->assertCount( 0, $captured );
	}

	public function test_fill_verify_ssl_default_on(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node = $this->make_node( 'austin' );
		$msg  = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $msg );
		$this->assertTrue( $captured[0][ \CURLOPT_SSL_VERIFYPEER ] );
		$this->assertSame( 2, $captured[0][ \CURLOPT_SSL_VERIFYHOST ] );
	}

	public function test_fill_lazily_creates_and_reuses_one_multi(): void {
		$this->seed_vault( 'austin', [ 'url' => 'https://austin.example', 'auth_username' => 'u', 'auth_password' => 'p', 'enabled' => true ] );
		$captured = [];
		$this->capture_dispatch( $captured );
		$node  = $this->make_node( 'austin' );
		$first = $this->command_message( 'settings', 'update', 'k=v' );
		$node->fill( $first );
		$multi = $this->read_private( $node, 'multi' );
		$this->assertInstanceOf( \CurlMultiHandle::class, $multi );
		$second = $this->command_message( 'settings', 'update', 'k=w' );
		$node->fill( $second );
		$this->assertSame( $multi, $this->read_private( $node, 'multi' ) ); // idempotent
		$this->assertCount( 2, $this->read_private( $node, 'inflight' ) );  // two in-flight
	}

	public function test_arguments_round_trip_via_dump_config(): void {
		$node = new HTTP_Out_Node();
		$node->name( 'remote:austin' );
		$node->arguments( 'austin' );
		$this->assertSame( 'austin', $this->read_private( $node, 'server_id' ) );
		// dump_config emits a round-trippable `make_node` line ending in the args.
		$this->assertStringEndsWith( 'austin', trim( $node->dump_config() ) );
	}

	public function test_node_schema_shape(): void {
		$schema = HTTP_Out_Node::node_schema();
		$this->assertSame( 'I/O', $schema['category'] );
		$this->assertFalse( $schema['has_target'] );
		$this->assertSame( 'server_id', $schema['arguments'][0]['name'] );
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
		$this->assertInstanceOf( \CurlMultiHandle::class, $this->read_private( $node, 'multi' ) );

		$node->remove_node();
		$this->assertNull( $this->read_private( $node, 'multi' ) );
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
