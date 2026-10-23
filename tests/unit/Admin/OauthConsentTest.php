<?php
namespace Newspack_Nodes\Tests\Unit\Admin;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Admin\Oauth_Consent;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Core;
use Newspack_Nodes\Oauth_Server;
use Newspack_Nodes\Oauth_Store;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\Helpers\RedirectException;
use Newspack_Nodes\Tests\Helpers\Sqlite_Wpdb;
use Newspack_Nodes\Tests\TestCase;

/**
 * The approval page: what it shows for an authorization request, what it
 * refuses to show, and where a decision sends the browser.
 */
#[CoversClass( Oauth_Consent::class )]
final class OauthConsentTest extends TestCase {

	private const T0 = 1790030000;

	private const HOME = 'https://kea.example';

	private const RESOURCE = 'https://kea.example/wp-json/kea-logger/v1/mcp';

	private const KEA_DESK = 'https://kea-desk.example/cb';

	private const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';

	private const LOOPBACK = 'http://127.0.0.1:4410/callback';

	private const USER = 7746;

	private const NONCE = 'kea-nonce-4410';

	private const STATE = 'kea-state-4410';

	private const WARNING = 'This connection sends its credential to kea-desk.example, which is not Claude.';

	/** What each scope of `Oauth_Store::SCOPES` is called on the page. */
	private const LABELS = [
		Capabilities::READ => '<code>read</code> See the dashboards and the logged traffic; change nothing.',
		Capabilities::TUNE => '<code>tune</code> See the dashboards and the logged traffic; change settings and application data.',
	];

	private Sqlite_Wpdb $db;

	private string $client;

	protected function setUp(): void {
		parent::setUp();
		$this->db                                  = $this->use_wpdb_sessions();
		Core::$memd                                = new InMemoryMemcached();
		Core::$clock                               = static fn (): float => (float) self::T0;
		$_SERVER['HTTPS']                          = 'on';
		$_GET                                      = [];
		$_POST                                     = [];
		$GLOBALS['_last_redirect']                 = null;
		$GLOBALS['_admin_submenu_pages']           = [];
		$GLOBALS['_enqueued_styles']               = [];
		$GLOBALS['_wp_test_home_url']              = self::HOME;
		$GLOBALS['_wp_test_blogname']              = 'Kea Gazette';
		$GLOBALS['_wp_test_current_user_id']       = self::USER;
		$GLOBALS['_wp_test_user_caps']             = [ self::USER => [ 'edit_others_posts' => true, 'edit_posts' => true ] ];
		$GLOBALS['_wp_test_valid_nonces']          = [ Oauth_Consent::DECIDE => self::NONCE ];
		\add_filter(
			'newspack_nodes/capability_map',
			static fn ( array $map ): array => [
				Capabilities::READ   => 'edit_posts',
				Capabilities::TUNE   => 'edit_others_posts',
				Capabilities::MANAGE => 'manage_options',
			] + $map
		);
		\add_filter( 'newspack_nodes/oauth_resources', static fn (): array => [ self::RESOURCE ] );
		$this->client = Oauth_Store::register_client( 'Kea Desk 4410', [ self::KEA_DESK, self::CLAUDE, self::LOOPBACK ] )['id'];
	}

	protected function tearDown(): void {
		unset( $_SERVER['HTTPS'], $GLOBALS['_wp_test_home_url'], $GLOBALS['_wp_test_blogname'], $GLOBALS['_wp_test_valid_nonces'], $GLOBALS['title'] );
		$_GET       = [];
		$_POST      = [];
		Core::$memd = null;
		parent::tearDown();
	}

	private static function challenge(): string {
		return \rtrim( \strtr( \base64_encode( \hash( 'sha256', 'kea-verifier-4410-ABCDEFGHIJKLMNOPQRSTUVWXYZ', true ) ), '+/', '-_' ), '=' );
	}

