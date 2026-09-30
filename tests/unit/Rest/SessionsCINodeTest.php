<?php
namespace Newspack_Nodes\Tests\Unit\Rest;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Rest\Sessions_CI_Node;
use Newspack_Nodes\Sessions;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;

/**
 * The Sessions service CI: Vault's mirror. Vault holds credentials this site
 * sends OUT; this lists, issues and revokes the ones it hands to callers
 * coming IN.
 */
#[CoversClass( Sessions_CI_Node::class )]
class SessionsCINodeTest extends TestCase {

	private ?\Memcached $prev_memd = null;
	private ?\Memcached $memd      = null;

	protected function setUp(): void {
		parent::setUp();
		$this->use_wpdb();
		$this->prev_memd                      = Core::$memd;
		$this->memd                           = new InMemoryMemcached();
		Core::$memd                           = $this->memd;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
	}

	protected function tearDown(): void {
		VerbHarness::reset();
		\delete_option( Sessions::OPTION );
		Cache_Backend::$apcu_usable           = static fn (): bool => false;
		$GLOBALS['_wp_test_current_user_can'] = [];
		Core::$memd                           = $this->prev_memd;
		parent::tearDown();
	}

	/**
	 * Each fire builds a fresh request-scope graph, so reset between them —
	 * and re-seat the memcached double, which Core::reset() clears.
	 */
	private function fire( string $verb, $args = [] ) {
		VerbHarness::reset();
		Core::$memd = $this->memd;
		return VerbHarness::fire( new Sessions_CI_Node(), 'sessions', $verb, $args );
	}

	public function test_list_is_empty_before_anything_is_issued(): void {
		$this->assertSame( [], $this->fire( 'list' )['sessions'] );
	}

	public function test_create_issues_a_scoped_session_and_discloses_the_key_once(): void {
		$created = $this->fire( 'create', [ 'reporting bot', '--scope=tune', '--ttl=900' ] );

		$this->assertIsArray( $created, \is_string( $created ) ? $created : '' );
		$this->assertSame( Capabilities::TUNE, $created['scope'] );
		$this->assertSame( 900, $created['expires_in'] );
		$this->assertSame( $created['secret'], ( Command_Auth::load_session_record( $created['handle'] )['key'] ?? null ) );

		$listed = $this->fire( 'list' )['sessions'];
		$this->assertCount( 1, $listed );
		$this->assertSame( 'reporting bot', $listed[0]['label'] );
		$this->assertSame( Capabilities::TUNE, $listed[0]['scope'] );
		$this->assertTrue( $listed[0]['live'] );
		$this->assertArrayNotHasKey( 'secret', $listed[0], 'the listing must never carry the credential' );
	}

	/**
	 * A credential lifetime is the last thing that may be guessed at: `--ttl=1h`
	 * would mint a default-lifetime key and report success.
	 */
	public function test_create_refuses_a_malformed_ttl_rather_than_issuing_a_default_key(): void {
		$result = $this->fire( 'create', [ 'typo bot', '--ttl=1h' ] );

		$this->assertIsString( $result, 'a malformed --ttl must not mint a session' );
		$this->assertStringContainsString( 'ttl', $result );
		$this->assertSame( [], $this->fire( 'list' )['sessions'] );
	}

