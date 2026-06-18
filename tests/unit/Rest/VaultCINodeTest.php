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
		parent::tearDown();
	}

	// ---------------------------------------------------------------------
	// list / get — credential-stripped public shape, no `logs`.
	// ---------------------------------------------------------------------

	public function test_list_strips_credentials_and_has_no_logs(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com', 'auth_username' => 'u', 'auth_password' => 'p', 'enabled' => true ] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'list' );

		$this->assertIsArray( $out );
		$this->assertArrayHasKey( 'spoke1', $out );
		$this->assertTrue( $out['spoke1']['has_credentials'] );
		$this->assertSame( 'https://e.com', $out['spoke1']['url'] );
		$this->assertArrayNotHasKey( 'auth_password', $out['spoke1'] );
		$this->assertArrayNotHasKey( 'auth_username', $out['spoke1'] );
		$this->assertArrayNotHasKey( 'logs', $out['spoke1'] );
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
			static function ( $id, $action, $was, $now ) use ( &$captured ) {
				$captured = \compact( 'id', 'action', 'was', 'now' );
			},
			10,
			4
		);

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'add', 'spoke1 --url=https://e.com --enabled=true' );

		$this->assertIsArray( $out );
		$this->assertSame( 'spoke1', $out['id'] );
		$this->assertSame( 'spoke1', $captured['id'] );
		$this->assertSame( 'added', $captured['action'] );
		$this->assertFalse( $captured['was'] );
		$this->assertTrue( $captured['now'] );
	}

	public function test_add_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => false ];

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'add', 'spoke1 --url=https://e.com' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'permission denied', $out );
		Vault::get_instance()->reset_cache();
		$this->assertNull( Vault::get_instance()->get( 'spoke1' ) );
	}

	public function test_update_fires_changed_action_with_enable_flip(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com', 'enabled' => false ] );
		Vault::get_instance()->reset_cache();

		$captured = [];
		\add_action(
			'newspack_nodes/vault/changed',
			static function ( $id, $action, $was, $now ) use ( &$captured ) {
				$captured = \compact( 'id', 'action', 'was', 'now' );
			},
			10,
			4
		);

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'update', 'spoke1 --enabled=true' );

		$this->assertIsArray( $out );
		$this->assertSame( 'updated', $captured['action'] );
		$this->assertFalse( $captured['was'] );
		$this->assertTrue( $captured['now'] );
	}

	public function test_delete_fires_changed_action(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();

		$captured = [];
		\add_action(
			'newspack_nodes/vault/changed',
			static function ( $id, $action, $was, $now ) use ( &$captured ) {
				$captured = \compact( 'id', 'action', 'was', 'now' );
			},
			10,
			4
		);

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'delete', 'spoke1' );

		$this->assertIsArray( $out );
		$this->assertSame( 'spoke1', $out['id'] );
		$this->assertSame( 'removed', $captured['action'] );
		$this->assertTrue( $captured['was'] );
		$this->assertFalse( $captured['now'] );
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
		}
	}
}