	/** @return array<string,mixed> An authorization request, with `$over` replacing its fields. */
	private function request( array $over = [] ): array {
		return $over + [
			'response_type'         => 'code',
			'client_id'             => $this->client,
			'redirect_uri'          => self::KEA_DESK,
			'code_challenge'        => self::challenge(),
			'code_challenge_method' => 'S256',
			'state'                 => self::STATE,
			'resource'              => self::RESOURCE,
		];
	}

	/** The page rendered for a GET carrying `$query`. */
	private static function page( array $query ): string {
		$_GET = $query;
		\ob_start();
		try {
			Oauth_Consent::render();
		} finally {
			$page = (string) \ob_get_clean();
		}
		return $page;
	}

	/**
	 * Post a decision.
	 *
	 * @return array{0:string,1:string} `[ 'redirect', <url> ]` or `[ 'die', <message> ]`.
	 */
	private static function decide( array $post ): array {
		$_POST = $post;
		try {
			Oauth_Consent::decide();
		} catch ( RedirectException $e ) {
			return [ 'redirect', $e->getMessage() ];
		} catch ( \RuntimeException $e ) {
			return [ 'die', $e->getMessage() ];
		}
	}

	/** A decision as the form posts it, with `$over` replacing its fields. */
	private function decision( array $over = [] ): array {
		return $over + $this->request() + [
			Oauth_Consent::NONCE => self::NONCE,
			'decision'           => 'approve',
			'scope'              => Capabilities::TUNE,
			'name'               => 'Tui laptop',
		];
	}

	/** @return array<string,string> A redirect URL's query. */
	private static function query_of( string $url ): array {
		\parse_str( (string) \parse_url( $url, \PHP_URL_QUERY ), $query );
		return $query;
	}

	private function assert_refused( string $page, string $why ): void {
		$this->assertStringContainsString( 'newspack-nodes-error-banner', $page );
		$this->assertStringContainsString( $why, $page );
		$this->assertStringNotContainsString( 'name="decision"', $page );
		$this->assertNull( $GLOBALS['_last_redirect'] );
	}

	public function test_an_unregistered_redirect_uri_is_shown_never_followed(): void {
		$elsewhere = 'https://kea-elsewhere.example/steal';

		$page = self::page( $this->request( [ 'redirect_uri' => $elsewhere ] ) );
		[ $kind, $said ] = self::decide( $this->decision( [ 'redirect_uri' => $elsewhere ] ) );

		$this->assert_refused( $page, $elsewhere );
		$this->assertStringNotContainsString( 'href="' . $elsewhere, $page );
		$this->assertSame( 'die', $kind );
		$this->assertStringContainsString( $elsewhere, $said );
		$this->assertNull( $GLOBALS['_last_redirect'] );
	}

	public function test_the_page_warns_when_the_host_is_not_claude(): void {
		$kea = self::page( $this->request() );

		$this->assertStringContainsString( self::WARNING, $kea );
		$this->assertStringContainsString( 'Kea Gazette', $kea );
		$this->assertStringContainsString( 'Kea Desk 4410', $kea );
		foreach ( [ self::CLAUDE => 'claude.ai', self::LOOPBACK => '127.0.0.1' ] as $uri => $host ) {
			$page = self::page( $this->request( [ 'redirect_uri' => $uri ] ) );
			$this->assertStringContainsString( $host, $page, $uri );
			$this->assertStringNotContainsString( 'which is not Claude', $page, $uri );
		}
	}

	public function test_the_form_carries_the_request_and_asks_for_a_name(): void {
		$page = self::page( $this->request( [ 'state' => 'kea"><b>4410' ] ) );

		$this->assertStringContainsString( 'value="kea&quot;&gt;&lt;b&gt;4410"', $page );
		$this->assertStringNotContainsString( '<b>4410', $page );
		$this->assertStringContainsString( 'value="' . Oauth_Consent::DECIDE . '"', $page );
		$this->assertStringContainsString( 'name="' . Oauth_Consent::NONCE . '" value="' . self::NONCE . '"', $page );
		$this->assertStringContainsString( 'value="' . self::KEA_DESK . '"', $page );
		$this->assertMatchesRegularExpression( '/<input[^>]+name="name"[^>]+required[^>]+maxlength="64"/', $page );
		$this->assertStringContainsString( 'action="http://localhost/wp-admin/admin-post.php"', $page );
		$this->assertStringContainsString( 'formnovalidate', $page );
	}

