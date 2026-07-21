<?php
/**
 * VaultCINodeTest: unit tests for Vault_CI, the substrate `vault` service CI
 * ported from event-logger-nodes' Servers_CI.
 *
 * Six verbs proxy the substrate Vault credential store: list, get, add,
 * update, delete, test. Asserts the public credential-stripped shape (no
 * `logs`, no credentials), the manage_options auth gate on the four mutating
 * verbs, the decoupled `newspack_nodes/vault/changed` action firing on
 * mutations, and the `/command` discovery probe wire shape via the static
 * `$http_call` closure seam.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit\Rest;

use Newspack_Nodes\Message;
use Newspack_Nodes\Rest\Vault_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Vault;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Vault_CI_Node::class )]
class VaultCINodeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$GLOBALS['_wp_actions']               = [];
		\delete_option( Vault::OPTION_KEY );
		Vault::get_instance()->reset_cache();
		Vault_CI_Node::$http_call = null;
	}

	protected function tearDown(): void {
		VerbHarness::reset();
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		\delete_option( Vault::OPTION_KEY );
		Vault::get_instance()->reset_cache();
		Vault_CI_Node::$http_call = null;
		// Reset here too: a throw before the in-body unset would otherwise leave this
		// stub overriding wp_remote_post for every later test.
		unset( $GLOBALS['_wp_test_remote_post_response'] );
		parent::tearDown();
	}

	// ---------------------------------------------------------------------
	// list / get — credential-stripped public shape, no `logs`.
	// ---------------------------------------------------------------------

	public function test_list_strips_credentials_and_has_no_logs(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'list' );

		$this->assertIsArray( $out );
		$this->assertArrayHasKey( 'spoke1', $out );
		$this->assertTrue( $out['spoke1']['has_credentials'] );
		$this->assertSame( 'https://e.com', $out['spoke1']['url'] );
		$this->assertArrayNotHasKey( 'auth_password', $out['spoke1'] );
		$this->assertArrayNotHasKey( 'auth_username', $out['spoke1'] );
		$this->assertArrayNotHasKey( 'logs', $out['spoke1'] );
		$this->assertArrayNotHasKey( 'enabled', $out['spoke1'] ); // enabled dropped from public shape.
	}

	public function test_get_returns_single_server_public_shape(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'get', 'spoke1' );

		$this->assertIsArray( $out );
		$this->assertSame( 'spoke1', $out['id'] );
		$this->assertSame( 'https://e.com', $out['url'] );
		$this->assertFalse( $out['has_credentials'] );
		$this->assertArrayNotHasKey( 'logs', $out );
	}

	// ---------------------------------------------------------------------
	// add / update / delete — fire newspack_nodes/vault/changed.
	// ---------------------------------------------------------------------

	public function test_add_fires_changed_action(): void {
		$captured = [];
		\add_action(
			'newspack_nodes/vault/changed',
			static function ( $id, $action ) use ( &$captured ) {
				$captured = \compact( 'id', 'action' );
			},
			10,
			2
		);

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'add', 'spoke1 --url=https://e.com' );

		$this->assertIsArray( $out );
		$this->assertSame( 'spoke1', $out['id'] );
		$this->assertSame( 'spoke1', $captured['id'] );
		$this->assertSame( 'added', $captured['action'] );
	}

	public function test_add_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'add', 'spoke1 --url=https://e.com' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'permission denied', $out );
		Vault::get_instance()->reset_cache();
		$this->assertNull( Vault::get_instance()->get( 'spoke1' ) );
	}

	public function test_update_fires_changed_action(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();

		$captured = [];
		\add_action(
			'newspack_nodes/vault/changed',
			static function ( $id, $action ) use ( &$captured ) {
				$captured = \compact( 'id', 'action' );
			},
			10,
			2
		);

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'update', 'spoke1 --url=https://changed.example' );

		$this->assertIsArray( $out );
		$this->assertSame( 'spoke1', $captured['id'] );
		$this->assertSame( 'updated', $captured['action'] );
	}

	public function test_delete_fires_changed_action(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();

		$captured = [];
		\add_action(
			'newspack_nodes/vault/changed',
			static function ( $id, $action ) use ( &$captured ) {
				$captured = \compact( 'id', 'action' );
			},
			10,
			2
		);

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'delete', 'spoke1' );

		$this->assertIsArray( $out );
		$this->assertSame( 'spoke1', $out['id'] );
		$this->assertSame( 'removed', $captured['action'] );
		Vault::get_instance()->reset_cache();
		$this->assertNull( Vault::get_instance()->get( 'spoke1' ) );
	}

	// ---------------------------------------------------------------------
	// test verb — discovery.get probe through the /command endpoint.
	// ---------------------------------------------------------------------

	public function test_test_verb_posts_discovery_get_command(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Vault::get_instance()->reset_cache();

		$seen                     = [];
		Vault_CI_Node::$http_call = static function ( string $url, array $args ) use ( &$seen ): array {
			$seen  = [ 'url' => $url, 'body' => $args['body'], 'headers' => $args['headers'] ];
			$reply = Message::new_message();
			$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
			$reply[ Message::VALUE ] = [ 'name' => 'get', 'payload' => [ 'lag' => 3 ] ];
			return [ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];
		};

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsArray( $out );
		$this->assertSame( 'spoke1', $out['id'] );
		$this->assertSame( 'connected', $out['status'] );
		$this->assertSame( 3, $out['response']['lag'] );
		$this->assertSame( 'https://e.com/wp-json/newspack-nodes/v1/command', $seen['url'] );
		$this->assertSame( 'text/plain; charset=UTF-8', $seen['headers']['Content-Type'] );
		$this->assertStringStartsWith( 'Basic ', $seen['headers']['Authorization'] );

		$decoded = Message::unpacked( $seen['body'] );
		$this->assertSame( Message::TM_COMMAND, $decoded[ Message::TYPE ] );
		$this->assertSame( \Newspack_Nodes\Node_Names::HTTP, $decoded[ Message::FROM ] );
		$this->assertSame( 'discovery', $decoded[ Message::TO ] );
		$this->assertSame( 'get', $decoded[ Message::VALUE ]['name'] );
	}

	public function test_test_verb_extracts_reply_from_stderr_polluted_stream(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Vault::get_instance()->reset_cache();

		// The spoke's /command response is a JSONL message STREAM: diagnostic
		// stderr lines (TM_BYTESTREAM, string VALUE) can precede the command
		// reply. probe_remote must find the reply, not choke on line one.
		Vault_CI_Node::$http_call = static function ( string $url, array $args ): array {
			$noise                   = Message::new_message();
			$noise[ Message::TYPE ]  = Message::TM_BYTESTREAM;
			$noise[ Message::VALUE ] = 'Newspack ELN: hooks missing for pointer rule "abc"';

			$reply                   = Message::new_message();
			$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
			$reply[ Message::VALUE ] = [ 'name' => 'get', 'payload' => [ 'lag' => 5 ] ];

			$body = Message::packed( $noise ) . "\n" . Message::packed( $reply ) . "\n";
			return [ 'response' => [ 'code' => 200 ], 'body' => $body ];
		};

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertSame( 'connected', $out['status'] );
		$this->assertSame( 5, $out['response']['lag'] );
	}

	public function test_test_verb_returns_error_on_non_200(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();

		Vault_CI_Node::$http_call = static fn ( string $url, array $args ): array =>
			[ 'response' => [ 'code' => 503 ], 'body' => '' ];

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( '503', $out );
	}

	public function test_test_verb_rejects_unauthorized(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'permission denied', $out );
	}

	// ---------------------------------------------------------------------
	// not-found / bad-argument throw paths across the verbs.
	// ---------------------------------------------------------------------

	public function test_get_throws_on_unknown_server(): void {
		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'get', 'ghost' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'server not found: ghost', $out );
	}

	public function test_get_throws_when_id_missing(): void {
		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'get' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'id required', $out );
	}

	public function test_add_throws_on_invalid_id(): void {
		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'add', 'bad!id --url=https://e.com' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'invalid server id', $out );
	}

	public function test_add_throws_when_server_already_exists(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'add', 'spoke1 --url=https://e.com' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'server already exists: spoke1', $out );
	}

	public function test_add_throws_when_registry_rejects_config(): void {
		// Valid id, no collision, but a non-HTTPS URL trips validate_config.
		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'add', 'spoke1 --url=http://insecure.example' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'add failed', $out );
	}

	public function test_update_throws_when_id_missing(): void {
		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'update', '--url=https://e.com' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'id required', $out );
	}

	public function test_update_throws_on_unknown_server(): void {
		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'update', 'ghost --url=https://e.com' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'server not found: ghost', $out );
	}

	public function test_update_throws_when_registry_rejects(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		// Downgrading to a non-HTTPS URL fails validate_config → registry returns false.
		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'update', 'spoke1 --url=http://insecure.example' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'update failed', $out );
	}

	public function test_delete_throws_on_unknown_server(): void {
		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'delete', 'ghost' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'server not found: ghost', $out );
	}

	public function test_delete_throws_for_config_file_server(): void {
		$ref = new \ReflectionProperty( \Newspack_Nodes\Config::class, 'config_defaults' );
		$ref->setValue( null, [ 'vault' => [ 'cfg' => [ 'url' => 'https://pinned.example' ] ] ] );
		Vault::get_instance()->reset_cache();
		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'delete', 'cfg' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'delete failed', $out );
		\Newspack_Nodes\Config::reset();
	}

	public function test_test_verb_throws_on_unknown_server(): void {
		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'ghost' );
		$this->assertIsString( $out );
		$this->assertStringContainsString( 'server not found: ghost', $out );
	}

	// ---------------------------------------------------------------------
	// probe_remote — default wp_remote_post closure + response classification.
	// ---------------------------------------------------------------------

	public function test_test_verb_uses_default_wp_remote_post_when_no_seam(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		// Leave $http_call null so probe_remote falls through to its lazily
		// defaulted wp_remote_post wrapper; the stub returns a real envelope.
		$reply = Message::new_message();
		$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$reply[ Message::VALUE ] = [ 'name' => 'get', 'payload' => [ 'lag' => 7 ] ];
		$GLOBALS['_wp_test_remote_post_response'] = [ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		unset( $GLOBALS['_wp_test_remote_post_response'] );
		$this->assertIsArray( $out );
		$this->assertSame( 'connected', $out['status'] );
		$this->assertSame( 7, $out['response']['lag'] );
	}

	public function test_test_verb_errors_when_transport_returns_wp_error(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		Vault_CI_Node::$http_call = static fn ( string $url, array $args ): \WP_Error =>
			new \WP_Error( 'http_request_failed', 'down' );

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'could not connect', $out );
	}

	public function test_test_verb_errors_on_malformed_envelope(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		Vault_CI_Node::$http_call = static fn ( string $url, array $args ): array =>
			[ 'response' => [ 'code' => 200 ], 'body' => '"just-a-string"' ];

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'malformed command envelope', $out );
	}

	public function test_test_verb_errors_when_server_returns_tm_error(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		Vault_CI_Node::$http_call = static function ( string $url, array $args ): array {
			$reply = Message::new_message();
			$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_ERROR;
			$reply[ Message::VALUE ] = [ 'name' => 'get', 'payload' => 'boom' ];
			return [ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];
		};

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'TM_ERROR', $out );
	}

	public function test_test_verb_errors_on_malformed_command_response(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		Vault_CI_Node::$http_call = static function ( string $url, array $args ): array {
			$reply = Message::new_message();
			$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
			$reply[ Message::VALUE ] = [ 'name' => 'get' ]; // no `payload` key.
			return [ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];
		};

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'malformed command response', $out );
	}

	public function test_test_verb_errors_on_non_array_payload(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		Vault_CI_Node::$http_call = static function ( string $url, array $args ): array {
			$reply = Message::new_message();
			$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
			$reply[ Message::VALUE ] = [ 'name' => 'get', 'payload' => 'not-an-array' ];
			return [ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];
		};

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsString( $out );
		// Message generalized when the POST+parse moved to Service_CI_Node::probe_command().
		$this->assertStringContainsString( 'non-array command payload', $out );
	}

	public function test_test_verb_whitelists_hooks_events_and_lag(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		Vault_CI_Node::$http_call = static function ( string $url, array $args ): array {
			$reply = Message::new_message();
			$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
			$reply[ Message::VALUE ] = [
				'name'    => 'get',
				'payload' => [
					'registered_hooks' => [ 'hook_a', 42, 'hook_b' ], // non-strings filtered out.
					'custom_events'    => [ 'evt_a' ],
					'lag'              => '12',                        // coerced to int.
					'secret'           => 'should-not-surface',       // not whitelisted.
				],
			];
			return [ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];
		};

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsArray( $out );
		$this->assertSame( [ 'hook_a', 'hook_b' ], $out['response']['registered_hooks'] );
		$this->assertSame( [ 'evt_a' ], $out['response']['custom_events'] );
		$this->assertSame( 12, $out['response']['lag'] );
		$this->assertArrayNotHasKey( 'secret', $out['response'] );
	}

	// ---------------------------------------------------------------------
	// schema
	// ---------------------------------------------------------------------

	public function test_node_schema_lists_verbs_without_logs_arg(): void {
		$verbs = [];
		foreach ( Vault_CI_Node::node_schema()['commands'] as $verb ) {
			$verbs[ $verb['name'] ] = $verb;
		}
		foreach ( [ 'list', 'get', 'add', 'update', 'delete', 'test' ] as $name ) {
			$this->assertArrayHasKey( $name, $verbs );
			$this->assertIsCallable( $verbs[ $name ]['handler'] );
		}
		foreach ( [ 'add', 'update' ] as $name ) {
			$arg_names = \array_map( static fn ( array $a ): string => $a['name'], $verbs[ $name ]['args'] );
			$this->assertNotContains( 'logs', $arg_names, "'{$name}' must not declare a logs arg" );
			$this->assertNotContains( 'enabled', $arg_names, "'{$name}' must not declare an enabled arg" );
		}
	}
}
