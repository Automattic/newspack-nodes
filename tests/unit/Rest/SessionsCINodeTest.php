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
		$this->assertSame( $created['key'], ( Command_Auth::load_session_record( $created['handle'] )['key'] ?? null ) );

		$listed = $this->fire( 'list' )['sessions'];
		$this->assertCount( 1, $listed );
		$this->assertSame( 'reporting bot', $listed[0]['label'] );
		$this->assertSame( Capabilities::TUNE, $listed[0]['scope'] );
		$this->assertTrue( $listed[0]['live'] );
		$this->assertArrayNotHasKey( 'key', $listed[0], 'the listing must never carry the key' );
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

	public function test_revoke_kills_the_key_and_delists_it(): void {
		$created = $this->fire( 'create', [ 'doomed', '--scope=read' ] );

		$result = $this->fire( 'revoke', [ $created['handle'] ] );

		$this->assertTrue( $result['revoked'] );
		$this->assertSame( [], $this->fire( 'list' )['sessions'] );
		$this->assertNull( ( Command_Auth::load_session_record( $created['handle'] )['key'] ?? null ) );
	}

	public function test_revoke_requires_a_handle(): void {
		$this->assertStringContainsString( 'handle required', (string) $this->fire( 'revoke' ) );
	}

	/** Handing out access is `manage`, for the same reason the vault is. */
	public function test_every_verb_is_manage(): void {
		foreach ( Sessions_CI_Node::node_schema()['commands'] as $verb ) {
			$this->assertSame( Capabilities::MANAGE, $verb['capability'] ?? Capabilities::MANAGE );
		}
	}
}