	public function test_approve_needs_the_nonce_and_a_name(): void {
		$missing = self::decide( \array_diff_key( $this->decision(), [ Oauth_Consent::NONCE => true ] ) );
		$wrong   = self::decide( $this->decision( [ Oauth_Consent::NONCE => 'kea-forged-4410' ] ) );

		$this->assertSame( 'die', $missing[0] );
		$this->assertSame( 'die', $wrong[0] );
		$this->assertNull( $GLOBALS['_last_redirect'] );

		[ $kind, $url ] = self::decide( $this->decision( [ 'name' => ' <b></b> ' ] ) );

		$this->assertSame( 'redirect', $kind );
		$this->assertStringStartsWith( Oauth_Server::authorization_endpoint(), $url );
		$query = self::query_of( $url );
		$this->assertArrayNotHasKey( 'code', $query );
		$this->assertSame( self::STATE, $query['state'] );
		$this->assertSame( self::KEA_DESK, $query['redirect_uri'] );

		$GLOBALS['_last_redirect'] = null;
		$page                      = self::page( $query );
		$this->assertStringContainsString( 'Name this connection before approving it.', $page );
		$this->assertStringContainsString( 'name="decision"', $page );
	}

	public function test_approve_redirects_with_a_code_bound_to_the_choices(): void {
		[ $kind, $url ] = self::decide( $this->decision( [ 'scope' => Capabilities::READ ] ) );

		$this->assertSame( 'redirect', $kind );
		$this->assertStringStartsWith( self::KEA_DESK . '?', $url );
		$query = self::query_of( $url );
		$this->assertSame( self::STATE, $query['state'] );
		$this->assertSame(
			[
				'client'       => $this->client,
				'redirect_uri' => self::KEA_DESK,
				'challenge'    => self::challenge(),
				'resource'     => self::RESOURCE,
				'user'         => self::USER,
				'scope'        => Capabilities::READ,
				'name'         => 'Tui laptop',
			],
			Oauth_Store::take_code( $query['code'] )
		);
	}

	public function test_deny_redirects_access_denied_with_the_state(): void {
		$denied = self::decide( $this->decision( [ 'decision' => 'deny', 'name' => '' ] ) );
		$silent = self::decide( \array_diff_key( $this->decision( [ 'redirect_uri' => self::LOOPBACK ] ), [ 'decision' => true ] ) );

		$this->assertSame( [ 'redirect', self::KEA_DESK . '?error=access_denied&state=' . self::STATE ], $denied );
		$this->assertSame( [ 'redirect', self::LOOPBACK . '?error=access_denied&state=' . self::STATE ], $silent );
	}

	public function test_a_user_who_holds_only_read_is_offered_only_read(): void {
		$GLOBALS['_wp_test_user_caps'] = [ self::USER => [ 'edit_posts' => true ] ];

		$page = self::page( $this->request() );
		[ $kind, $said ] = self::decide( $this->decision() );

		$this->assertMatchesRegularExpression( '/<input[^>]+value="read"[^>]+checked/', $page );
		$this->assertStringNotContainsString( 'value="tune"', $page );
		$this->assertSame( 'die', $kind );
		$this->assertStringContainsString( 'tune', $said );
		$this->assertNull( $GLOBALS['_last_redirect'] );
	}

