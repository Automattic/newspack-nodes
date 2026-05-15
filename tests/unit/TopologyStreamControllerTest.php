<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Rest\TopologyStreamController;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Unit tests for TopologyStreamController. Complement the integration
 * tests in tests/integration/TopologyStreamControllerTest.php by
 * exercising the uncovered surface area:
 *   - register_routes
 *   - post_command (all type dispatch branches + validation)
 *   - write_typed_message (each TM_* type)
 *   - emit_message_as_sse (broadcast / for-us / drop / JSON-decode rules)
 *   - send_command (auto-fired vs typed key)
 *   - test seams (set_base_dir, set_test_mode, set_test_tick_limit)
 */
#[CoversClass( TopologyStreamController::class )]
class TopologyStreamControllerTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_test_registered_routes'] = [];
		// stream_permissions_check (from SSE_Stream_Trait) reads via current_user_can,
		// which the bootstrap stub backs with _wp_test_current_user_can.
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$this->tmp = $this->make_temp_dir( 'topology-stream-unit-' );
		\mkdir( $this->tmp . '/locks', 0755, true );
	}

	protected function tearDown(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];
		$GLOBALS['_wp_test_current_user_can']  = [];
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function make_request( array $params = [] ): \WP_REST_Request {
		$req = new \WP_REST_Request( 'POST' );
		foreach ( $params as $key => $value ) {
			$req->set_param( $key, $value );
		}
		return $req;
	}

	private function fresh_controller(): TopologyStreamController {
		$ctrl = new TopologyStreamController();
		$ctrl->set_base_dir( $this->tmp );
		return $ctrl;
	}

	/**
	 * Build a worker lock dir so `attach_to_worker` succeeds.
	 */
	private function provision_worker( string $reader_id = 'firehose-workers.p0' ): void {
		\mkdir( "{$this->tmp}/locks/{$reader_id}.lock.d", 0755, true );
	}

	/**
	 * Read all packed Messages written to the worker's input Partition.
	 *
	 * @return array<int,array>
	 */
	private function read_worker_input( string $reader_id = 'firehose-workers.p0' ): array {
		$log = "{$this->tmp}/ipc/{$reader_id}/input/p0/0.log";
		if ( ! \file_exists( $log ) ) {
			return [];
		}
		$lines = \array_filter(
			\explode( "\n", (string) \file_get_contents( $log ) ),
			static fn ( $l ) => '' !== $l
		);
		return \array_map( static fn ( $packed ) => Message::unpacked( $packed ), $lines );
	}

	// ── register_routes ────────────────────────────────────────────────────

	public function test_register_routes_registers_two_routes(): void {
		( new TopologyStreamController() )->register_routes();
		$routes = $GLOBALS['_wp_test_registered_routes'];
		$this->assertCount( 2, $routes );
	}

	public function test_register_routes_namespaces_are_v1(): void {
		( new TopologyStreamController() )->register_routes();
		foreach ( $GLOBALS['_wp_test_registered_routes'] as $route ) {
			$this->assertSame( 'newspack-nodes/v1', $route['namespace'] );
		}
	}

	public function test_register_routes_stream_endpoint_is_get(): void {
		( new TopologyStreamController() )->register_routes();
		$stream = $GLOBALS['_wp_test_registered_routes'][0];
		$this->assertStringEndsWith( '/stream', $stream['route'] );
		$this->assertSame( 'GET', $stream['args']['methods'] );
		// Required args.
		$this->assertTrue( $stream['args']['args']['topology']['required'] );
		$this->assertTrue( $stream['args']['args']['partition']['required'] );
	}

	public function test_register_routes_command_endpoint_is_post(): void {
		( new TopologyStreamController() )->register_routes();
		$cmd = $GLOBALS['_wp_test_registered_routes'][1];
		$this->assertStringEndsWith( '/command', $cmd['route'] );
		$this->assertSame( 'POST', $cmd['args']['methods'] );
		// sse_pid is required so worker replies route back to the right SSE listener.
		$this->assertTrue( $cmd['args']['args']['sse_pid']['required'] );
		$this->assertFalse( $cmd['args']['args']['type']['required'] );
		$this->assertFalse( $cmd['args']['args']['name']['required'] );
	}

	public function test_register_routes_attaches_permission_callback(): void {
		( new TopologyStreamController() )->register_routes();
		foreach ( $GLOBALS['_wp_test_registered_routes'] as $route ) {
			$callback = $route['args']['permission_callback'];
			$this->assertIsArray( $callback );
			$this->assertSame( 'stream_permissions_check', $callback[1] );
		}
	}

	// ── stream_permissions_check (provided by SSE_Stream_Trait) ────────────

	public function test_stream_permissions_check_allows_admin(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$result = $this->fresh_controller()->stream_permissions_check();
		$this->assertTrue( $result );
	}

	public function test_stream_permissions_check_denies_anonymous(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result = $this->fresh_controller()->stream_permissions_check();
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rest_forbidden', $result->get_error_code() );
	}

	// ── post_command — validation ──────────────────────────────────────────

	public function test_post_command_rejects_zero_sse_pid(): void {
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'name'      => 'ls',
				'sse_pid'   => 0,
			]
		);
		$resp = $ctrl->post_command( $req );
		$this->assertInstanceOf( \WP_Error::class, $resp );
		$this->assertSame( 'missing_sse_pid', $resp->get_error_code() );
		$this->assertSame( 400, $resp->get_error_data()['status'] ?? 0 );
	}

	public function test_post_command_rejects_negative_sse_pid(): void {
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'name'      => 'ls',
				'sse_pid'   => -1,
			]
		);
		$resp = $ctrl->post_command( $req );
		$this->assertInstanceOf( \WP_Error::class, $resp );
		$this->assertSame( 'missing_sse_pid', $resp->get_error_code() );
	}

	public function test_post_command_rejects_empty_name_for_command_type(): void {
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'name'      => '',
				'sse_pid'   => 42,
			]
		);
		$resp = $ctrl->post_command( $req );
		$this->assertInstanceOf( \WP_Error::class, $resp );
		$this->assertSame( 'empty_command', $resp->get_error_code() );
		$this->assertSame( 400, $resp->get_error_data()['status'] ?? 0 );
	}

	public function test_post_command_rejects_whitespace_name_for_command_type(): void {
		// Trim strips whitespace; trimmed empty string triggers the empty_command branch.
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'name'      => '   ',
				'sse_pid'   => 42,
			]
		);
		$resp = $ctrl->post_command( $req );
		$this->assertInstanceOf( \WP_Error::class, $resp );
		$this->assertSame( 'empty_command', $resp->get_error_code() );
	}

	public function test_post_command_returns_404_when_worker_lock_missing(): void {
		// No provision_worker() call — lock dir won't exist.
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'name'      => 'ls',
				'sse_pid'   => 42,
			]
		);
		$resp = $ctrl->post_command( $req );
		$this->assertInstanceOf( \WP_Error::class, $resp );
		$this->assertSame( 'worker_not_found', $resp->get_error_code() );
		$this->assertSame( 404, $resp->get_error_data()['status'] ?? 0 );
	}

	// ── post_command — happy paths exercise each type branch in write_typed_message ─

	public function test_post_command_writes_tm_command_by_default(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'name'      => 'ls',
				'arguments' => '-al',
				'sse_pid'   => 42,
			]
		);
		$resp = $ctrl->post_command( $req );

		$this->assertInstanceOf( \WP_REST_Response::class, $resp );
		$this->assertSame( 202, $resp->get_status() );
		$this->assertTrue( $resp->get_data()['queued'] );

		$msgs = $this->read_worker_input();
		$this->assertCount( 1, $msgs );
		$msg = $msgs[0];
		$this->assertSame( Message::TM_COMMAND, $msg[ Message::TYPE ] );
		$this->assertSame( '_command_interpreter', $msg[ Message::TO ] );
		$this->assertSame( '_output/42', $msg[ Message::FROM ] );
		$payload = \json_decode( (string) $msg[ Message::VALUE ], true );
		$this->assertSame( 'ls',  $payload['name'] );
		$this->assertSame( '-al', $payload['arguments'] );
	}

	public function test_post_command_writes_tm_command_with_custom_to(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'name'      => 'dump_config',
				'to'        => 'firehose-out',
				'sse_pid'   => 7,
			]
		);
		$ctrl->post_command( $req );

		$msg = $this->read_worker_input()[0];
		$this->assertSame( 'firehose-out', $msg[ Message::TO ] );
		$this->assertSame( '_output/7',    $msg[ Message::FROM ] );
	}

	public function test_post_command_writes_tm_ping(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'type'      => 'ping',
				'sse_pid'   => 9,
			]
		);
		$ctrl->post_command( $req );

		$msg = $this->read_worker_input()[0];
		$this->assertSame( Message::TM_PING, $msg[ Message::TYPE ] );
		$this->assertSame( '_command_interpreter', $msg[ Message::TO ] );
		$this->assertSame( '_output/9', $msg[ Message::FROM ] );
		// Default ping value is the current timestamp; just verify it's non-empty numeric.
		$this->assertNotSame( '', $msg[ Message::VALUE ] );
	}

	public function test_post_command_writes_tm_ping_with_custom_to(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'type'      => 'ping',
				'to'        => 'firehose-out',
				'sse_pid'   => 9,
			]
		);
		$ctrl->post_command( $req );

		$msg = $this->read_worker_input()[0];
		$this->assertSame( 'firehose-out', $msg[ Message::TO ] );
	}

	public function test_post_command_writes_tm_info(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'type'      => 'info',
				'arguments' => 'an arbitrary payload',
				'to'        => 'firehose-fanout',
				'sse_pid'   => 13,
			]
		);
		$ctrl->post_command( $req );

		$msg = $this->read_worker_input()[0];
		$this->assertSame( Message::TM_INFO, $msg[ Message::TYPE ] );
		$this->assertSame( 'firehose-fanout', $msg[ Message::TO ] );
		$this->assertSame( 'an arbitrary payload', $msg[ Message::VALUE ] );
	}

	public function test_post_command_writes_tm_bytestream(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'type'      => 'bytestream',
				'arguments' => "line one\nline two\n",
				'to'        => 'firehose-out',
				'sse_pid'   => 5,
			]
		);
		$ctrl->post_command( $req );

		$msg = $this->read_worker_input()[0];
		$this->assertSame( Message::TM_BYTESTREAM, $msg[ Message::TYPE ] );
		$this->assertSame( 'firehose-out', $msg[ Message::TO ] );
		$this->assertSame( "line one\nline two\n", $msg[ Message::VALUE ] );
	}

	public function test_post_command_writes_tm_eof(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'type'      => 'eof',
				'to'        => 'firehose-out',
				'sse_pid'   => 11,
			]
		);
		$ctrl->post_command( $req );

		$msg = $this->read_worker_input()[0];
		$this->assertSame( Message::TM_EOF, $msg[ Message::TYPE ] );
		$this->assertSame( 'firehose-out', $msg[ Message::TO ] );
	}

	public function test_post_command_writes_tm_request(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'type'      => 'request',
				'arguments' => 'rpc_payload',
				'to'        => 'request-handler',
				'sse_pid'   => 21,
			]
		);
		$ctrl->post_command( $req );

		$msg = $this->read_worker_input()[0];
		$this->assertSame( Message::TM_REQUEST, $msg[ Message::TYPE ] );
		$this->assertSame( 'request-handler', $msg[ Message::TO ] );
		$this->assertSame( 'rpc_payload', $msg[ Message::VALUE ] );
	}

	public function test_post_command_falls_through_to_command_when_type_unknown(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'type'      => 'no-such-type', // Hits default branch.
				'name'      => 'ls',
				'sse_pid'   => 33,
			]
		);
		$ctrl->post_command( $req );

		$msg = $this->read_worker_input()[0];
		$this->assertSame( Message::TM_COMMAND, $msg[ Message::TYPE ] );
		$this->assertSame( '_command_interpreter', $msg[ Message::TO ] );
	}

	public function test_post_command_normalizes_uppercase_type(): void {
		// Type is lowercased via strtolower() — verify Ping → ping.
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'type'      => 'PING',
				'sse_pid'   => 99,
			]
		);
		$ctrl->post_command( $req );

		$msg = $this->read_worker_input()[0];
		$this->assertSame( Message::TM_PING, $msg[ Message::TYPE ] );
	}

	// ── emit_message_as_sse — filter rules ─────────────────────────────────

	public function test_emit_passes_broadcast_message_with_empty_to(): void {
		$ctrl = $this->fresh_controller();
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::FROM ]      = 'producer';
		$msg[ Message::TO ]        = ''; // Broadcast.
		$msg[ Message::VALUE ]     = 'broadcast-data';

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		$this->assertStringContainsString( "event: msg\n", $out );
		$this->assertStringContainsString( '"value":"broadcast-data"', $out );
	}

	public function test_emit_passes_message_addressed_to_our_pid_underscore_output_prefix(): void {
		$ctrl = $this->fresh_controller();
		$pid  = (string) \getmypid();
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_RESPONSE;
		$msg[ Message::TO ]   = '_output/' . $pid;
		$msg[ Message::VALUE ] = 'for-us';

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		$this->assertStringContainsString( "event: msg\n", $out );
		$this->assertStringContainsString( '"value":"for-us"', $out );
	}

	public function test_emit_passes_message_addressed_to_bare_pid(): void {
		// After _output gets peeled, TO is just the bare pid string.
		$ctrl = $this->fresh_controller();
		$pid  = (string) \getmypid();
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_RESPONSE;
		$msg[ Message::TO ]   = $pid;
		$msg[ Message::VALUE ] = 'peeled';

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		$this->assertStringContainsString( "event: msg\n", $out );
	}

	public function test_emit_drops_message_addressed_to_another_session(): void {
		// Pick a pid that's guaranteed to differ from getmypid().
		$other_pid = \getmypid() + 12345;
		$ctrl      = $this->fresh_controller();
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_RESPONSE;
		$msg[ Message::TO ]   = '_output/' . $other_pid;
		$msg[ Message::VALUE ] = 'someone-else';

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		// Nothing emitted — the multi-session filter dropped it.
		$this->assertSame( '', $out );
	}

	public function test_emit_drops_message_with_unrelated_destination(): void {
		$ctrl = $this->fresh_controller();
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$msg[ Message::TO ]   = 'some-random-node';
		$msg[ Message::VALUE ] = 'lost';

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		$this->assertSame( '', $out );
	}

	public function test_emit_decodes_json_object_value(): void {
		// VALUE that looks like a JSON object gets decoded one level.
		$ctrl = $this->fresh_controller();
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_COMMAND;
		$msg[ Message::TO ]   = '';
		$msg[ Message::VALUE ] = \wp_json_encode( [ 'name' => 'ls', 'payload' => 'output' ] );

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		// Decoded form appears in the SSE data field as a nested object.
		$this->assertStringContainsString( '"value":{"name":"ls"', $out );
	}

	public function test_emit_decodes_json_array_value(): void {
		// VALUE that's a JSON array (starts with `[`) also decodes.
		$ctrl = $this->fresh_controller();
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$msg[ Message::TO ]   = '';
		$msg[ Message::VALUE ] = \wp_json_encode( [ 1, 2, 3 ] );

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		$this->assertStringContainsString( '"value":[1,2,3]', $out );
	}

	public function test_emit_leaves_non_json_value_as_string(): void {
		$ctrl = $this->fresh_controller();
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$msg[ Message::TO ]   = '';
		$msg[ Message::VALUE ] = 'plain-string-not-json';

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		$this->assertStringContainsString( '"value":"plain-string-not-json"', $out );
	}

	public function test_emit_handles_empty_string_value_without_decoding(): void {
		$ctrl = $this->fresh_controller();
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$msg[ Message::TO ]   = '';
		$msg[ Message::VALUE ] = '';

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		$this->assertStringContainsString( '"value":""', $out );
	}

	public function test_emit_leaves_array_value_untouched(): void {
		// TM_STRUCT messages already carry an array in VALUE; the JSON-decode
		// guard checks is_string() so the array passes straight through.
		$ctrl = $this->fresh_controller();
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_STRUCT;
		$msg[ Message::TO ]   = '';
		$msg[ Message::VALUE ] = [ 'already' => 'decoded' ];

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		$this->assertStringContainsString( '"value":{"already":"decoded"}', $out );
	}

	public function test_emit_leaves_malformed_json_value_as_string(): void {
		// String starts with `{` but isn't valid JSON. Decode returns non-array;
		// value falls through unchanged.
		$ctrl = $this->fresh_controller();
		$msg                  = Message::new_message();
		$msg[ Message::TYPE ] = Message::TM_BYTESTREAM;
		$msg[ Message::TO ]   = '';
		$msg[ Message::VALUE ] = '{not really json';

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		// The raw text survives JSON-encoded as a string in the SSE data.
		$this->assertStringContainsString( '"value":"{not really json"', $out );
	}

	public function test_emit_includes_all_envelope_fields(): void {
		$ctrl = $this->fresh_controller();
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$msg[ Message::TIMESTAMP ] = 1700000000.5;
		$msg[ Message::FROM ]      = 'producer/sub';
		$msg[ Message::TO ]        = '';
		$msg[ Message::ID ]        = 'msgid-42';
		$msg[ Message::KEY ]       = 'gui:typed';
		$msg[ Message::VALUE ]     = 'data';

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		// json_encode escapes forward slashes by default; the controller doesn't
		// pass JSON_UNESCAPED_SLASHES, so the wire form is "producer\/sub".
		$this->assertStringContainsString( '"from":"producer\/sub"', $out );
		$this->assertStringContainsString( '"id":"msgid-42"', $out );
		$this->assertStringContainsString( '"key":"gui:typed"', $out );
		$this->assertStringContainsString( '"ts":1700000000.5', $out );
		$this->assertStringContainsString( '"type":1', $out );
	}

	public function test_emit_substitutes_defaults_for_missing_fields(): void {
		// Pass a degenerate array — missing keys default to '' / 0.
		$ctrl = $this->fresh_controller();
		$msg  = [];

		\ob_start();
		$ctrl->emit_message_as_sse( $msg );
		$out = (string) \ob_get_clean();

		$this->assertStringContainsString( '"type":0', $out );
		$this->assertStringContainsString( '"from":""', $out );
		$this->assertStringContainsString( '"id":""', $out );
	}

	// ── test seams ─────────────────────────────────────────────────────────

	public function test_set_test_tick_limit_accepts_zero(): void {
		$ctrl = new TopologyStreamController();
		$ctrl->set_test_tick_limit( 0 );
		// Just exercising the setter — no assertion required beyond no throw.
		$this->assertTrue( true );
	}

	public function test_set_base_dir_routes_attach_against_override(): void {
		// If the override worked, attach_to_worker against a missing lock dir
		// fails fast. (We don't provision_worker(), so this should 404.)
		$other_dir = $this->make_temp_dir( 'topology-stream-override-' );
		\mkdir( $other_dir . '/locks', 0755, true );

		$ctrl = new TopologyStreamController();
		$ctrl->set_base_dir( $other_dir );
		$req  = $this->make_request(
			[
				'topology'  => 'firehose-workers',
				'partition' => 0,
				'name'      => 'ls',
				'sse_pid'   => 7,
			]
		);
		$resp = $ctrl->post_command( $req );
		$this->assertInstanceOf( \WP_Error::class, $resp );
		$this->assertSame( 'worker_not_found', $resp->get_error_code() );

		$this->rmdir_recursive( $other_dir );
	}

	public function test_set_test_mode_disables_init_sse_headers_during_stream(): void {
		// With set_test_mode(true), stream() skips init_sse_headers and the
		// outer ob_start captures the SSE output.
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$ctrl->set_test_mode( true );

		$req = new \WP_REST_Request( 'GET' );
		$req->set_param( 'topology',  'firehose-workers' );
		$req->set_param( 'partition', 0 );

		\ob_start();
		$ctrl->stream( $req );
		$out = (string) \ob_get_clean();

		// In test mode, the SSE bytes round-trip through ob_get_clean.
		$this->assertStringContainsString( "event: hello\n", $out );
	}

	// ── stream() — error path coverage ─────────────────────────────────────

	public function test_stream_returns_wp_error_when_worker_lock_missing(): void {
		// No provision_worker() — attach should fail.
		$ctrl = $this->fresh_controller();
		$req  = new \WP_REST_Request( 'GET' );
		$req->set_param( 'topology',  'firehose-workers' );
		$req->set_param( 'partition', 0 );
		$resp = $ctrl->stream( $req );
		$this->assertInstanceOf( \WP_Error::class, $resp );
		$this->assertSame( 'worker_not_found', $resp->get_error_code() );
		$this->assertSame( 404, $resp->get_error_data()['status'] ?? 0 );
	}

	public function test_stream_emits_initial_dump_metadata_with_gui_auto_key(): void {
		// Stream's send_command path stamps KEY='gui:auto' so the frontend
		// can distinguish auto-fired refreshes from user-typed commands.
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$ctrl->set_test_mode( true );

		$req = new \WP_REST_Request( 'GET' );
		$req->set_param( 'topology',  'firehose-workers' );
		$req->set_param( 'partition', 0 );

		\ob_start();
		$ctrl->stream( $req );
		\ob_get_clean();

		$msgs = $this->read_worker_input();
		$this->assertNotEmpty( $msgs );
		// First message is dump_metadata.
		$first = $msgs[0];
		$payload = \json_decode( (string) $first[ Message::VALUE ], true );
		$this->assertSame( 'dump_metadata', $payload['name'] );
		$this->assertSame( 'gui:auto', $first[ Message::KEY ] );
	}

	public function test_stream_emits_uptime_with_gui_uptime_key(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$ctrl->set_test_mode( true );

		$req = new \WP_REST_Request( 'GET' );
		$req->set_param( 'topology',  'firehose-workers' );
		$req->set_param( 'partition', 0 );

		\ob_start();
		$ctrl->stream( $req );
		\ob_get_clean();

		$msgs    = $this->read_worker_input();
		$payloads = \array_map(
			static fn ( array $m ) => [
				'name' => \json_decode( (string) $m[ Message::VALUE ], true )['name'] ?? '',
				'key'  => $m[ Message::KEY ] ?? '',
			],
			$msgs
		);
		$uptime_entries = \array_filter( $payloads, static fn ( $p ) => 'uptime' === $p['name'] );
		$this->assertNotEmpty( $uptime_entries, 'stream must fire an uptime command alongside dump_metadata' );
		foreach ( $uptime_entries as $entry ) {
			$this->assertSame( 'gui:uptime', $entry['key'] );
		}
	}

	public function test_stream_uses_test_tick_limit_to_bound_iterations(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$ctrl->set_test_mode( true );
		$ctrl->set_test_tick_limit( 5 );

		$req = new \WP_REST_Request( 'GET' );
		$req->set_param( 'topology',  'firehose-workers' );
		$req->set_param( 'partition', 0 );

		\ob_start();
		$ctrl->stream( $req );
		\ob_get_clean();

		$msgs    = $this->read_worker_input();
		$dumps   = \array_filter(
			$msgs,
			static fn ( array $m ) =>
				'dump_metadata' === ( \json_decode( (string) $m[ Message::VALUE ], true )['name'] ?? '' )
		);
		$this->assertSame( 5, \count( $dumps ), 'tick limit must cap dump_metadata sends' );
	}

	public function test_stream_emits_hello_with_topology_partition_and_pid(): void {
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$ctrl->set_test_mode( true );

		$req = new \WP_REST_Request( 'GET' );
		$req->set_param( 'topology',  'firehose-workers' );
		$req->set_param( 'partition', 0 );

		\ob_start();
		$ctrl->stream( $req );
		$out = (string) \ob_get_clean();

		$this->assertStringContainsString( "event: hello\n", $out );
		$this->assertStringContainsString( '"topology":"firehose-workers"', $out );
		$this->assertStringContainsString( '"partition":0', $out );
		$this->assertStringContainsString( '"pid":' . \getmypid(), $out );
	}

	public function test_stream_emits_heartbeat_event_on_long_run(): void {
		// With HEARTBEAT_INTERVAL_S thresholds collapsing each iteration in test
		// mode, the heartbeat path fires at least once across multiple ticks.
		$this->provision_worker();
		$ctrl = $this->fresh_controller();
		$ctrl->set_test_mode( true );
		$ctrl->set_test_tick_limit( 3 );

		$req = new \WP_REST_Request( 'GET' );
		$req->set_param( 'topology',  'firehose-workers' );
		$req->set_param( 'partition', 0 );

		\ob_start();
		$ctrl->stream( $req );
		$out = (string) \ob_get_clean();

		$this->assertStringContainsString( "event: heartbeat\n", $out );
	}
}
