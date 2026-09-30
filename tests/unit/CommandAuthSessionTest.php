<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Helpers\Sqlite_Wpdb;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Session_Store_Unavailable;
use Newspack_Nodes\Wpdb_Arm;

#[CoversClass( Command_Auth::class )]
class CommandAuthSessionTest extends TestCase {

	/** Distinct from every default: not 3600 (session), not 60 (nonce TTL). */
	private const TTL = 4242;

	private const HANDLE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

	private const APCU_HANDLE = '7319cafebabefeed0123456789abcdef';

	/** Distinct from anything secret() could produce. */
	private const KEY   = 'first-key-4242-4242-4242-4242-4242';
	private const OTHER = 'second-key-9999-9999-9999-9999-99';

	private Sqlite_Wpdb $db;

	protected function setUp(): void {
		parent::setUp();
		$this->db = $this->use_wpdb();
		// Single-use claim is not what these tests exercise; keep it always-claimable.
		Command_Auth::$claim_nonce = static fn ( string $nonce, int $ttl ): bool => true;
	}

	protected function tearDown(): void {
		Command_Auth::$claim_nonce = null;
		parent::tearDown();
	}

	/** A fresh TM_COMMAND with the canonical command VALUE. */
	private function command(): array {
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_COMMAND;
		$m[ Message::VALUE ] = [ 'name' => 'make_node', 'arguments' => [ 'Tee', 't' ] ];
		$m[ Message::TIMESTAMP ] = 1000;
		return $m;
	}

	/** Write a session row straight into the store, as a mint would. */
	private function seed( string $handle, mixed $record, int $ttl = self::TTL ): void {
		$this->assertTrue( ( new Wpdb_Arm( Command_Auth::SESSIONS_TABLE ) )->add( $handle, $record, $ttl ) );
	}

	/** The session rows the store holds, handle => expires. */
	private function rows(): array {
		return \array_column( $this->db->get_results( "SELECT cache_key, expires FROM wp_newspack_nodes_table WHERE namespace = '" . Command_Auth::SESSIONS_TABLE . "'" ), 'expires', 'cache_key' );
	}

	public function test_a_mint_claims_its_handle_and_never_overwrites_one(): void {
		Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
		$inserts = \array_values( \array_filter( $this->db->sent, static fn ( string $sql ): bool => \str_starts_with( $sql, 'INSERT' ) ) );
		$this->assertCount( 1, $inserts );
		$this->assertStringStartsWith( 'INSERT IGNORE', $inserts[0], 'a live handle is never displaced' );
	}

	public function test_a_session_row_lives_in_the_durable_store_for_its_own_ttl(): void {
		Core::$clock = static fn (): float => 1790004242.0;
		$session     = Command_Auth::mint_session( Capabilities::READ, self::TTL );
		$this->assertSame( [ $session['handle'] => 1790004242 + self::TTL ], \array_map( 'intval', $this->rows() ) );
		Core::$clock = static fn (): float => 1790004242.0 + self::TTL - 1;
		$this->assertSame( $session['secret'], Command_Auth::load_session_record( $session['handle'] )['key'] ?? null, 'live a second before its ttl' );
		Core::$clock = static fn (): float => 1790004242.0 + self::TTL;
		$this->assertNull( Command_Auth::load_session_record( $session['handle'] ), 'and gone at it' );
	}

	public function test_a_session_outlives_a_salt_rotation(): void {
		$session = Command_Auth::mint_session( Capabilities::MANAGE, self::TTL );
		Cache_Backend::rotate_salt();
		$this->assertSame( $session['secret'], Command_Auth::load_session_record( $session['handle'] )['key'] ?? null );
	}

