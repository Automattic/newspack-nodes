<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * `probe_command()` — the BLOCKING half of HTTP_Out, for an operator action
 * that needs a verdict in-band rather than over the async cURL-multi path.
 *
 * One call is three steps against a spoke: `/auth` to establish a command
 * session (first contact is itself a command, so it has to come first), a
 * signed TM_COMMAND to `/command`, then decoding the JSONL reply. Every step
 * throws rather than returning a partial answer, because the caller is a UI
 * that has to say WHY it could not reach the spoke.
 *
 * Everything rides the `$http_call` seam, so these drive the real
 * establish_session / request_args / command_message / payload_of path with
 * only the libcurl call replaced.
 */
#[CoversClass( HTTP_Out_Node::class )]
class HttpOutProbeTest extends TestCase {

	private const SPOKE = 'austin';

	private ?\Memcached $prev_memd = null;

	/** @var list<array{url:string,args:array<string,mixed>}> */
	private array $calls = [];

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
		$this->calls     = [];
	}

	protected function tearDown(): void {
		HTTP_Out_Node::$http_call = null;
		Command_Auth::forget_session( self::SPOKE );
		Core::$memd = $this->prev_memd;
		parent::tearDown();
	}

	/** A spoke config. https, because vault_require_ssl is on by default. */
	private function server( array $extra = [] ): array {
		return \array_merge( [ 'url' => 'https://spoke.example' ], $extra );
	}

	/** A WP-HTTP response array. */
	private function response( int $code, string $body ): array {
		return [
			'response' => [ 'code' => $code, 'message' => '' ],
			'body'     => $body,
		];
	}

	/** The `/auth` body a spoke answers a session request with. */
	private function issued_session(): string {
		return (string) \wp_json_encode( [ 'handle' => 'h-1', 'key' => 'k-1' ] );
	}

	/** One packed reply line, as `/command` returns it (JSONL). */
	private function reply_line( mixed $payload, int $type = Message::TM_COMMAND ): string {
		$message                    = Message::new_message();
		$message[ Message::TYPE ]   = $type;
		$message[ Message::VALUE ]  = [ 'name' => 'status', 'payload' => $payload ];
		return (string) \wp_json_encode( $message );
	}

	/**
	 * Answer each POST in order, recording what was sent.
	 *
	 * @param list<array<string,mixed>|\WP_Error> $responses One per call.
	 */
	private function seed_http( array $responses ): void {
		$i                        = 0;
		HTTP_Out_Node::$http_call = function ( string $url, array $args ) use ( &$i, $responses ) {
			$this->calls[] = [ 'url' => $url, 'args' => $args ];
			$out           = $responses[ $i ] ?? $responses[ \count( $responses ) - 1 ];
			++$i;
			return $out;
		};
	}

	public function test_probe_authenticates_then_commands_and_returns_the_payload(): void {
		$this->seed_http( [
			$this->response( 200, $this->issued_session() ),
			$this->response( 200, $this->reply_line( [ 'ok' => true ] ) ),
		] );

		$payload = HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get', [ 'x' ] );

		$this->assertSame( [ 'ok' => true ], $payload );
		$this->assertCount( 2, $this->calls, 'auth first, then command' );
		$this->assertStringEndsWith( '/auth', $this->calls[0]['url'] );
		$this->assertStringEndsWith( '/command', $this->calls[1]['url'] );
	}

	public function test_the_command_body_is_a_signed_message_carrying_the_verb_and_args(): void {
		$this->seed_http( [
			$this->response( 200, $this->issued_session() ),
			$this->response( 200, $this->reply_line( [] ) ),
		] );

		HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'set', [ 'a', 'b' ] );

		$sent = Message::unpacked( $this->calls[1]['args']['body'] );
		$this->assertSame( Message::TM_COMMAND, $sent[ Message::TYPE ] & Message::TM_COMMAND );
		$this->assertSame( 'settings', $sent[ Message::TO ] );
		$this->assertSame(
			[ 'name' => 'set', 'arguments' => [ 'a', 'b' ] ],
			[ 'name' => $sent[ Message::VALUE ]['name'], 'arguments' => $sent[ Message::VALUE ]['arguments'] ]
		);
	}

	public function test_an_established_session_skips_the_auth_round_trip(): void {
		Command_Auth::remember_session( self::SPOKE, 'h-0', 'k-0' );
		$this->seed_http( [ $this->response( 200, $this->reply_line( [ 'n' => 1 ] ) ) ] );

		HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' );

		$this->assertCount( 1, $this->calls, 'no second /auth once a session is held' );
		$this->assertStringEndsWith( '/command', $this->calls[0]['url'] );
	}

	public function test_stored_credentials_ride_the_authorization_header(): void {
		$this->seed_http( [
			$this->response( 200, $this->issued_session() ),
			$this->response( 200, $this->reply_line( [] ) ),
		] );

		HTTP_Out_Node::probe_command(
			self::SPOKE,
			$this->server( [ 'auth_username' => 'user', 'auth_password' => 'pass' ] ),
			'settings',
			'get'
		);

		$this->assertSame(
			'Basic ' . \base64_encode( 'user:pass' ),
			$this->calls[0]['args']['headers']['Authorization']
		);
	}

	public function test_an_empty_payload_string_reads_as_an_empty_array(): void {
		$this->seed_http( [
			$this->response( 200, $this->issued_session() ),
			$this->response( 200, $this->reply_line( '' ) ),
		] );

		$this->assertSame( [], HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' ) );
	}

	public function test_the_last_struct_line_wins_over_earlier_noise(): void {
		$body = "not json\n" . $this->reply_line( [ 'first' => 1 ] ) . "\n" . $this->reply_line( [ 'last' => 2 ] );
		$this->seed_http( [
			$this->response( 200, $this->issued_session() ),
			$this->response( 200, $body ),
		] );

		$this->assertSame(
			[ 'last' => 2 ],
			HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' )
		);
	}

	public function test_a_transport_failure_on_auth_names_the_session_as_the_cause(): void {
		$this->seed_http( [ new \WP_Error( 'http_request_failed', 'down' ) ] );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'server refused to issue a command session' );
		HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' );
	}

	public function test_a_non_200_from_auth_refuses_the_probe(): void {
		$this->seed_http( [ $this->response( 503, '' ) ] );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'server refused to issue a command session' );
		HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' );
	}

	public function test_a_session_missing_its_key_is_malformed_not_usable(): void {
		$this->seed_http( [ $this->response( 200, (string) \wp_json_encode( [ 'handle' => 'h-1' ] ) ) ] );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'server returned a malformed command session' );
		HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' );
	}

	public function test_a_transport_failure_on_the_command_reports_the_connection(): void {
		$this->seed_http( [
			$this->response( 200, $this->issued_session() ),
			new \WP_Error( 'http_request_failed', 'down' ),
		] );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'could not connect to server' );
		HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' );
	}

	public function test_a_non_200_from_the_command_reports_its_status(): void {
		$this->seed_http( [
			$this->response( 200, $this->issued_session() ),
			$this->response( 500, '' ),
		] );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'HTTP 500 response from server' );
		HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' );
	}

	public function test_a_body_with_no_struct_line_is_a_malformed_envelope(): void {
		$this->seed_http( [
			$this->response( 200, $this->issued_session() ),
			$this->response( 200, "garbage\n\n" ),
		] );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'server returned malformed command envelope' );
		HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' );
	}

	public function test_a_tm_error_reply_throws_instead_of_returning_its_payload(): void {
		$this->seed_http( [
			$this->response( 200, $this->issued_session() ),
			$this->response( 200, $this->reply_line( [ 'x' => 1 ], Message::TM_COMMAND | Message::TM_ERROR ) ),
		] );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'server returned TM_ERROR for probe' );
		HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' );
	}

	public function test_a_reply_with_no_payload_key_is_a_malformed_response(): void {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::VALUE ] = [ 'name' => 'status' ];
		$this->seed_http( [
			$this->response( 200, $this->issued_session() ),
			$this->response( 200, (string) \wp_json_encode( $message ) ),
		] );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'server returned malformed command response' );
		HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' );
	}

	public function test_a_scalar_payload_is_refused_rather_than_coerced(): void {
		$this->seed_http( [
			$this->response( 200, $this->issued_session() ),
			$this->response( 200, $this->reply_line( 'a string' ) ),
		] );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'server returned non-array command payload' );
		HTTP_Out_Node::probe_command( self::SPOKE, $this->server(), 'settings', 'get' );
	}

	public function test_a_plaintext_spoke_is_refused_before_any_request(): void {
		$this->seed_http( [ $this->response( 200, $this->issued_session() ) ] );

		try {
			HTTP_Out_Node::probe_command(
				self::SPOKE,
				$this->server( [ 'url' => 'http://spoke.example' ] ),
				'settings',
				'get'
			);
			$this->fail( 'a plaintext spoke must be refused' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'not https', $e->getMessage() );
		}
		$this->assertSame( [], $this->calls, 'refused before any request left' );
	}
}