	public function test_a_user_who_holds_both_is_offered_tune_first_and_checked(): void {
		$page = self::page( $this->request() );

		$this->assertMatchesRegularExpression( '/<input[^>]+value="tune"[^>]+checked/', $page );
		$this->assertMatchesRegularExpression( '/value="tune".*value="read"/s', $page );
		$this->assertDoesNotMatchRegularExpression( '/<input[^>]+value="read"[^>]+checked/', $page );
	}

	public function test_each_scope_renders_its_own_label_and_no_other(): void {
		$GLOBALS['_wp_test_user_caps'][ self::USER ]['manage_options'] = true;

		\preg_match_all( '/<label>\s*<input[^>]+value="([a-z]+)"[^>]*>\s*(.*?)\s*<\/label>/s', self::page( $this->request() ), $found, \PREG_SET_ORDER );
		$labels = \array_column( $found, 2, 1 );

		$this->assertSame( \array_reverse( Oauth_Store::SCOPES ), \array_keys( $labels ) );
		foreach ( Oauth_Store::SCOPES as $scope ) {
			$this->assertSame( self::LABELS[ $scope ], $labels[ $scope ], $scope );
		}
	}

	public function test_a_user_holding_tune_without_read_is_offered_only_tune(): void {
		\add_filter( 'newspack_nodes/capability_map', static fn ( array $map ): array => [ Capabilities::READ => 'kea_read_4410' ] + $map );

		$page = self::page( $this->request() );
		[ $kind ] = self::decide( $this->decision( [ 'scope' => Capabilities::READ ] ) );

		$this->assertMatchesRegularExpression( '/<input[^>]+value="tune"[^>]+checked/', $page );
		$this->assertStringNotContainsString( 'value="read"', $page );
		$this->assertSame( 'die', $kind );
	}

	public function test_a_value_the_form_cannot_carry_unchanged_is_refused(): void {
		foreach ( [ 'an entity' => 'kea&amp;4410', 'a line break' => "kea\n4410", 'invalid UTF-8' => "kea\xC3\x284410", 'a tab' => "kea\t4410" ] as $what => $state ) {
			$page = self::page( $this->request( [ 'state' => $state ] ) );
			[ $kind, $said ] = self::decide( $this->decision( [ 'state' => $state ] ) );

			$this->assert_refused( $page, 'The state cannot pass through this form unchanged.' );
			$this->assertSame( 'die', $kind, $what );
			$this->assertStringContainsString( 'The state cannot pass', $said, $what );
		}
		$this->assertStringContainsString( 'value="kea&amp;4410-ok"', self::page( $this->request( [ 'state' => 'kea&4410-ok' ] ) ) );
	}

	public function test_a_user_who_holds_neither_scope_is_refused(): void {
		$GLOBALS['_wp_test_user_caps'] = [ self::USER => [ 'read' => true ] ];

		$page = self::page( $this->request() );

		$this->assert_refused( $page, 'Your account can grant none of ' . \implode( ', ', Oauth_Store::SCOPES ) . ' on this site.' );
		$this->assertSame( 'die', self::decide( $this->decision() )[0] );
	}

	/** @return array<string,array{0:array<string,mixed>,1:string}> */
	public static function bad_requests(): array {
		return [
			'unknown client'    => [ [ 'client_id' => 'kea-unknown-4410' ], 'client_id' ],
			'a trailing slash'  => [ [ 'redirect_uri' => self::KEA_DESK . '/' ], self::KEA_DESK . '/' ],
			'another case'      => [ [ 'redirect_uri' => 'https://KEA-DESK.example/cb' ], 'https://KEA-DESK.example/cb' ],
			'an added query'    => [ [ 'redirect_uri' => self::KEA_DESK . '?x=1' ], self::KEA_DESK . '?x=1' ],
			'listed client'     => [ [ 'client_id' => [ 'kea' ] ], 'client_id' ],
			'implicit grant'    => [ [ 'response_type' => 'token' ], 'response_type' ],
			'plain challenge'   => [ [ 'code_challenge_method' => 'plain' ], 'S256' ],
			'no challenge'      => [ [ 'code_challenge' => '' ], 'code_challenge' ],
			'no state'          => [ [ 'state' => '' ], 'state' ],
			'another resource'  => [ [ 'resource' => 'https://kea.example/wp-json/kea-other/v1/mcp' ], 'https://kea.example/wp-json/kea-other/v1/mcp' ],
		];
	}