	public function test_a_mint_purges_expired_session_rows(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$this->seed( 'expired-4471', [ 'k' => self::KEY, 's' => 'read', 'u' => 0, 'e' => 1790000037 ], 37 );
		$this->seed( 'expired-4473', [ 'k' => self::KEY, 's' => 'read', 'u' => 0, 'e' => 1790000037 ], 37 );
		$this->seed( 'live-4477', [ 'k' => self::KEY, 's' => 'read', 'u' => 0, 'e' => 1790009000 ], 9000 );
		Core::$clock = static fn (): float => 1790000037.0;
		$minted      = Command_Auth::mint_session( Capabilities::READ, self::TTL );
		$held        = \array_keys( $this->rows() );
		\sort( $held );
		$expected    = [ 'live-4477', $minted['handle'] ];
		\sort( $expected );
		$this->assertSame( $expected, $held, 'the expired rows are gone, the live one stays' );
	}

	public function test_load_session_returns_null_for_an_unknown_handle(): void {
		$this->assertNull(
			( Command_Auth::load_session_record( 'ffffffffffffffffffffffffffffffff' )['key'] ?? null ),
			'a miss must be null, never false or a default'
		);
	}

	public function test_load_session_returns_null_when_the_store_will_not_open(): void {
		$this->db->deny['@@max_allowed_packet'] = 'Server has gone away 4816';
		$this->assertNull( Command_Auth::load_session_record( self::HANDLE ) );
	}

	public function test_mint_session_returns_a_key_that_resolves_by_its_handle(): void {
		$session = Command_Auth::mint_session();

		$this->assertSame(
			$session['secret'],
			( Command_Auth::load_session_record( $session['handle'] )['key'] ?? null ),
			'the returned key must be the one that was persisted'
		);
		$this->assertSame( Command_Auth::SESSION_TTL_S, $session['expires_in'] );
		$this->assertGreaterThan( 0, $session['now'], 'the client aligns its clock to this' );
	}

	public function test_mint_session_never_repeats_a_handle_or_a_key(): void {
		$first  = Command_Auth::mint_session();
		$second = Command_Auth::mint_session();

		$this->assertNotSame( $first['handle'], $second['handle'] );
		$this->assertNotSame( $first['secret'], $second['secret'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}$/', $first['handle'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{64}$/', $first['secret'] );
	}

	public function test_a_refused_store_fails_the_mint_naming_the_servers_reason(): void {
		$this->db->deny['INSERT IGNORE'] = 'Deadlock found 4816';

		try {
			Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
			$this->fail( 'an unstored session must not be handed back' );
		} catch ( Session_Store_Unavailable $e ) {
			$this->assertSame( 'could not store the session: wpdb wp_newspack_nodes_table: Deadlock found 4816', $e->getMessage() );
		}
	}

	public function test_a_store_that_will_not_open_fails_the_mint_naming_why(): void {
		$this->db->deny['CREATE TABLE'] = 'CREATE command denied 4816';

		$this->expectException( Session_Store_Unavailable::class );
		$this->expectExceptionMessage( 'the session store is unavailable: wpdb backend could not create wp_newspack_nodes_table: CREATE command denied 4816' );
		Command_Auth::mint_session();
	}

	/**
	 * The reply's credential field is named so the system's one redaction rule
	 * masks it. `Node::redact_secrets()` matches by field NAME through
	 * `Core::is_secret_property()`, and a browser persists a rendered reply to
	 * localStorage through that same rule, so a credential the rule does not
	 * recognise is written out in cleartext. `drop_message()` is the public
	 * surface that applies it to a message VALUE.
	 */
	public function test_a_minted_session_reply_is_redacted_by_the_one_secret_rule(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
		$secrets = \array_filter(
			\array_keys( $session ),
			static fn ( string $field ): bool => Core::is_secret_property( $field )
		);
		$this->assertCount( 1, $secrets, 'exactly one reply field names the credential' );

		$credential = $session[ (string) \reset( $secrets ) ];
		$buf        = '';
		Core::set_stderr_handler( function ( $m ) use ( &$buf ) { $buf .= $m; } );
		$node = new \Newspack_Nodes\Tests\Capture_Sink_Node();
		$node->name( 'alice' );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$message[ Message::VALUE ] = $session;

		$node->drop_message( $message, 'no sink' );

		$this->assertStringNotContainsString( $credential, $buf, 'the signing key must never reach a log or a transcript' );
		$this->assertStringContainsString( $session['handle'], $buf, 'the handle names the session and is not a credential' );
		$this->assertStringContainsString( Capabilities::TUNE, $buf, 'the scope states the authority granted' );
		$this->assertStringContainsString( (string) self::TTL, $buf, 'the lifetime survives' );
		$this->assertStringContainsString( (string) $session['now'], $buf, 'the server clock survives' );
	}

