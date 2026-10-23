<?php
namespace Newspack_Nodes\Tests\Helpers;

use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Oauth_Store;
use Newspack_Nodes\Sessions;
use Newspack_Nodes\Tests\TestCase;

/**
 * The OAuth rows beside the command sessions: registered clients, single-use
 * codes, thirty-day grants and their rotating refresh tokens, all in the
 * session Table, so a flush of that Table ends every one of them. Each
 * backend the session store may name runs every case.
 */
abstract class OauthStoreContract extends TestCase {

	protected const T0 = 1790020000;

	private const DAY = 86400;

	private const RESOURCE = 'https://kea.example/wp-json/newspack-event-logger-nodes/v1/mcp';

	/** The client every approval names. */
	protected const CLIENT = 'c0ffee00c0ffee00c0ffee00c0ffee00';

	protected Sqlite_Wpdb $db;

	private int $at = self::T0;

	/**
	 * What each answer closure was called with, in order.
	 *
	 * @var list<array{grant:array<string,mixed>,grant_id:string,next:string,handle:string}>
	 */
	protected array $answered = [];

	protected function setUp(): void {
		parent::setUp();
		$this->use_backend();
		Core::$clock = fn (): float => (float) $this->at;
	}

	protected function tearDown(): void {
		Core::$clock = null;
		parent::tearDown();
	}

	/** Put the session store on the backend this class covers. */
	abstract protected function use_backend(): void;

	/** @return list<array{cache_key:string,value:string,expires:int}> Every key-value row of the session store. */
	abstract protected function rows(): array;

	/** @return list<array{set_key:string,member:string,expires:int}> Every set member of the session store. */
	abstract protected function members(): array;

	/** The grant fields an approval carries, distinct from every default. */
	protected static function approval( string $name = 'Tui laptop' ): array {
		return [
			'client'   => self::CLIENT,
			'user'     => 7746,
			'scope'    => Capabilities::READ,
			'resource' => self::RESOURCE,
			'name'     => $name,
		];
	}

	/**
	 * The answer the token endpoint gives: a session minted for the grant and
	 * bound to it, and the token response naming the next refresh token.
	 */
	protected function answer(): \Closure {
		return function ( array $grant, string $grant_id, string $next ): array {
			$session = Command_Auth::mint_session( $grant['scope'], 3600 );
			Oauth_Store::bind_session( $grant_id, $session['handle'] );
			$this->answered[] = [
				'grant'    => $grant,
				'grant_id' => $grant_id,
				'next'     => $next,
				'handle'   => $session['handle'],
			];
			return [
				'answer' => [
					'access_token'  => "{$session['handle']}.{$session['secret']}",
					'token_type'    => 'Bearer',
					'expires_in'    => 3600,
					'refresh_token' => $next,
					'scope'         => $grant['scope'],
				],
				'handle' => $session['handle'],
			];
		};
	}

	/** An answer closure that fails the test if a rotation reaches it. */
	protected function no_answer(): \Closure {
		return function (): array {
			$this->fail( 'no session may be minted here' );
		};
	}

