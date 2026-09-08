<?php
/**
 * VaultCINodeTest: unit tests for Vault_CI, the substrate `vault` service CI
 * ported from event-logger-nodes' Servers_CI.
 *
 * Six verbs proxy the substrate Vault credential store: list, get, add,
 * update, delete, test. Asserts the public credential-stripped shape (no
 * `logs`, no credentials), the manage_options auth gate on the four mutating
 * verbs, the decoupled `newspack_nodes/vault/changed` action firing on
 * mutations, and the `/command` status probe wire shape via the static
 * `$http_call` closure seam.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit\Rest;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Rest\Vault_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Vault;

#[CoversClass( Vault_CI_Node::class )]
class VaultCINodeTest extends TestCase {

	/** Session ids this file seeds; tearDown drops them so they can't leak. */
	private const SEEDED_SESSIONS = [ 'ghost', 'spoke1' ];

	protected function setUp(): void {
		parent::setUp();
		// A probe now requires a live session for its destination; seed the ids
		// this file probes so the $http_call stubs answer only the /command leg.
		foreach ( self::SEEDED_SESSIONS as $spoke ) {
			Command_Auth::remember_session( $spoke, \str_repeat( '3', 32 ), 'probe-session-key' );
		}
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		$GLOBALS['_wp_actions']               = [];
		\delete_option( Vault::OPTION_KEY );
		Vault::get_instance()->reset_cache();
		HTTP_Out_Node::$http_call = null;
	}

	protected function tearDown(): void {
		foreach ( self::SEEDED_SESSIONS as $spoke ) {
			Command_Auth::forget_session( $spoke );
		}
		VerbHarness::reset();
		$GLOBALS['_wp_options']               = [];
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		\delete_option( Vault::OPTION_KEY );
		Vault::get_instance()->reset_cache();
		HTTP_Out_Node::$http_call = null;
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
		// The username is not a secret, and an edit form has to show it.
		$this->assertSame( 'u', $out['spoke1']['auth_username'] );
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
	// --user / --password — the operator-facing option spellings, translated
	// onto the stored auth_username / auth_password keys.
	// ---------------------------------------------------------------------

	public function test_add_stores_user_and_password_options_under_the_auth_keys(): void {
		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'add',
			'vault-new-2207 --url=https://added.example --user=vault-user-2207 --password=vault-pw-5541'
		);

		$this->assertIsArray( $out );
		$this->assertSame( 'vault-new-2207', $out['id'] );
		Vault::get_instance()->reset_cache();
		$stored = Vault::get_instance()->get( 'vault-new-2207' );
		$this->assertSame( 'vault-user-2207', $stored['auth_username'] );
		$this->assertSame( 'vault-pw-5541', $stored['auth_password'] );
	}

	public function test_update_stores_user_and_password_options_under_the_auth_keys(): void {
		Vault::get_instance()->add( 'vault-edit-2207', [
			'url'           => 'https://before.example',
			'auth_username' => 'vault-user-3390',
			'auth_password' => 'vault-pw-3390',
		] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'update',
			'vault-edit-2207 --user=vault-user-5541 --password=vault-pw-7716'
		);

		$this->assertIsArray( $out );
		Vault::get_instance()->reset_cache();
		$stored = Vault::get_instance()->get( 'vault-edit-2207' );
		$this->assertSame( 'vault-user-5541', $stored['auth_username'] );
		$this->assertSame( 'vault-pw-7716', $stored['auth_password'] );
	}

	public function test_update_keeps_the_stored_password_when_no_password_option_rides(): void {
		Vault::get_instance()->add( 'vault-keep-2207', [
			'url'           => 'https://before.example',
			'auth_username' => 'vault-user-3390',
			'auth_password' => 'vault-pw-3390',
		] );
		Vault::get_instance()->reset_cache();

		VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'update',
			'vault-keep-2207 --url=https://after.example --user=vault-user-5541'
		);

		Vault::get_instance()->reset_cache();
		$stored = Vault::get_instance()->get( 'vault-keep-2207' );
		$this->assertSame( 'https://after.example', $stored['url'] );
		$this->assertSame( 'vault-user-5541', $stored['auth_username'] );
		$this->assertSame( 'vault-pw-3390', $stored['auth_password'] );
	}

	public function test_update_clears_the_stored_password_when_the_option_is_blank(): void {
		Vault::get_instance()->add( 'vault-clear-2207', [
			'url'           => 'https://before.example',
			'auth_username' => 'vault-user-3390',
			'auth_password' => 'vault-pw-3390',
		] );
		Vault::get_instance()->reset_cache();

		VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'update',
			[ 'vault-clear-2207', '--password=' ]
		);

		Vault::get_instance()->reset_cache();
		$stored = Vault::get_instance()->get( 'vault-clear-2207' );
		$this->assertSame( '', $stored['auth_password'] );
		$this->assertSame( 'vault-user-3390', $stored['auth_username'] );
	}

	// ---------------------------------------------------------------------
	// An option the verb does not read is refused, because both writers read
	// an absent option as an intention: `add` stores a blank field and reports
	// the id, `update` leaves the stored one alone and reports a save.
	// ---------------------------------------------------------------------

	public function test_add_refuses_an_option_it_does_not_read(): void {
		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'add',
			'vault-unknown-8814 --url=https://unknown.example --credential=vault-pw-9930'
		);

		Vault::get_instance()->reset_cache();
		$this->assertNull(
			Vault::get_instance()->get( 'vault-unknown-8814' ),
			'a refused add stores nothing: an unread option otherwise registers a spoke with empty credentials'
		);
		$this->assertIsString( $out, 'an unread option is a refusal, not a stored entry' );
		$this->assertStringContainsString( 'unknown option --credential', $out );
		$this->assertStringContainsString( 'this verb takes --url, --user, --password', $out );
	}

	public function test_update_refuses_an_option_it_does_not_read(): void {
		Vault::get_instance()->add( 'vault-unknown-6650', [
			'url'           => 'https://before.example',
			'auth_username' => 'vault-user-6650',
			'auth_password' => 'vault-pw-6650',
		] );
		Vault::get_instance()->reset_cache();

		// `auth_password` is the stored KEY, not an option this verb reads —
		// one instance of the general rule, and the shape a stale script sends.
		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'update',
			'vault-unknown-6650 --auth_password=vault-pw-7742'
		);

		$this->assertIsString( $out, 'an unread option is a refusal, not a save that changed nothing' );
		$this->assertStringContainsString( 'unknown option --auth_password', $out );
		$this->assertStringContainsString( 'this verb takes --new_id, --url, --user, --password', $out );
		Vault::get_instance()->reset_cache();
		$stored = Vault::get_instance()->get( 'vault-unknown-6650' );
		$this->assertSame( 'vault-pw-6650', $stored['auth_password'], 'a refused update leaves the stored credential alone' );
	}

	public function test_update_accepts_the_options_it_reads(): void {
		Vault::get_instance()->add( 'vault-known-3308', [ 'url' => 'https://before.example' ] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'update',
			'vault-known-3308 --new_id=vault-known-9971 --url=https://after.example --user=vault-user-9971 --password=vault-pw-9971'
		);

		$this->assertIsArray( $out, 'the id is positional and the four named options all pass' );
		$this->assertSame( 'vault-known-9971', $out['id'] );
	}

	// ---------------------------------------------------------------------
	// A valueless option is refused too. `Command_Args::parse()` reads a bare
	// `--key` as boolean true, and every option these two verbs read carries a
	// value — so a shell that ate the value, or an operator who forgot it,
	// otherwise casts to the literal '1' and stores it as the credential.
	// ---------------------------------------------------------------------

	public function test_add_refuses_a_valueless_password(): void {
		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'add',
			[ 'vault-bare-4409', '--url=https://bare.example', '--password' ]
		);

		Vault::get_instance()->reset_cache();
		$stored = Vault::get_instance()->get( 'vault-bare-4409' );
		$this->assertSame(
			'',
			$stored['auth_password'] ?? '',
			'a bare --password must not store the boolean true cast as the credential'
		);
		$this->assertNull( $stored, 'a refused add stores nothing at all' );
		$this->assertIsString( $out, 'a valueless option is a refusal, not a stored entry' );
		$this->assertStringContainsString( '--password needs a value', $out );
	}

	public function test_update_refuses_a_valueless_password(): void {
		Vault::get_instance()->add( 'vault-bare-6183', [
			'url'           => 'https://bare.example',
			'auth_username' => 'vault-user-6183',
			'auth_password' => 'vault-pw-6183',
		] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'update',
			[ 'vault-bare-6183', '--password' ]
		);

		Vault::get_instance()->reset_cache();
		$stored = Vault::get_instance()->get( 'vault-bare-6183' );
		$this->assertSame(
			'vault-pw-6183',
			$stored['auth_password'],
			'a bare --password must leave the stored credential alone, not overwrite it with the boolean cast'
		);
		$this->assertIsString( $out, 'a valueless option is a refusal, not a save' );
		$this->assertStringContainsString( '--password needs a value', $out );
	}

	public function test_update_refuses_a_valueless_new_id(): void {
		Vault::get_instance()->add( 'vault-bare-2764', [ 'url' => 'https://bare.example' ] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'update',
			[ 'vault-bare-2764', '--new_id' ]
		);

		$this->assertIsString( $out );
		// The option guard reaches it first, and says what is missing where
		// `invalid server id` only said the value was unusable.
		$this->assertStringContainsString( '--new_id needs a value', $out );
		Vault::get_instance()->reset_cache();
		$this->assertNotNull( Vault::get_instance()->get( 'vault-bare-2764' ), 'a refused rename moves nothing' );
	}

	// ---------------------------------------------------------------------
	// `add` reads the url as an OPTION, so an absent one is a missing option
	// and says so — `Vault::add()`'s generic refusal names the URL format,
	// which is the wrong cause when no url was sent at all.
	// ---------------------------------------------------------------------

	public function test_add_refuses_a_missing_url(): void {
		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'add',
			[ 'vault-nourl-8057' ]
		);

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'url required', $out );
		$this->assertStringNotContainsString(
			'check URL format',
			$out,
			'an absent --url is a missing option, not a malformed one'
		);
		Vault::get_instance()->reset_cache();
		$this->assertNull( Vault::get_instance()->get( 'vault-nourl-8057' ) );
	}

	// ---------------------------------------------------------------------
	// update --new_id — the id is an editable field, so an edit can rename.
	// ---------------------------------------------------------------------

	public function test_update_moves_the_entry_to_the_new_id(): void {
		Vault::get_instance()->add( 'vault-was-4471', [
			'url'           => 'https://before.example',
			'auth_username' => 'vault-user-4471',
			'auth_password' => 'vault-pw-8823',
		] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'update',
			'vault-was-4471 --new_id=vault-now-6612 --url=https://after.example'
		);

		$this->assertIsArray( $out );
		// The reply names the entry's identity NOW, which is what the table lists.
		$this->assertSame( 'vault-now-6612', $out['id'] );
		Vault::get_instance()->reset_cache();
		$this->assertNull( Vault::get_instance()->get( 'vault-was-4471' ) );
		$moved = Vault::get_instance()->get( 'vault-now-6612' );
		$this->assertSame( 'https://after.example', $moved['url'] );
		$this->assertSame( 'vault-pw-8823', $moved['auth_password'] );
	}

	public function test_update_announces_a_rename_once_naming_the_id_it_retired(): void {
		Vault::get_instance()->add( 'vault-was-4471', [ 'url' => 'https://before.example' ] );
		Vault::get_instance()->reset_cache();

		$captured = [];
		\add_action(
			'newspack_nodes/vault/changed',
			static function ( $id, $action, $previous ) use ( &$captured ) {
				$captured[] = \compact( 'id', 'action', 'previous' );
			},
			10,
			3
		);

		VerbHarness::fire( new Vault_CI_Node(), 'vault', 'update', 'vault-was-4471 --new_id=vault-now-6612' );

		// ONCE: two announcements are indistinguishable to a listener, and every
		// current one re-reads the whole vault, so the second only duplicates
		// the reload fan-out. The retired name rides as the third argument, for
		// a listener that genuinely keys by it.
		$this->assertSame(
			[
				[
					'id'       => 'vault-now-6612',
					'action'   => 'renamed',
					'previous' => 'vault-was-4471',
				],
			],
			$captured
		);
	}

	public function test_update_refuses_a_new_id_that_names_nothing(): void {
		Vault::get_instance()->add( 'vault-keep-7735', [ 'url' => 'https://before.example' ] );
		Vault::get_instance()->reset_cache();

		// Present and empty asks to move the entry to nothing, and swallowing
		// it reports a rename that never happened.
		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'update',
			[ 'vault-keep-7735', '--new_id=', '--url=https://after.example' ]
		);

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'invalid server id', $out );
		Vault::get_instance()->reset_cache();
		$this->assertSame( 'https://before.example', Vault::get_instance()->get( 'vault-keep-7735' )['url'] );
	}

	public function test_update_refuses_a_new_id_that_is_already_taken(): void {
		Vault::get_instance()->add( 'vault-from-3318', [ 'url' => 'https://from.example' ] );
		Vault::get_instance()->add( 'vault-onto-9074', [ 'url' => 'https://onto.example' ] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'update', 'vault-from-3318 --new_id=vault-onto-9074' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'vault-onto-9074', $out );
		Vault::get_instance()->reset_cache();
		$this->assertSame( 'https://from.example', Vault::get_instance()->get( 'vault-from-3318' )['url'] );
		$this->assertSame( 'https://onto.example', Vault::get_instance()->get( 'vault-onto-9074' )['url'] );
	}

	public function test_update_refuses_a_malformed_new_id(): void {
		Vault::get_instance()->add( 'vault-keep-7735', [ 'url' => 'https://before.example' ] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			'update',
			[ 'vault-keep-7735', '--new_id=not a valid id!', '--url=https://after.example' ]
		);

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'invalid server id', $out );
		Vault::get_instance()->reset_cache();
		$this->assertSame( 'https://before.example', Vault::get_instance()->get( 'vault-keep-7735' )['url'] );
	}

	public function test_update_names_the_config_file_as_the_reason_it_refuses(): void {
		$ref = new \ReflectionProperty( \Newspack_Nodes\Config::class, 'config_defaults' );
		$ref->setValue( null, [ 'vault' => [ 'vault-cfg-5528' => [ 'url' => 'https://pinned.example' ] ] ] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'update', 'vault-cfg-5528 --url=https://after.example' );

		$ref->setValue( null, null );
		\Newspack_Nodes\Config::reset();
		$this->assertIsString( $out );
		// "update failed" leaves the operator guessing; name the config file.
		$this->assertStringContainsString( 'config file', $out );
	}

	// ---------------------------------------------------------------------
	// test verb — status.get probe through the /command endpoint.
	// ---------------------------------------------------------------------

	public function test_test_verb_posts_status_get_command(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Vault::get_instance()->reset_cache();

		$seen                     = [];
		HTTP_Out_Node::$http_call = static function ( string $url, array $args ) use ( &$seen ): array {
			$seen  = [ 'url' => $url, 'body' => $args['body'], 'headers' => $args['headers'] ];
			$reply = Message::new_message();
			$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
			$reply[ Message::VALUE ] = [ 'name' => 'get', 'payload' => [ 'version' => '9.9.9-probe' ] ];
			return [ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];
		};

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsArray( $out );
		$this->assertSame( 'spoke1', $out['id'] );
		$this->assertSame( 'connected', $out['status'] );
		$this->assertSame( 'https://e.com/wp-json/newspack-nodes/v1/command', $seen['url'] );
		$this->assertSame( 'text/plain; charset=UTF-8', $seen['headers']['Content-Type'] );
		$this->assertStringStartsWith( 'Basic ', $seen['headers']['Authorization'] );

		$decoded = Message::unpacked( $seen['body'] );
		$this->assertSame( Message::TM_COMMAND, $decoded[ Message::TYPE ] );
		$this->assertSame( \Newspack_Nodes\Node_Names::HTTP, $decoded[ Message::FROM ] );
		$this->assertSame( 'status', $decoded[ Message::TO ] );
		$this->assertSame( 'get', $decoded[ Message::VALUE ]['name'] );
	}

	public function test_test_verb_extracts_reply_from_stderr_polluted_stream(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Vault::get_instance()->reset_cache();

		// The spoke's /command response is a JSONL message STREAM: diagnostic
		// stderr lines (TM_BYTESTREAM, string VALUE) can precede the command
		// reply. probe_remote must find the reply, not choke on line one.
		HTTP_Out_Node::$http_call = static function ( string $url, array $args ): array {
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
	}

	public function test_test_verb_returns_error_on_non_200(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();

		HTTP_Out_Node::$http_call = static fn ( string $url, array $args ): array =>
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
		// Both mutating verbs name the config file; a bare "delete failed" left
		// the operator guessing at the one cause they cannot fix from here.
		$this->assertStringContainsString( 'config file', $out );
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
	}

	public function test_test_verb_errors_when_transport_returns_wp_error(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		HTTP_Out_Node::$http_call = static fn ( string $url, array $args ): \WP_Error =>
			new \WP_Error( 'http_request_failed', 'down' );

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'could not connect', $out );
	}

	public function test_test_verb_errors_on_malformed_envelope(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		HTTP_Out_Node::$http_call = static fn ( string $url, array $args ): array =>
			[ 'response' => [ 'code' => 200 ], 'body' => '"just-a-string"' ];

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'malformed command envelope', $out );
	}

	public function test_test_verb_errors_when_server_returns_tm_error(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		HTTP_Out_Node::$http_call = static function ( string $url, array $args ): array {
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
		HTTP_Out_Node::$http_call = static function ( string $url, array $args ): array {
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
		HTTP_Out_Node::$http_call = static function ( string $url, array $args ): array {
			$reply = Message::new_message();
			$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
			$reply[ Message::VALUE ] = [ 'name' => 'get', 'payload' => 'not-an-array' ];
			return [ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];
		};

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsString( $out );
		// Message generalized when the POST+parse moved to HTTP_Out_Node::probe_command().
		$this->assertStringContainsString( 'non-array command payload', $out );
	}

	public function test_test_verb_answers_a_verdict_and_forwards_no_spoke_fields(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();
		HTTP_Out_Node::$http_call = static function ( string $url, array $args ): array {
			$reply = Message::new_message();
			$reply[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
			$reply[ Message::VALUE ] = [
				'name'    => 'get',
				'payload' => [
					'registered_hooks' => [ 'wp_footer_zeta', 'save_post_zeta' ],
					'custom_events'    => [ 'newspack_zeta_event' ],
					'lag'              => 8675309,
					'version'          => '9.9.9-probe',
				],
			];
			return [ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];
		};

		$out = VerbHarness::fire( new Vault_CI_Node(), 'vault', 'test', 'spoke1' );

		$this->assertIsArray( $out );
		// Exact key set: a future whitelist cannot creep a spoke's payload back in.
		$this->assertSame( [ 'id', 'status' ], \array_keys( $out ) );
		$this->assertSame( 'spoke1', $out['id'] );
		$this->assertSame( 'connected', $out['status'] );
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

	public function test_add_and_update_declare_the_credentials_as_user_and_password(): void {
		$verbs = [];
		foreach ( Vault_CI_Node::node_schema()['commands'] as $verb ) {
			$verbs[ $verb['name'] ] = $verb;
		}
		foreach ( [ 'add', 'update' ] as $name ) {
			$arg_names = \array_map( static fn ( array $a ): string => $a['name'], $verbs[ $name ]['args'] );
			$this->assertContains( 'user', $arg_names, "'{$name}' must declare a user arg" );
			$this->assertContains( 'password', $arg_names, "'{$name}' must declare a password arg" );
			$this->assertNotContains( 'auth_username', $arg_names, "'{$name}' must not declare auth_username" );
			$this->assertNotContains( 'auth_password', $arg_names, "'{$name}' must not declare auth_password" );
		}
	}

	public function test_declared_options_are_exactly_the_options_each_verb_accepts(): void {
		$verbs = [];
		foreach ( Vault_CI_Node::node_schema()['commands'] as $verb ) {
			$verbs[ $verb['name'] ] = $verb;
		}
		foreach ( [ 'add' => 'vault-bind-1926', 'update' => 'vault-bind-3547' ] as $name => $id ) {
			// Per the one command grammar, a required arg rides POSITIONALLY;
			// everything else is a `--key=value` the handler has to read.
			$declared = [];
			foreach ( $verbs[ $name ]['args'] as $arg ) {
				if ( empty( $arg['required'] ) ) {
					$declared[] = $arg['name'];
				}
			}
			$accepted = $this->accepted_options( $name, $id );
			\sort( $declared );
			\sort( $accepted );
			$this->assertSame(
				$accepted,
				$declared,
				"'{$name}' must declare as an option exactly what it accepts as one: a declared "
					. 'positional the handler reads off --key is never sent, and an arg the guard '
					. 'does not accept is offered by help and the palette and then refused'
			);
		}
	}

	/**
	 * The option names a verb ACCEPTS, read out of its own refusal — firing an
	 * option no verb reads makes `assert_known_options()` name the set it takes.
	 *
	 * @param string $verb Verb name.
	 * @param string $id   Positional id; the guard runs ahead of every lookup.
	 * @return list<string> Accepted option names.
	 */
	private function accepted_options( string $verb, string $id ): array {
		// Each fire() builds a whole request-scope graph, so the previous one's
		// `_router` has to go before the second verb is asked.
		VerbHarness::reset();
		$out = VerbHarness::fire(
			new Vault_CI_Node(),
			'vault',
			$verb,
			[ $id, '--vault-not-an-option-1926=x' ]
		);

		$this->assertIsString( $out, "'{$verb}' must refuse an option it does not read" );
		$this->assertSame( 1, \preg_match( '/this verb takes --(.+)$/', $out, $m ) );
		return \explode( ', --', $m[1] );
	}
}