	/**
	 * The load-bearing one. On the pre-session code the handle is ignored and the
	 * secret()-keyed signature carries the message through — so a spoke could
	 * name any handle it liked and still be believed.
	 */
	public function test_verify_refuses_a_command_whose_handle_resolves_to_nothing(): void {
		$m = $this->command();
		Command_Auth::sign( $m );

		$value                   = $m[ Message::VALUE ];
		$value['auth']['handle'] = 'deadbeefdeadbeefdeadbeefdeadbeef';
		$m[ Message::VALUE ]     = $value;

		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_a_missing_session_refusal_is_quiet(): void {
		$logger = new class() extends \Newspack_Nodes\Command_Interpreter_Node {
			/** @var string[] */
			public array $dropped = [];
			public function drop_message( array $message, string $error ): void {
				$this->dropped[] = $error;
				parent::drop_message( $message, $error );
			}
		};
		$root = new class() extends \Newspack_Nodes\Command_Interpreter_Node {
			/** @var string[] */
			public array $dropped = [];
			public function drop_message( array $message, string $error ): void {
				$this->dropped[] = $error;
				parent::drop_message( $message, $error );
			}
		};
		$root->name( \Newspack_Nodes\Node_Names::COMMAND_INTERPRETER );
		$logger->name( 'topologies' );
		$logger->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$logger->authorize = Command_Auth::verifier();

		$m = $this->command();
		Command_Auth::sign( $m );
		$value                   = $m[ Message::VALUE ];
		$value['auth']['handle'] = 'deadbeefdeadbeefdeadbeefdeadbeef';
		$m[ Message::VALUE ]     = $value;
		$m[ Message::TIMESTAMP ] = \time();

		$logger->fill( $m );

		$this->assertSame( [], $logger->dropped );
		$this->assertSame( [], $root->dropped );
	}

	public function test_verify_refuses_a_handle_carrying_no_signature(): void {
		$session = Command_Auth::mint_session();

		$m                   = $this->command();
		$m[ Message::VALUE ] = [
			'name'      => 'make_node',
			'arguments' => [ 'Tee', 't' ],
			'auth'      => [ 'nonce' => \str_repeat( 'a', 32 ), 'handle' => $session['handle'] ],
		];

		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	/** The same-site minter path — Shell/`wp nodes cli` — must keep working untouched. */
	public function test_verify_still_accepts_a_secret_signed_command_with_no_handle(): void {
		$m = $this->command();
		Command_Auth::sign( $m );

		$this->assertArrayNotHasKey( 'handle', $m[ Message::VALUE ]['auth'] );
		$this->assertTrue( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_sign_for_round_trips_under_the_remembered_session(): void {
		$session = Command_Auth::mint_session();
		Command_Auth::remember_session( 'spoke-a', $session['handle'], $session['secret'] );

		$m = $this->command();
		Command_Auth::sign_for( 'spoke-a', $m );

		$this->assertSame( $session['handle'], $m[ Message::VALUE ]['auth']['handle'] );
		$this->assertTrue( Command_Auth::verify( $m, 1000 ) );
	}

	/**
	 * Destination binding: the signature is computed under spoke-a's key, so
	 * re-pointing the envelope at spoke-b's handle cannot be made to verify.
	 * This is what replaces signing TO — which must stay unsigned, since Router
	 * peels it in transit.
	 */
	public function test_a_signature_for_one_spoke_does_not_verify_under_another(): void {
		$a = Command_Auth::mint_session();
		$b = Command_Auth::mint_session();
		Command_Auth::remember_session( 'spoke-a', $a['handle'], $a['secret'] );
		Command_Auth::remember_session( 'spoke-b', $b['handle'], $b['secret'] );

		$m = $this->command();
		Command_Auth::sign_for( 'spoke-a', $m );

		$value                   = $m[ Message::VALUE ];
		$value['auth']['handle'] = $b['handle'];
		$m[ Message::VALUE ]     = $value;

		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_a_session_record_reports_when_it_expires(): void {
		$session = Command_Auth::mint_session( Capabilities::READ, self::TTL );

		$record = Command_Auth::load_session_record( $session['handle'] );

		$this->assertEqualsWithDelta( \time() + self::TTL, $record['expires'], 2 );
	}

	/** An unsigned command is refused downstream; that is the correct failure. */
	public function test_sign_for_leaves_the_message_unsigned_when_no_session_is_known(): void {
		$m = $this->command();
		Command_Auth::sign_for( 'spoke-never-authed', $m );

		$this->assertArrayNotHasKey( 'auth', $m[ Message::VALUE ] );
		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	/**
	 * The case the "handle is deliberately outside canonical()" argument rests on:
	 * stripping the handle must not downgrade a session signature into one the
	 * per-site secret will accept.
	 */
	public function test_stripping_the_handle_does_not_downgrade_to_the_site_secret(): void {
		$session = Command_Auth::mint_session();
		Command_Auth::remember_session( 'spoke-a', $session['handle'], $session['secret'] );

		$m = $this->command();
		Command_Auth::sign_for( 'spoke-a', $m );

		$value = $m[ Message::VALUE ];
		unset( $value['auth']['handle'] );
		$m[ Message::VALUE ] = $value;

		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	public function test_remember_session_rejects_empty_required_inputs(): void {
		$this->expectException( \InvalidArgumentException::class );
		Command_Auth::remember_session( 'spoke-a', '', self::KEY );
	}

	/**
	 * The canonical string is computed independently in PHP and in the browser,
	 * so its JSON encoding must be identical in both. PHP escapes slashes and
	 * non-ASCII by default; JSON.stringify does neither. A command carrying a
	 * path — `make_node Log x /tmp/...` — is enough to diverge, and the failure
	 * mode is a signature that never verifies.
	 *
	 * This pins the encoding by recomputing the HMAC over the exact string a
	 * JSON.stringify signer would produce.
	 */
	public function test_the_signed_canonical_string_matches_what_json_stringify_produces(): void {
		$session = Command_Auth::mint_session();
		Command_Auth::remember_session( 'spoke-a', $session['handle'], $session['secret'] );

		$m                   = $this->command();
		$m[ Message::VALUE ] = [
			'name'      => 'make_node',
			'arguments' => [ 'Log', 'x', '/tmp/newspack-nodes/logs/café.log' ],
		];
		Command_Auth::sign_for( 'spoke-a', $m );

		$auth = $m[ Message::VALUE ]['auth'];
		// Exactly what `JSON.stringify( [ type, ts, name, args, nonce ] )` emits.
		$js_canonical = \json_encode(
			[
				1000,
				'make_node',
				[ 'Log', 'x', '/tmp/newspack-nodes/logs/café.log' ],
				$auth['nonce'],
			],
			\JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE
		);

		$this->assertSame(
			\hash_hmac( 'sha256', (string) $js_canonical, $session['secret'] ),
			$auth['sig'],
			'PHP and the browser must canonicalize identically'
		);
	}

	/**
	 * ID is the originator's opaque continuation token — Tachikoma's Shell3 keys
	 * its pipe stages on it. The substrate must never read or write it, and the
	 * temptation is to reuse it as the session handle.
	 */
	public function test_signing_never_touches_the_originators_id(): void {
		$session = Command_Auth::mint_session();
		Command_Auth::remember_session( 'spoke-a', $session['handle'], $session['secret'] );

		$m                 = $this->command();
		$m[ Message::ID ]  = 'continuation-7';
		Command_Auth::sign_for( 'spoke-a', $m );

		$this->assertSame( 'continuation-7', $m[ Message::ID ] );
		$this->assertNotSame( $session['handle'], $m[ Message::ID ] );
	}

	/**
	 * The Sessions screen lists what this site ISSUED from an option, so
	 * liveness is a second question, asked of the store in ONE read rather
	 * than N.
	 */
	public function test_live_handles_reports_only_the_sessions_the_store_still_holds(): void {
		$live = Command_Auth::mint_session( Capabilities::READ, self::TTL )['handle'];
		$gone = '5555eeee6666ffff7777aaaa8888bbbb';

		$held = Command_Auth::live_handles( [ $live, $gone ] );

		$this->assertSame( [ $live => true ], $held );
	}

	/** Nothing asked for is nothing read: no keys, no round trip. */
	public function test_live_handles_of_nothing_reads_nothing(): void {
		$this->assertSame( [], Command_Auth::live_handles( [] ) );
	}

	/**
	 * A revoked handle stops verifying at once — that is the whole point of
	 * revocation — so it must drop out of the liveness answer too.
	 */
	public function test_a_revoked_handle_is_no_longer_live(): void {
		$handle = Command_Auth::mint_session( Capabilities::READ, self::TTL )['handle'];
		$this->assertTrue( Command_Auth::revoke_session( $handle ) );
		$this->assertFalse( Command_Auth::revoke_session( $handle ), 'a second revoke finds nothing' );

		$this->assertSame( [], Command_Auth::live_handles( [ $handle ] ) );
	}

	/**
	 * `has_session()` is asked before minting a command AT a remote: the
	 * process either holds that destination's credential or has to fetch one.
	 */
	public function test_has_session_is_per_destination(): void {
		$this->assertFalse( Command_Auth::has_session( 'https://spoke.test/wp-json/' ) );

		Command_Auth::remember_session(
			'https://spoke.test/wp-json/',
			self::HANDLE,
			self::KEY
		);

		$this->assertTrue( Command_Auth::has_session( 'https://spoke.test/wp-json/' ) );
		$this->assertFalse(
			Command_Auth::has_session( 'https://other.test/wp-json/' ),
			'one remote credential must not authorize another'
		);
	}

	public function test_forgetting_a_destination_drops_its_session(): void {
		Command_Auth::remember_session( 'https://spoke.test/wp-json/', self::HANDLE, self::KEY );
		Command_Auth::forget_session( 'https://spoke.test/wp-json/' );
		$this->assertFalse( Command_Auth::has_session( 'https://spoke.test/wp-json/' ) );
	}

	/** A lifetime is clamped, never refused: the ask is a preference. */
	public function test_a_requested_lifetime_is_clamped_into_the_allowed_band(): void {
		$this->assertSame(
			Command_Auth::SESSION_TTL_MAX_S,
			Command_Auth::bounded_ttl( Command_Auth::SESSION_TTL_MAX_S * 10 )
		);
		$this->assertSame( Command_Auth::SESSION_TTL_MIN_S, Command_Auth::bounded_ttl( 1 ) );
		$this->assertSame( self::TTL, Command_Auth::bounded_ttl( self::TTL ) );
	}

	/** A row not shaped as a mint writes it verifies nothing; it is no session. */
	public function test_a_row_in_any_other_shape_is_no_session(): void {
		$this->seed( 'keyless-8823', [ 's' => 'read', 'u' => 0, 'e' => 1 ] );
		$this->seed( 'scopeless-8825', [ 'k' => self::KEY, 'u' => 0, 'e' => 1 ] );
		$this->seed( 'bare-8827', self::KEY );
		foreach ( [ 'keyless-8823', 'scopeless-8825', 'bare-8827' ] as $handle ) {
			$this->assertNull( Command_Auth::load_session_record( $handle ), $handle );
		}
	}
}