	#[DataProvider( 'bad_requests' )]
	public function test_every_parameter_is_checked_on_the_page_and_again_on_the_decision( array $over, string $why ): void {
		$this->assert_refused( self::page( $this->request( $over ) ), $why );

		[ $kind, $said ] = self::decide( $this->decision( $over ) );

		$this->assertSame( 'die', $kind );
		$this->assertStringContainsString( $why, $said );
	}

	public function test_plain_http_and_a_subsite_are_refused(): void {
		unset( $_SERVER['HTTPS'] );
		$this->assert_refused( self::page( $this->request() ), 'HTTPS' );
		$this->assertSame( 'die', self::decide( $this->decision() )[0] );

		$_SERVER['HTTPS']                 = 'on';
		$GLOBALS['_wp_test_is_multisite'] = true;
		$GLOBALS['_wp_test_is_main_site'] = false;
		$this->assert_refused( self::page( $this->request() ), 'subsite' );
		$this->assertSame( 'die', self::decide( $this->decision() )[0] );
	}

	public function test_a_store_that_does_not_answer_is_reported_never_followed(): void {
		$this->db->deny['INSERT IGNORE'] = 'Deadlock found 4410';
		[ $kind, $said ] = self::decide( $this->decision() );
		$this->db->deny = [];

		$this->assertSame( 'die', $kind );
		$this->assertStringContainsString( 'session store', $said );
		$this->assertStringNotContainsString( '4410', $said );

		$this->db->deny['SELECT'] = 'Lost connection 4410';
		$page = self::page( $this->request() );
		$this->db->deny = [];

		$this->assert_refused( $page, 'session store' );
	}

	public function test_register_adds_a_hidden_page_the_metadata_names(): void {
		Oauth_Consent::register();

		$page = $GLOBALS['_admin_submenu_pages'][ Oauth_Server::AUTHORIZE_PAGE ] ?? null;
		$this->assertNotNull( $page );
		$this->assertSame( '', $page['parent_slug'] );
		$this->assertSame( 'edit_posts', $page['capability'] );
		$this->assertSame( [ Oauth_Consent::class, 'render' ], $page['callback'] );
		$this->assertSame( Oauth_Server::authorization_endpoint(), Oauth_Server::authorization_metadata()['authorization_endpoint'] );
		$this->assertStringEndsWith( 'admin.php?page=' . Oauth_Server::AUTHORIZE_PAGE, Oauth_Server::authorization_endpoint() );

		\do_action( 'load-_page_' . Oauth_Server::AUTHORIZE_PAGE );
		$this->assertArrayHasKey( 'newspack-nodes-ui', $GLOBALS['_enqueued_styles'] );
		$this->assertSame( 'Approve a connection', $GLOBALS['title'] ?? null, 'a hidden page names its own title' );
	}

	public function test_the_plugin_file_wires_the_page_and_the_decision(): void {
		$registrations = $GLOBALS['_wp_initial_action_registrations'];

		$this->assertContains(
			[
				'callback'      => [ '\\Newspack_Nodes\\Admin\\Oauth_Consent', 'register' ],
				'priority'      => 10,
				'accepted_args' => 1,
			],
			$registrations['admin_menu'] ?? []
		);
		$this->assertContains(
			[
				'callback'      => [ '\\Newspack_Nodes\\Admin\\Oauth_Consent', 'decide' ],
				'priority'      => 10,
				'accepted_args' => 1,
			],
			$registrations[ 'admin_post_' . Oauth_Consent::DECIDE ] ?? []
		);
	}
}
