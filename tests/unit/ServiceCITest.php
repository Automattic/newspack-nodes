<?php
/**
 * ServiceCITest: unit tests for the Service_CI base class — three shared
 * verb-helper seams (require_manage_options, decode_args, require_valid_name)
 * that substrate + application interpreters both reach for. Tests exercise each
 * helper via a transparent subclass that exposes them publicly so the
 * helpers can be asserted in isolation, without dragging in VerbHarness +
 * the request-scope interpreter graph.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Service_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Service_CI_Node::class )]
class ServiceCITest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// Deny by default so the manage_options happy path is explicit.
		$GLOBALS['_wp_test_current_user_can'] = [];
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		Service_CI_Node::$http_call = null;
		unset( $GLOBALS['_wp_test_remote_post_response'] );
		parent::tearDown();
	}

	// ── require_manage_options ───────────────────────────────────────────────

	public function test_require_manage_options_passes_when_capability_granted(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		// No assertion needed — just confirm it doesn't throw.
		ServiceCITestProbe::require_manage_options_probe();
		$this->assertTrue( true );
	}

	public function test_require_manage_options_throws_when_capability_denied(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'permission denied: manage_options required' );
		ServiceCITestProbe::require_manage_options_probe();
	}

	// ── require_valid_name ───────────────────────────────────────────────────

	public function test_require_valid_name_returns_name_when_valid(): void {
		$this->assertSame(
			'my-topology_42',
			ServiceCITestProbe::require_valid_name_probe( 'my-topology_42' )
		);
	}

	public function test_require_valid_name_throws_when_name_empty(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'invalid name' );
		ServiceCITestProbe::require_valid_name_probe( '' );
	}

	public function test_require_valid_name_throws_when_name_violates_default_pattern(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'invalid name' );
		ServiceCITestProbe::require_valid_name_probe( 'has spaces' );
	}

	public function test_require_valid_name_throws_on_path_traversal_attempt(): void {
		$this->expectException( \RuntimeException::class );
		ServiceCITestProbe::require_valid_name_probe( '../etc/passwd' );
	}

	public function test_require_valid_name_respects_custom_pattern(): void {
		// Custom pattern allows colons + dots (the layout-id pattern).
		$this->assertSame(
			'firehose:partition.config',
			ServiceCITestProbe::require_valid_name_probe(
				'firehose:partition.config',
				'/^[a-zA-Z0-9_:.-]+$/'
			)
		);
	}

	public function test_require_valid_name_rejects_when_custom_pattern_excludes_it(): void {
		$this->expectException( \RuntimeException::class );
		ServiceCITestProbe::require_valid_name_probe(
			'has-dash',
			'/^[a-zA-Z0-9_]+$/'
		);
	}

	// ── central gate: commands_from_schema wraps EVERY verb ──────────────────

	public function test_schema_verb_is_denied_without_manage_options(): void {
		// The probe's `ping` verb itself never calls require_manage_options;
		// the gate must come from commands_from_schema wrapping it. With the
		// cap denied (default) the dispatch must return the permission-error
		// string, not the verb's sentinel.
		$result = VerbHarness::fire( new ServiceCITestProbe(), 'probe', 'ping' );
		$this->assertSame( 'permission denied: manage_options required', $result );
	}

	public function test_schema_verb_runs_with_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$result = VerbHarness::fire( new ServiceCITestProbe(), 'probe', 'ping' );
		$this->assertSame( 'pong', $result );
	}

	public function test_auto_injected_help_is_also_gated(): void {
		// `help` is injected by the base commands() accessor, not declared in the
		// schema — so the gate must catch it too, else it's an ungated bypass.
		$result = VerbHarness::fire( new ServiceCITestProbe(), 'probe', 'help' );
		$this->assertSame( 'permission denied: manage_options required', $result );
	}

	public function test_auto_injected_help_runs_after_manage_options_gate_passes(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;

		$result = VerbHarness::fire( new ServiceCITestProbe(), 'probe', 'help' );

		$this->assertStringContainsString( 'help', $result );
		$this->assertStringContainsString( 'ping', $result );
	}

	public function test_schema_with_non_array_commands_installs_no_service_verbs(): void {
		$probe = new ServiceCINonArrayCommandsProbe();

		$this->assertSame( [ 'help' ], \array_keys( $probe->commands() ) );
	}

	public function test_schema_skips_non_array_verb_entries(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;

		$result = VerbHarness::fire( new ServiceCINonArrayVerbProbe(), 'probe', 'ok' );

		$this->assertSame( 'ok', $result );
	}

	public function test_split_first_token_preserves_verbatim_remainder(): void {
		$this->assertSame(
			[ 'save', "topology-name make_node Echo e\n" ],
			ServiceCITestProbe::split_first_token_probe( [ 'save', "topology-name make_node Echo e\n" ] )
		);
	}

	public function test_split_first_token_returns_empty_remainder_for_lone_token(): void {
		$this->assertSame(
			[ 'status', '' ],
			ServiceCITestProbe::split_first_token_probe( [ 'status' ] )
		);
	}

	// ── slice_verb: shape fn → JSON-returning handler ────────────────────────

	public function test_slice_verb_builds_handler_that_json_encodes_the_shape(): void {
		$handler = ServiceCITestProbe::slice_verb_probe(
			static fn ( Command_Interpreter_Node $ci ): array => [ 'ok' => 1 ]
		);
		$interpreter = new ServiceCITestProbe();

		$this->assertSame( '{"ok":1}', $handler( $interpreter, [] ) );
	}

	public function test_slice_verb_passes_the_interpreter_to_the_shape(): void {
		$ci = new ServiceCITestProbe();
		$ci->name( 'probe-named' );
		$handler = ServiceCITestProbe::slice_verb_probe(
			static fn ( Command_Interpreter_Node $self ): array => [ 'name' => $self->name() ]
		);

		$this->assertSame( '{"name":"probe-named"}', $handler( $ci, [] ) );
	}

	public function test_slice_verb_handler_is_gated_when_registered_through_schema(): void {
		// The slice handler itself never self-gates; registering it via node_schema
		// must let commands_from_schema's central wrapper deny it without the cap.
		$result = VerbHarness::fire( new ServiceCISliceVerbProbe(), 'probe', 'slice' );
		$this->assertSame( 'permission denied: manage_options required', $result );
	}

	public function test_slice_verb_handler_runs_through_schema_with_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;

		$result = VerbHarness::fire( new ServiceCISliceVerbProbe(), 'probe', 'slice' );

		$this->assertSame( '{"sliced":true}', $result );
	}

	// ── command_body ──────────────────────────────────────────────────────

	public function test_command_body_builds_packed_tm_command_envelope(): void {
		$method = new \ReflectionMethod( Service_CI_Node::class, 'command_body' );
		$body   = $method->invoke( null, 'discovery', 'get', [ 'a', 'b' ] );
		$decoded = Message::unpacked( $body );

		$this->assertSame( Message::TM_COMMAND, $decoded[ Message::TYPE ] );
		$this->assertSame( Node_Names::HTTP, $decoded[ Message::FROM ] );
		$this->assertSame( 'discovery', $decoded[ Message::TO ] );
		$this->assertSame(
			[ 'name' => 'get', 'arguments' => [ 'a', 'b' ] ],
			$decoded[ Message::VALUE ]
		);
	}

	public function test_command_body_defaults_args_to_empty_list(): void {
		$method  = new \ReflectionMethod( Service_CI_Node::class, 'command_body' );
		$body    = $method->invoke( null, 'workers', 'dump_graph' );
		$decoded = Message::unpacked( $body );

		$this->assertSame( [], $decoded[ Message::VALUE ]['arguments'] );
	}

	// ── probe_command ────────────────────────────────────────────────────

	private function reply_body( array $payload, int $extra_type = 0 ): string {
		$reply = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE | $extra_type;
		$reply[ Message::VALUE ] = [ 'name' => 'get', 'payload' => $payload ];
		return Message::packed( $reply );
	}

	public function test_probe_command_returns_reply_payload_on_success(): void {
		Service_CI_Node::$http_call = fn ( string $url, array $args ): array =>
			[ 'response' => [ 'code' => 200 ], 'body' => $this->reply_body( [ 'lag' => 3 ] ) ];

		$result = ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );

		$this->assertSame( [ 'lag' => 3 ], $result );
	}

	public function test_probe_command_composes_url_from_trailing_slash(): void {
		$seen_url = null;
		Service_CI_Node::$http_call = function ( string $url, array $args ) use ( &$seen_url ): array {
			$seen_url = $url;
			return [ 'response' => [ 'code' => 200 ], 'body' => $this->reply_body( [] ) ];
		};

		ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com/' ], 'discovery', 'get' );

		$this->assertSame( 'https://e.com/wp-json/newspack-nodes/v1/command', $seen_url );
	}

	public function test_probe_command_adds_basic_auth_header_when_credentials_present(): void {
		$seen_headers = null;
		Service_CI_Node::$http_call = function ( string $url, array $args ) use ( &$seen_headers ): array {
			$seen_headers = $args['headers'];
			return [ 'response' => [ 'code' => 200 ], 'body' => $this->reply_body( [] ) ];
		};

		ServiceCITestProbe::probe_command_probe(
			[ 'url' => 'https://e.com', 'auth_username' => 'u', 'auth_password' => 'p' ],
			'discovery',
			'get'
		);

		$this->assertSame(
			'Basic ' . \base64_encode( 'u:p' ),
			$seen_headers['Authorization']
		);
	}

	public function test_probe_command_omits_auth_header_when_credentials_absent(): void {
		$seen_headers = null;
		Service_CI_Node::$http_call = function ( string $url, array $args ) use ( &$seen_headers ): array {
			$seen_headers = $args['headers'];
			return [ 'response' => [ 'code' => 200 ], 'body' => $this->reply_body( [] ) ];
		};

		ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );

		$this->assertArrayNotHasKey( 'Authorization', $seen_headers );
	}

	public function test_probe_command_forwards_to_and_verb_and_args_in_body(): void {
		$seen_body = null;
		Service_CI_Node::$http_call = function ( string $url, array $args ) use ( &$seen_body ): array {
			$seen_body = Message::unpacked( $args['body'] );
			return [ 'response' => [ 'code' => 200 ], 'body' => $this->reply_body( [] ) ];
		};

		ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'workers', 'dump_graph', [ 'p0' ] );

		$this->assertSame( 'workers', $seen_body[ Message::TO ] );
		$this->assertSame(
			[ 'name' => 'dump_graph', 'arguments' => [ 'p0' ] ],
			$seen_body[ Message::VALUE ]
		);
	}

	public function test_probe_command_throws_when_transport_returns_wp_error(): void {
		Service_CI_Node::$http_call = fn ( string $url, array $args ): \WP_Error =>
			new \WP_Error( 'http_request_failed', 'Connection timed out' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'could not connect to server' );
		ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );
	}

	public function test_probe_command_throws_on_non_200_response(): void {
		Service_CI_Node::$http_call = fn ( string $url, array $args ): array =>
			[ 'response' => [ 'code' => 503 ], 'body' => '' ];

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'HTTP 503 response from server' );
		ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );
	}

	public function test_probe_command_throws_when_stream_has_no_struct_envelope(): void {
		Service_CI_Node::$http_call = fn ( string $url, array $args ): array =>
			[ 'response' => [ 'code' => 200 ], 'body' => "not json\n\n" ];

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'malformed command envelope' );
		ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );
	}

	public function test_probe_command_skips_bytestream_noise_and_finds_the_reply(): void {
		$noise                   = Message::new_message();
		$noise[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$noise[ Message::VALUE ] = 'diagnostic stderr line';

		Service_CI_Node::$http_call = fn ( string $url, array $args ): array => [
			'response' => [ 'code' => 200 ],
			'body'     => Message::packed( $noise ) . "\n" . $this->reply_body( [ 'lag' => 7 ] ) . "\n",
		];

		$result = ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );

		$this->assertSame( [ 'lag' => 7 ], $result );
	}

	public function test_probe_command_picks_the_last_matching_envelope_in_the_stream(): void {
		Service_CI_Node::$http_call = fn ( string $url, array $args ): array => [
			'response' => [ 'code' => 200 ],
			'body'     => $this->reply_body( [ 'lag' => 1 ] ) . "\n" . $this->reply_body( [ 'lag' => 2 ] ) . "\n",
		];

		$result = ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );

		$this->assertSame( [ 'lag' => 2 ], $result );
	}

	public function test_probe_command_throws_when_reply_carries_tm_error(): void {
		Service_CI_Node::$http_call = fn ( string $url, array $args ): array => [
			'response' => [ 'code' => 200 ],
			'body'     => $this->reply_body( [], Message::TM_ERROR ),
		];

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'server returned TM_ERROR for probe' );
		ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );
	}

	public function test_probe_command_throws_when_payload_key_missing(): void {
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::VALUE ] = [ 'name' => 'get' ];

		Service_CI_Node::$http_call = fn ( string $url, array $args ): array =>
			[ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'server returned malformed command response' );
		ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );
	}

	public function test_probe_command_throws_on_non_array_payload(): void {
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::VALUE ] = [ 'name' => 'get', 'payload' => 'a string, not an array' ];

		Service_CI_Node::$http_call = fn ( string $url, array $args ): array =>
			[ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'server returned non-array command payload' );
		ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );
	}

	public function test_probe_command_treats_empty_string_payload_as_empty_array(): void {
		$reply                   = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::VALUE ] = [ 'name' => 'get', 'payload' => '' ];

		Service_CI_Node::$http_call = fn ( string $url, array $args ): array =>
			[ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];

		$result = ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );

		$this->assertSame( [], $result );
	}

	public function test_probe_command_uses_default_wp_remote_post_when_seam_is_null(): void {
		$GLOBALS['_wp_test_remote_post_response'] = [
			'response' => [ 'code' => 200 ],
			'body'     => $this->reply_body( [ 'lag' => 9 ] ),
		];

		$result = ServiceCITestProbe::probe_command_probe( [ 'url' => 'https://e.com' ], 'discovery', 'get' );

		$this->assertSame( [ 'lag' => 9 ], $result );
	}
}

/**
 * Subclass that re-exports Service_CI's protected helpers as public static
 * methods. The helpers are protected because the legitimate callers are
 * subclass closures (which can use `self::`); tests need a public surface
 * to invoke them in isolation. Constructing the probe is not required —
 * the helpers are static.
 */