	public function test_a_registered_client_keeps_its_name_and_exact_uris(): void {
		$uris = [ 'https://claude.ai/api/mcp/auth_callback', 'http://localhost:4410/callback?kea=1' ];

		$this->at = self::T0 + 17;
		$client   = Oauth_Store::register_client( 'Kea Desk 4410', [ 'kea' => $uris[0], 'kaka' => $uris[1] ] );

		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}$/D', $client['id'] );
		$kept = [
			'name'          => 'Kea Desk 4410',
			'redirect_uris' => $uris,
			'created'       => self::T0 + 17,
		];
		$this->assertSame( [ 'id' => $client['id'] ] + $kept, $client, 'registration answers with what it kept' );
		$this->assertSame( $kept, Oauth_Store::client( $client['id'] ) );
		$this->assertNull( Oauth_Store::client( 'feedfacefeedfacefeedfacefeedface' ), 'an unregistered id names no client' );
		$this->assertNull( Oauth_Store::client( "kea desk\n4410" ), 'an id no registration could make never reaches the store' );
	}

	public function test_a_client_name_is_cut_like_a_session_label(): void {
		$client = Oauth_Store::register_client( '<b>Kea</b> ' . \str_repeat( 'é', 40 ), [ 'https://claude.ai/api/mcp/auth_callback' ] );

		$this->assertSame( Sessions::clean_label( '<b>Kea</b> ' . \str_repeat( 'é', 40 ) ), Oauth_Store::client( $client['id'] )['name'] );
		$this->assertSame( 'Kea ' . \str_repeat( 'é', 30 ), $client['name'] );
	}

	public function test_a_client_lapses_180_days_after_registration(): void {
		$id = Oauth_Store::register_client( 'Kea Desk 4410', [ 'https://claude.ai/api/mcp/auth_callback' ] )['id'];

		$this->at = self::T0 + 180 * self::DAY - 1;
		$this->assertNotNull( Oauth_Store::client( $id ) );
		$this->at = self::T0 + 180 * self::DAY;
		$this->assertNull( Oauth_Store::client( $id ) );
	}

	public function test_registration_refuses_a_plain_http_redirect_that_is_not_loopback(): void {
		foreach ( [ 'http://127.0.0.1:4410/cb', 'https://claude.ai/api/mcp/auth_callback', 'http://localhost/cb' ] as $uri ) {
			$this->assertNotNull( Oauth_Store::client( Oauth_Store::register_client( 'Kea Desk 4410', [ $uri ] )['id'] ), "{$uri} registers" );
		}

		$this->expectException( \InvalidArgumentException::class );
		Oauth_Store::register_client( 'Kea Desk 4410', [ 'https://claude.ai/api/mcp/auth_callback', 'http://kea.example/cb' ] );
	}

	/** @return array<string,array{string,list<mixed>,int}> */
	public static function refused_registrations(): array {
		$six  = \array_map( static fn ( int $n ): string => "https://kea.example/cb{$n}", \range( 1, 6 ) );
		$name = Oauth_Store::REFUSED_NAME;
		$uris = Oauth_Store::REFUSED_REDIRECT_URIS;
		return [
			'an empty name'              => [ '', [ 'https://claude.ai/api/mcp/auth_callback' ], $name ],
			'a name that sanitizes away' => [ '<b></b>', [ 'https://claude.ai/api/mcp/auth_callback' ], $name ],
			'no redirect at all'         => [ 'Kea Desk 4410', [], $uris ],
			'six redirects'              => [ 'Kea Desk 4410', $six, $uris ],
			'plain http elsewhere'       => [ 'Kea Desk 4410', [ 'http://kea.example/cb' ], $uris ],
			'a loopback-looking host'    => [ 'Kea Desk 4410', [ 'http://localhost.kea.example/cb' ], $uris ],
			'userinfo before the host'   => [ 'Kea Desk 4410', [ 'http://localhost@kea.example/cb' ], $uris ],
			'userinfo disguising a host' => [ 'Kea Desk 4410', [ 'https://claude.ai@kea.example/cb' ], $uris ],
			'https with no host'         => [ 'Kea Desk 4410', [ 'https:///cb' ], $uris ],
			'a script scheme'            => [ 'Kea Desk 4410', [ 'javascript:alert(4410)' ], $uris ],
			'a fragment'                 => [ 'Kea Desk 4410', [ 'https://claude.ai/cb#kea' ], $uris ],
			'whitespace'                 => [ 'Kea Desk 4410', [ 'https://claude.ai/c b' ], $uris ],
			'not a string'               => [ 'Kea Desk 4410', [ 4410 ], $uris ],
			'a quote a redirect drops'   => [ 'Kea Desk 4410', [ "https://kea-desk.example/cb'4410" ], $uris ],
			'a brace a redirect drops'   => [ 'Kea Desk 4410', [ 'https://kea-desk.example/cb{4410}' ], $uris ],
			'non-ASCII a redirect encodes' => [ 'Kea Desk 4410', [ 'https://kea-desk.example/cb/tūī' ], $uris ],
		];
	}

	/** The code names what was refused, so a registration answers the right RFC 7591 error. */
	#[DataProvider( 'refused_registrations' )]
	public function test_registration_refuses_what_no_public_client_may_hold( string $name, array $uris, int $refused ): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionCode( $refused );
		Oauth_Store::register_client( $name, $uris );
	}

	public function test_a_code_is_taken_once_and_dies_after_sixty_seconds(): void {
		$bound = [
			'client'       => 'c0ffee00c0ffee00c0ffee00c0ffee00',
			'redirect_uri' => 'http://127.0.0.1:4410/cb',
			'challenge'    => 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
			'resource'     => self::RESOURCE,
			'user'         => 7746,
			'scope'        => Capabilities::READ,
			'name'         => 'Tui laptop',
		];

		$code = Oauth_Store::issue_code( $bound );

		$this->assertMatchesRegularExpression( '/^[0-9a-f]{64}$/D', $code );
		$this->at = self::T0 + 59;
		$this->assertSame( $bound, Oauth_Store::take_code( $code ) );
		$this->assertNull( Oauth_Store::take_code( $code ), 'a code is single use' );

		$this->at = self::T0;
		$late     = Oauth_Store::issue_code( $bound );
		$this->at = self::T0 + 61;
		$this->assertNull( Oauth_Store::take_code( $late ), 'a code lives sixty seconds' );
	}

	/** The connection name labels every session the grant mints, so it is cut as a label is. */
	public function test_a_code_keeps_its_connection_name_cut_like_a_session_label(): void {
		$typed = '<i>Tui</i>   laptop ' . \str_repeat( 'ō', 40 );

		$code = Oauth_Store::issue_code( [ 'name' => $typed ] + self::approval() + [ 'redirect_uri' => 'http://127.0.0.1:4410/cb', 'challenge' => 'kea' ] );

		$name = Oauth_Store::take_code( $code )['name'] ?? null;
		$this->assertSame( Sessions::clean_label( $typed ), $name );
		$this->assertSame( 'Tui laptop ' . \str_repeat( 'ō', 26 ), $name );
	}

	/** The grace row's answer is the one plaintext refresh token the store holds. */
	public function test_secrets_are_stored_only_as_their_hashes(): void {
		$code   = Oauth_Store::issue_code( self::approval() + [ 'redirect_uri' => 'http://127.0.0.1:4410/cb', 'challenge' => 'kea' ] );
		$first  = Oauth_Store::open_grant( self::approval() );
		$answer = Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->answer() );
		$next   = $answer['refresh_token'];

		$stored = (string) \wp_json_encode( $this->rows() );
		foreach ( [ $code, $first['refresh'] ] as $secret ) {
			$this->assertStringNotContainsString( $secret, $stored );
			$this->assertStringContainsString( \hash( 'sha256', $secret ), $stored );
		}
		$this->assertStringContainsString( \hash( 'sha256', $next ), $stored );
		$holding = \array_values( \array_filter( $this->rows(), static fn ( array $row ): bool => \str_contains( (string) $row['value'], $next ) ) );
		$this->assertCount( 1, $holding );
		$this->assertStringContainsString( 'oauth:grace:' . \hash( 'sha256', $first['refresh'] ), $holding[0]['cache_key'] );
	}

	public function test_a_grant_expires_thirty_days_after_approval_whatever_its_use(): void {
		$first = Oauth_Store::open_grant( self::approval() );

		$this->assertSame(
			self::approval() + [
				'created' => self::T0,
				'expires' => self::T0 + 30 * self::DAY,
			],
			Oauth_Store::grant( $first['grant'] )
		);

		$this->at = self::T0 + 29 * self::DAY;
		$next     = Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->answer() )['refresh_token'];
		$this->assertSame( self::T0 + 30 * self::DAY, Oauth_Store::grant( $first['grant'] )['expires'], 'a rotation never extends the grant' );
		$this->assertSame( self::T0 + 30 * self::DAY, \max( \array_map( 'intval', \array_column( $this->rows(), 'expires' ) ) ), 'no row the grant wrote outlives it' );

		$this->at = self::T0 + 30 * self::DAY + 1;
		$this->assertNull( Oauth_Store::grant( $first['grant'] ) );
		$this->assertNull( Oauth_Store::rotate( $next, self::CLIENT, null, $this->no_answer() ) );
	}

	public function test_rotation_spends_the_old_token_and_answers_with_the_next(): void {
		$first = Oauth_Store::open_grant( self::approval() );

		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}$/D', $first['grant'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{64}$/D', $first['refresh'] );

		$this->at = self::T0 + 900;
		$answer   = Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->answer() );

		$this->assertCount( 1, $this->answered );
		$this->assertSame( $first['grant'], $this->answered[0]['grant_id'] );
		$this->assertSame( Oauth_Store::grant( $first['grant'] ), $this->answered[0]['grant'] );
		$this->assertSame( $this->answered[0]['next'], $answer['refresh_token'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{64}$/D', $answer['refresh_token'] );
		$this->assertNotSame( $first['refresh'], $answer['refresh_token'] );
		$this->assertNotNull( Oauth_Store::rotate( $answer['refresh_token'], self::CLIENT, null, $this->answer() ), 'the next token rotates in turn' );
		$this->assertNull( Oauth_Store::rotate( \str_repeat( 'ab', 32 ), self::CLIENT, null, $this->no_answer() ), 'a token no grant issued is unknown' );
	}

	public function test_a_refresh_retried_within_the_grace_answers_the_same_pair(): void {
		$first  = Oauth_Store::open_grant( self::approval() );
		$answer = Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->answer() );

		$this->at = self::T0 + 59;
		$retry    = Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->no_answer() );

		$this->assertSame( $answer, $retry );
		$this->assertCount( 1, $this->answered, 'a retry mints nothing' );
		$this->assertNotNull( Oauth_Store::grant( $first['grant'] ), 'the grant outlives a forgiven retry' );
		$this->assertNotNull( Command_Auth::load_session_record( $this->answered[0]['handle'] ), 'the session the retry was answered with is live' );
		$this->assertNotNull( Oauth_Store::rotate( $answer['refresh_token'], self::CLIENT, null, $this->answer() ), 'the pair the retry was answered with still works' );
	}

	/** A token presented by another client, or for another resource, rotates nothing. */
	public function test_a_refresh_by_another_client_or_for_another_resource_spends_nothing(): void {
		$first = Oauth_Store::open_grant( self::approval() );

		$this->assertNull( Oauth_Store::rotate( $first['refresh'], 'feedfacefeedfacefeedfacefeedface', null, $this->no_answer() ) );
		$this->assertNull( Oauth_Store::rotate( $first['refresh'], self::CLIENT, 'https://kea.example/wp-json/kea-other/v1/mcp', $this->no_answer() ) );

		$this->assertNotNull( Oauth_Store::rotate( $first['refresh'], self::CLIENT, self::RESOURCE, $this->answer() ), 'the token is still live' );
	}

	/** The grace replays its answer to the grant's own client and resource alone. */
	public function test_a_retry_by_another_client_or_for_another_resource_replays_nothing(): void {
		$first  = Oauth_Store::open_grant( self::approval() );
		$answer = Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->answer() );

		$this->at = self::T0 + 30;

		$this->assertNull( Oauth_Store::rotate( $first['refresh'], 'feedfacefeedfacefeedfacefeedface', null, $this->no_answer() ) );
		$this->assertNull( Oauth_Store::rotate( $first['refresh'], self::CLIENT, 'https://kea.example/wp-json/kea-other/v1/mcp', $this->no_answer() ) );
		$this->assertSame( $answer, Oauth_Store::rotate( $first['refresh'], self::CLIENT, self::RESOURCE, $this->no_answer() ), 'the honest retry still replays' );
		$this->assertNotNull( Oauth_Store::grant( $first['grant'] ) );
	}

	/**
	 * Two refreshes of one token race: the loser's grace row loses to the
	 * winner's, so the loser answers the winner's pair, revokes the session
	 * it minted and drops the refresh token it issued.
	 */
	public function test_a_refresh_that_loses_the_claim_answers_the_winners_pair(): void {
		$first  = Oauth_Store::open_grant( self::approval() );
		$winner = null;
		$racing = $this->answer();
		$loser  = function ( array $grant, string $grant_id, string $next ) use ( $first, $racing, &$winner ): array {
			$winner = Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $racing );
			return $racing( $grant, $grant_id, $next );
		};

		$answer = Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $loser );

		$this->assertNotNull( $winner );
		$this->assertSame( $winner, $answer );
		[ $won, $lost ] = $this->answered;
		$this->assertSame( $won['next'], $answer['refresh_token'] );
		$this->assertNotNull( Command_Auth::load_session_record( $won['handle'] ) );
		$this->assertNull( Command_Auth::load_session_record( $lost['handle'] ), 'the loser revokes the session it minted' );
		$this->assertStringNotContainsString( \hash( 'sha256', $lost['next'] ), (string) \wp_json_encode( $this->rows() ), 'the loser drops the refresh token it issued' );
		$this->assertNull( Oauth_Store::rotate( $lost['next'], self::CLIENT, null, $this->no_answer() ) );
		$this->assertNotNull( Oauth_Store::grant( $first['grant'] ) );
		$this->assertNotNull( Oauth_Store::rotate( $won['next'], self::CLIENT, null, $this->answer() ) );
	}

	/**
	 * A race loser answers the winner's pair only while the grant is live: a
	 * grant revoked mid-race leaves the loser nothing, its session revoked.
	 */
	public function test_a_refresh_that_loses_the_claim_to_a_revoked_grant_answers_nothing(): void {
		$first  = Oauth_Store::open_grant( self::approval() );
		$racing = $this->answer();
		$loser  = function ( array $grant, string $grant_id, string $next ) use ( $first, $racing ): array {
			Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $racing );
			Oauth_Store::revoke_grant( $grant_id );
			return $racing( $grant, $grant_id, $next );
		};

		$this->assertNull( Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $loser ) );
		$this->assertNull( Command_Auth::load_session_record( $this->answered[1]['handle'] ), 'the loser revokes the session it minted' );
	}

	/**
	 * The claim is read first: a retry arriving after a rotation claimed the
	 * token, while its live row still stands, as a crash between the claim
	 * and the delete leaves it, replays rather than rotating again.
	 */
	public function test_a_retry_after_the_claim_replays_while_the_live_row_stands(): void {
		$first  = Oauth_Store::open_grant( self::approval() );
		$answer = Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->answer() );
		Command_Auth::session_table()->add( 'oauth:refresh:' . \hash( 'sha256', $first['refresh'] ), [ 'grant' => $first['grant'] ], 30 * self::DAY );

		$this->at = self::T0 + 3;

		$this->assertSame( $answer, Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->no_answer() ) );
		$this->assertCount( 1, $this->answered );
	}

	/** A spent token whose grace row lapsed within the minute: refused, never revoking. */
	public function test_a_spent_token_whose_grace_row_lapsed_revokes_nothing(): void {
		$first  = Oauth_Store::open_grant( self::approval() );
		$answer = Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->answer() );
		Command_Auth::session_table()->forget( 'oauth:grace:' . \hash( 'sha256', $first['refresh'] ) );

		$this->at = self::T0 + 5;

		$this->assertNull( Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->no_answer() ) );
		$this->assertNotNull( Oauth_Store::grant( $first['grant'] ) );
		$this->assertNotNull( Command_Auth::load_session_record( $this->answered[0]['handle'] ) );
		$this->assertNotNull( Oauth_Store::rotate( $answer['refresh_token'], self::CLIENT, null, $this->answer() ) );
	}

	/** A refresh whose answer throws drops the token it issued; the old one still works. */
	public function test_an_answer_that_throws_leaves_no_next_refresh_row(): void {
		$first  = Oauth_Store::open_grant( self::approval() );
		$issued = null;

		$thrown = $this->caught(
			static function () use ( $first, &$issued ): void {
				Oauth_Store::rotate(
					$first['refresh'],
					self::CLIENT,
					null,
					static function ( array $grant, string $grant_id, string $next ) use ( &$issued ): array {
						$issued = $next;
						throw new \RuntimeException( 'kea mint 4410 failed' );
					}
				);
			},
			'expected the answer to throw'
		);

		$this->assertSame( 'kea mint 4410 failed', $thrown->getMessage() );
		$this->assertNotNull( $issued );
		$this->assertStringNotContainsString( \hash( 'sha256', $issued ), (string) \wp_json_encode( $this->rows() ) );
		$this->assertNotNull( Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->answer() ), 'the live token was never spent' );
	}

	public function test_a_spent_token_after_the_grace_revokes_the_grant(): void {
		$first   = Oauth_Store::open_grant( self::approval() );
		$session = Command_Auth::mint_session( Capabilities::READ, 3600 );
		Oauth_Store::bind_session( $first['grant'], $session['handle'] );
		$next = Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->answer() )['refresh_token'];

		$this->at = self::T0 + 61;

		$this->assertNull( Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->no_answer() ) );
		$this->assertNull( Oauth_Store::grant( $first['grant'] ) );
		$this->assertNull( Command_Auth::load_session_record( $session['handle'] ), 'a reused token ends every session the grant minted' );
		$this->assertNull( Command_Auth::load_session_record( $this->answered[0]['handle'] ) );
		$this->assertNull( Oauth_Store::rotate( $next, self::CLIENT, null, $this->no_answer() ) );
	}

	public function test_a_revoked_grant_refuses_its_refresh_token(): void {
		$first = Oauth_Store::open_grant( self::approval() );

		Oauth_Store::revoke_grant( $first['grant'] );

		$this->assertNull( Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->no_answer() ) );
		$this->assertNull( Oauth_Store::grant( $first['grant'] ) );
	}

	public function test_a_retry_after_the_grant_was_revoked_replays_nothing(): void {
		$first = Oauth_Store::open_grant( self::approval() );
		Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->answer() );

		Oauth_Store::revoke_grant( $first['grant'] );
		$this->at = self::T0 + 5;

		$this->assertNull( Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->no_answer() ) );
	}

	public function test_revoking_a_grant_revokes_every_session_it_minted(): void {
		$doomed = Oauth_Store::open_grant( self::approval( 'Tui laptop' ) );
		$kept   = Oauth_Store::open_grant( self::approval( 'Kaka desk' ) );
		$a      = Command_Auth::mint_session( Capabilities::READ, 3600 );
		$b      = Command_Auth::mint_session( Capabilities::READ, 3600 );
		$c      = Command_Auth::mint_session( Capabilities::READ, 3600 );
		Oauth_Store::bind_session( $doomed['grant'], $a['handle'] );
		Oauth_Store::bind_session( $doomed['grant'], $b['handle'] );
		Oauth_Store::bind_session( $kept['grant'], $c['handle'] );

		Oauth_Store::revoke_grant( $doomed['grant'] );

		$this->assertNull( Command_Auth::load_session_record( $a['handle'] ) );
		$this->assertNull( Command_Auth::load_session_record( $b['handle'] ) );
		$this->assertNotNull( Command_Auth::load_session_record( $c['handle'] ) );
		$this->assertNotNull( Oauth_Store::grant( $kept['grant'] ) );
	}

	public function test_a_bound_session_is_indexed_for_the_grants_remaining_life(): void {
		$first    = Oauth_Store::open_grant( self::approval() );
		$this->at = self::T0 + 4410;
		$session  = Command_Auth::mint_session( Capabilities::READ, 3600 );

		$this->assertTrue( Oauth_Store::bind_session( $first['grant'], $session['handle'] ) );

		$this->assertContains(
			[
				'set_key' => "oauth:grant-sessions:{$first['grant']}",
				'member'  => $session['handle'],
				'expires' => self::T0 + 30 * self::DAY,
			],
			$this->members()
		);
	}

	public function test_binding_to_a_grant_that_is_gone_answers_false_and_indexes_nothing(): void {
		$first   = Oauth_Store::open_grant( self::approval() );
		$session = Command_Auth::mint_session( Capabilities::READ, 3600 );
		Oauth_Store::revoke_grant( $first['grant'] );

		$this->assertFalse( Oauth_Store::bind_session( $first['grant'], $session['handle'] ) );
		$this->assertFalse( Oauth_Store::bind_session( 'not a grant id', $session['handle'] ) );
		$this->assertSame( [], \array_filter( $this->members(), static fn ( array $row ): bool => $row['member'] === $session['handle'] ) );
	}

	/**
	 * A connection names its client by the name the client registered; one
	 * whose registration lapsed names none.
	 */
	public function test_grants_lists_live_connections_newest_first_and_skips_revoked(): void {
		$client   = Oauth_Store::register_client( 'Kea Desk 4410', [ 'https://claude.ai/api/mcp/auth_callback' ] )['id'];
		$tui      = Oauth_Store::open_grant( [ 'client' => $client ] + self::approval( 'Tui laptop' ) );
		$this->at = self::T0 + 10;
		$kaka     = Oauth_Store::open_grant( self::approval( 'Kaka desk' ) );
		$this->at = self::T0 + 20;
		$weka     = Oauth_Store::open_grant( self::approval( 'Weka phone' ) );
		Oauth_Store::revoke_grant( $kaka['grant'] );

		$this->at = self::T0 + 30;

		$this->assertSame(
			[
				[
					'grant'   => $weka['grant'],
					'name'    => 'Weka phone',
					'client'  => '',
					'scope'   => Capabilities::READ,
					'created' => self::T0 + 20,
					'expires' => self::T0 + 20 + 30 * self::DAY,
				],
				[
					'grant'   => $tui['grant'],
					'name'    => 'Tui laptop',
					'client'  => 'Kea Desk 4410',
					'scope'   => Capabilities::READ,
					'created' => self::T0,
					'expires' => self::T0 + 30 * self::DAY,
				],
			],
			Oauth_Store::grants()
		);
	}

	/** A client's registered name keeps no escape sequence to print later. */
	public function test_a_client_named_with_an_escape_stores_none(): void {
		$client = Oauth_Store::register_client( "Kea\x1b[2K Desk\xC2\x9B", [ 'https://claude.ai/api/mcp/auth_callback' ] );

		$this->assertSame( 'Kea[2K Desk', $client['name'] );
		$this->assertSame( 'Kea[2K Desk', Oauth_Store::client( $client['id'] )['name'] ?? null );
	}

	public function test_revoke_all_sessions_empties_every_oauth_row(): void {
		$client = Oauth_Store::register_client( 'Kea Desk 4410', [ 'https://claude.ai/api/mcp/auth_callback' ] )['id'];
		$first  = Oauth_Store::open_grant( self::approval() );

		Sessions::revoke_all();

		$this->assertNull( Oauth_Store::client( $client ) );
		$this->assertNull( Oauth_Store::grant( $first['grant'] ) );
		$this->assertSame( [], Oauth_Store::grants() );
		$this->assertNull( Oauth_Store::rotate( $first['refresh'], self::CLIENT, null, $this->no_answer() ) );
	}
}