	public function test_create_clamps_the_scope_to_the_minting_user(): void {
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'manage' => 'edit_pages', 'tune' => 'edit_pages', 'read' => 'edit_pages' ] + $map
		);
		$GLOBALS['_wp_test_current_user_can'] = [ 'edit_pages' => true, 'manage_options' => false ];

		$created = $this->fire( 'create', [ 'clamped', '--scope=manage' ] );
		$this->assertSame( Capabilities::MANAGE, $created['scope'] );
	}

	public function test_create_refuses_an_unknown_scope(): void {
		$this->assertStringContainsString(
			'unknown session scope',
			(string) $this->fire( 'create', [ 'bad', '--scope=wizard' ] )
		);
	}

	public function test_create_reports_a_store_outage_as_a_refusal_naming_the_cause(): void {
		$GLOBALS['wpdb']->deny['INSERT IGNORE'] = 'Deadlock found 1264';

		$reply = (string) $this->fire( 'create', [ 'outage-1264' ] );

		$this->assertStringContainsString( 'could not store the session', $reply );
		$this->assertStringContainsString( 'Deadlock found 1264', $reply );
	}

	public function test_revoke_kills_the_key_and_delists_it(): void {
		$created = $this->fire( 'create', [ 'doomed', '--scope=read' ] );

		$result = $this->fire( 'revoke', [ $created['handle'] ] );

		$this->assertTrue( $result['revoked'] );
		$this->assertSame( [], $this->fire( 'list' )['sessions'] );
		$this->assertNull( ( Command_Auth::load_session_record( $created['handle'] )['key'] ?? null ) );
	}

	public function test_revoke_requires_a_handle(): void {
		$this->assertSame( "missing required argument: handle\n", $this->fire( 'revoke' ) );
	}

	/**
	 * The schema orders `label scope ttl`, so the positional form binds exactly
	 * what the named form does, rather than reading scope and ttl from options
	 * alone and minting `manage` for an hour.
	 */
	public function test_create_binds_scope_and_ttl_by_position_as_it_does_by_name(): void {
		$positional = $this->fire( 'create', [ 'chris-claude', 'tune', '86400' ] );
		$named      = $this->fire( 'create', [ 'chris-claude', '--scope=tune', '--ttl=86400' ] );

		foreach ( [ $positional, $named ] as $created ) {
			$this->assertIsArray( $created, \is_string( $created ) ? $created : '' );
			$this->assertSame( Capabilities::TUNE, $created['scope'] );
			$this->assertSame( 86400, $created['expires_in'] );
			$this->assertSame( 'chris-claude', $created['label'] );
		}
	}

	/** Nothing was revoked, so nothing may answer `revoked: true`. */
	public function test_revoke_refuses_a_handle_no_session_holds(): void {
		$this->fire( 'create', [ 'bystander-5521', '--scope=read' ] );

		$this->assertSame( "no session with handle nsh-absent-5521\n", $this->fire( 'revoke', [ 'nsh-absent-5521' ] ) );
		$this->assertCount( 1, $this->fire( 'list' )['sessions'], 'a refused revoke touches no other session' );
	}

	/** An operator reading the tab types the LABEL; the refusal names its handles. */
	public function test_revoke_of_a_label_names_the_handles_carrying_it(): void {
		$first  = $this->fire( 'create', [ 'kaka-5521', '--scope=read' ] );
		$second = $this->fire( 'create', [ 'kaka-5521', '--scope=tune' ] );

		$reply = $this->fire( 'revoke', [ 'kaka-5521' ] );

		$this->assertIsString( $reply );
		$this->assertStringStartsWith( 'no session with handle kaka-5521; the label kaka-5521 names ', $reply );
		$this->assertStringContainsString( $first['handle'], $reply );
		$this->assertStringContainsString( $second['handle'], $reply );
		$this->assertCount( 2, $this->fire( 'list' )['sessions'], 'naming a label revokes nothing' );
	}

	/** A store that did not answer leaves the key live, so nothing may say gone. */
	public function test_revoke_refuses_when_the_store_does_not_answer(): void {
		$created = $this->fire( 'create', [ 'tui-6204' ] );
		$GLOBALS['wpdb']->deny['DELETE FROM `wp_newspack_nodes_table`'] = 'Lock wait timeout 6204';

		$this->assertSame( "session store did not answer; {$created['handle']} may still be live\n", $this->fire( 'revoke', [ $created['handle'] ] ) );
		$this->assertCount( 1, $this->fire( 'list' )['sessions'], 'the listing keeps a key the store may still hold' );
	}

	/**
	 * Binding runs before the verb's MANAGE check, so a READ caller with a
	 * malformed command hears the binding refusal; it names only declared args.
	 */
	public function test_a_read_caller_with_malformed_args_hears_the_binding_refusal_first(): void {
		add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [ 'read' => 'read_6204', 'tune' => 'tune_6204', 'manage' => 'manage_6204' ] + $map
		);
		$GLOBALS['_wp_test_current_user_can'] = [ 'read_6204' => true ];

		$this->assertSame( "too many arguments: 2 given, 1 accepted\n", $this->fire( 'revoke', [ 'nsh-6204', 'nsh-extra-6204' ] ) );
		$this->assertStringContainsString( 'permission denied', (string) $this->fire( 'revoke', [ 'nsh-6204' ] ) );
	}

	/** A key whose directory row is gone still has a lease to drop, and says so. */
	public function test_revoke_of_an_unlisted_live_lease_reports_it_revoked(): void {
		$created = $this->fire( 'create', [ 'ruru-5521' ] );
		\delete_option( Sessions::OPTION );

		$result = $this->fire( 'revoke', [ $created['handle'] ] );

		$this->assertSame( [ 'handle' => $created['handle'], 'revoked' => true ], $result );
		$this->assertNull( Command_Auth::load_session_record( $created['handle'] ) );
	}

	/** Handing out access is `manage`, for the same reason the vault is. */
	public function test_every_verb_is_manage(): void {
		foreach ( Sessions_CI_Node::node_schema()['commands'] as $verb ) {
			$this->assertSame( Capabilities::MANAGE, $verb['capability'] ?? Capabilities::MANAGE );
		}
	}
}