class ServiceCITestProbe extends Service_CI_Node {

	public static function require_manage_options_probe(): void {
		self::require_manage_options();
	}

	public static function require_valid_name_probe(
		string $name,
		string $pattern = '/^[a-zA-Z0-9_-]+$/'
	): string {
		return self::require_valid_name( $name, $pattern );
	}

	public static function split_first_token_probe( array $args ): array {
		return self::split_first_token( $args );
	}

	public static function slice_verb_probe( callable $shape ): \Closure {
		return self::slice_verb( $shape );
	}

	public static function probe_command_probe( array $server, string $to, string $verb, array $verb_args = [] ): array {
		return self::probe_command( $server, $to, $verb, $verb_args );
	}

	/**
	 * One verb whose handler does NOT self-gate — so any auth must come from
	 * the base's central wrapper in commands_from_schema(). Returns a sentinel
	 * the gate test asserts against.
	 */
	public static function node_schema(): array {
		return [
			'category' => 'Hidden',
			'commands' => [
				[
					'name'        => 'ping',
					'description' => 'Probe verb that returns a sentinel; never self-gates.',
					'handler'     => static function ( Command_Interpreter_Node $self, array $args, array $envelope = [] ): string {
						return 'pong';
					},
				],
			],
		];
	}
}

/** Registers a slice_verb()-built handler via node_schema to exercise the central gate end-to-end. */
class ServiceCISliceVerbProbe extends Service_CI_Node {
	public static function node_schema(): array {
		return [
			'category' => 'Hidden',
			'commands' => [
				[
					'name'        => 'slice',
					'description' => 'A slice_verb()-built handler that JSON-encodes a fixed shape.',
					'handler'     => self::slice_verb( static fn ( Command_Interpreter_Node $ci ): array => [ 'sliced' => true ] ),
				],
			],
		];
	}
}

class ServiceCINonArrayCommandsProbe extends Service_CI_Node {
	public static function node_schema(): array {
		return [
			'category' => 'Hidden',
			'commands' => 'not-a-list',
		];
	}
}

class ServiceCINonArrayVerbProbe extends Service_CI_Node {
	public static function node_schema(): array {
		return [
			'category' => 'Hidden',
			'commands' => [
				'not-a-verb',
				[
					'name'    => 'ok',
					'handler' => static fn (): string => 'ok',
				],
			],
		];
	}
}
