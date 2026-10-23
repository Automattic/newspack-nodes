<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Helpers\Sqlite_Wpdb;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Oauth_Store;
use Newspack_Nodes\Session_Store_Unavailable;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;

#[CoversClass( Command_Auth::class )]
class CommandAuthSessionTest extends TestCase {

	/** Distinct from every default: not 3600 (session), not 60 (nonce TTL). */
	private const TTL = 4242;

	private const HANDLE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

	private const APCU_HANDLE = '7319cafebabefeed0123456789abcdef';

	/** The MCP door a grant names, and another it does not. */
	private const RESOURCE = 'https://kea.example/wp-json/newspack-event-logger-nodes/v1/mcp';
	private const ELSEWHERE = 'https://kea.example/wp-json/newspack-event-logger-nodes/v1/other';

	/** A resource a grant names that no substrate door is. */
	private const KEA_MCP = 'https://kea.example/wp-json/kea/v1/mcp';

	/** The approving user, distinct from the current user these tests log in. */
	private const GRANT_USER = 7746;

	/** The connection name the approver gave the grant. */
	private const GRANT_NAME = 'Tui laptop 7746';

	/** Distinct from anything secret() could produce. */
	private const KEY   = 'first-key-4242-4242-4242-4242-4242';
	private const OTHER = 'second-key-9999-9999-9999-9999-99';

	private Sqlite_Wpdb $db;

	protected function setUp(): void {
		parent::setUp();
		$this->db = $this->use_wpdb_sessions();
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
		$this->assertTrue( $this->store()->add( $handle, $record, $ttl ) );
	}

	/** The session store as any code-built Table naming its namespace opens it. */
	private function store(): Table_Node {
		return Table_Node::table( Command_Auth::session_store(), 900, 'wpdb' );
	}

	/** The session rows the store holds, handle => expires. */
	private function rows(): array {
		return \array_column( $this->db->get_results( "SELECT cache_key, expires FROM wp_newspack_nodes_table WHERE namespace = '" . Command_Auth::session_store() . "'" ), 'expires', 'cache_key' );
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
		$this->seed( 'expired-4471', [ 'k' => self::KEY, 's' => 'read', 'u' => 0 ], 37 );
		$this->seed( 'expired-4473', [ 'k' => self::KEY, 's' => 'read', 'u' => 0 ], 37 );
		$this->seed( 'live-4477', [ 'k' => self::KEY, 's' => 'read', 'u' => 0 ], 9000 );
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
		$this->db->deny['CREATE TABLE'] = 'Server has gone away 4816';
		$this->assertNull( Command_Auth::load_session_record( self::HANDLE ) );
	}

	/** One Table serves every mint, verify and revoke in a process. */
	public function test_every_session_read_and_write_shares_one_table(): void {
		$table = Command_Auth::session_table();
		$handle = Command_Auth::mint_session( Capabilities::TUNE, self::TTL )['handle'];
		Command_Auth::load_session_record( $handle );
		Command_Auth::revoke_session( $handle );
		$this->assertSame( $table, Command_Auth::session_table() );
	}

	/**
	 * One POST carrying k commands under one session reads the session once:
	 * a batch verifier remembers each handle for its own life, and a fresh one
	 * reads again, so a revoke bites the next POST.
	 */
	public function test_a_batch_verifier_reads_each_session_once(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
		Command_Auth::remember_session( 'spoke-4242', $session['handle'], $session['secret'] );
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();
		$verify      = Command_Auth::batch_verifier();
		$before      = \count( $this->db->sent );
		foreach ( [ 1, 2, 3 ] as $n ) {
			$m                       = $this->command();
			$m[ Message::TIMESTAMP ] = \time();
			Command_Auth::sign_for( 'spoke-4242', $m );
			$this->assertTrue( $verify( $interpreter, $m ), "command {$n}" );
		}
		$this->assertCount( 1, \array_slice( $this->db->sent, $before ), 'one SELECT for three commands' );

		Command_Auth::revoke_session( $session['handle'] );
		$m                       = $this->command();
		$m[ Message::TIMESTAMP ] = \time();
		Command_Auth::sign_for( 'spoke-4242', $m );
		$this->assertFalse( ( Command_Auth::batch_verifier() )( $interpreter, $m ), 'the next batch reads the revoke' );
	}

	/** A command signed under `spoke-4242`'s session at `$ts`. */
	private function signed_at( int $ts ): array {
		$m                       = $this->command();
		$m[ Message::TIMESTAMP ] = $ts;
		Command_Auth::sign_for( 'spoke-4242', $m );
		return $m;
	}

	/** Mint and remember a session at `$at`, so its row is live then. */
	private function session_at( int $at ): void {
		Core::$clock = static fn (): float => (float) $at;
		$session     = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
		Command_Auth::remember_session( 'spoke-4242', $session['handle'], $session['secret'] );
	}

	/**
	 * A batch dispatches its commands one after another, so a slow verb ages
	 * the ones behind it: every command verifies against the batch's arrival.
	 */
	public function test_a_batch_verifies_every_command_against_its_arrival(): void {
		$signed = 1790007300;
		$this->session_at( $signed );
		$first       = $this->signed_at( $signed );
		$second      = $this->signed_at( $signed );
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();

		Core::$clock = static fn (): float => $signed + 5.0;
		$verify      = Command_Auth::batch_verifier();
		$this->assertTrue( $verify( $interpreter, $first ) );
		Core::$clock = static fn (): float => (float) ( $signed + 5 + Command_Auth::MAX_PAST_S + 9 );
		$this->assertTrue( $verify( $interpreter, $second ), 'the slow first command does not age the second' );
	}

	public function test_a_command_older_than_the_window_at_arrival_is_still_refused(): void {
		$arrival = 1790007600;
		$this->session_at( $arrival );
		$stale = $this->signed_at( $arrival - Command_Auth::MAX_PAST_S - 1 );

		Core::$clock = static fn (): float => (float) $arrival;
		$this->assertFalse( ( Command_Auth::batch_verifier() )( new \Newspack_Nodes\Command_Interpreter_Node(), $stale ) );
	}

	/**
	 * The nonce claim lasts NONCE_TTL_S from first verification while a
	 * batch's freshness never ages, so the batch path also refuses a command
	 * past NONCE_TTL_S - MAX_FUTURE_S of wall age at its own turn: a replay
	 * queued behind slow verbs past its nonce claim finds that claim expired.
	 */
	public function test_a_replay_queued_past_the_nonce_claim_is_refused(): void {
		$claims                    = [];
		Command_Auth::$claim_nonce = static function ( string $nonce, int $ttl ) use ( &$claims ): bool {
			$now = ( Core::$clock )();
			if ( isset( $claims[ $nonce ] ) && $claims[ $nonce ] > $now ) {
				return false;
			}
			$claims[ $nonce ] = $now + $ttl;
			return true;
		};
		$signed = 1790008200;
		$this->session_at( $signed );
		$command     = $this->signed_at( $signed );
		$interpreter = new class() extends \Newspack_Nodes\Command_Interpreter_Node {
			/** @var string[] */
			public array $dropped = [];
			public function drop_message( array $message, string $error ): void {
				$this->dropped[] = $error;
			}
		};

		Core::$clock = static fn (): float => $signed + 4.0;
		$verify      = Command_Auth::batch_verifier();
		$this->assertTrue( $verify( $interpreter, $command ) );
		Core::$clock = static fn (): float => (float) ( $signed + 4 + Command_Auth::NONCE_TTL_S + 7 );
		$this->assertFalse( $verify( $interpreter, $command ), 'the replay outlived its claim' );
		$this->assertSame( [ 'verification failed: timestamp out of range' ], $interpreter->dropped );
	}

	/**
	 * A batch outlives the host's 120 s gateway: a command whose turn comes
	 * 130 s after it was signed, inside BATCH_MAX_AGE_S, still verifies.
	 */
	public function test_a_command_reached_inside_the_gateway_timeout_verifies(): void {
		$signed = 1790008500;
		$this->session_at( $signed );
		$command = $this->signed_at( $signed );

		Core::$clock = static fn (): float => $signed + 3.0;
		$verify      = Command_Auth::batch_verifier();
		Core::$clock = static fn (): float => $signed + 130.0;
		$this->assertTrue( $verify( new \Newspack_Nodes\Command_Interpreter_Node(), $command ) );
	}

	/**
	 * The claim taken at the earliest first verification, MAX_FUTURE_S before
	 * the signature, expires NONCE_TTL_S later, the very second a command
	 * reaches the batch's age bound, so that second is refused too.
	 */
	public function test_a_command_reaching_the_batch_age_bound_is_refused(): void {
		$signed = 1790008800;
		$this->session_at( $signed );
		$command = $this->signed_at( $signed );

		Core::$clock = static fn (): float => $signed + 6.0;
		$verify      = Command_Auth::batch_verifier();
		Core::$clock = static fn (): float => (float) ( $signed + Command_Auth::NONCE_TTL_S - Command_Auth::MAX_FUTURE_S );
		$this->assertFalse( $verify( new \Newspack_Nodes\Command_Interpreter_Node(), $command ) );
	}

	public function test_each_batch_reads_its_own_clock(): void {
		$signed = 1790007900;
		$this->session_at( $signed );
		$early       = $this->signed_at( $signed );
		$late        = $this->signed_at( $signed );
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();

		Core::$clock = static fn (): float => $signed + 3.0;
		$this->assertTrue( ( Command_Auth::batch_verifier() )( $interpreter, $early ) );
		Core::$clock = static fn (): float => (float) ( $signed + Command_Auth::MAX_PAST_S + 7 );
		$this->assertFalse( ( Command_Auth::batch_verifier() )( $interpreter, $late ), 'a later batch arrives past the window' );
	}

	/** A batch begun while another runs leaves the first one's arrival alone. */
	public function test_a_batch_keeps_its_arrival_while_another_begins(): void {
		$signed = 1790009100;
		$this->session_at( $signed );
		$command     = $this->signed_at( $signed );
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();

		Core::$clock = static fn (): float => $signed + 2.0;
		$first       = Command_Auth::batch_verifier();
		Core::$clock = static fn (): float => (float) ( $signed + Command_Auth::MAX_PAST_S + 11 );
		Command_Auth::batch_verifier();
		$this->assertTrue( $first( $interpreter, $command ), 'the first batch still arrived 2 s after the signature' );
	}

	/** A batch begun while another runs leaves the first one's reads alone. */
	public function test_a_batch_keeps_its_session_reads_while_another_begins(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
		Command_Auth::remember_session( 'spoke-4242', $session['handle'], $session['secret'] );
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();
		$first       = Command_Auth::batch_verifier();
		$this->assertTrue( $first( $interpreter, $this->signed_at( \time() ) ) );
		$before = \count( $this->db->sent );

		Command_Auth::batch_verifier();
		$this->assertTrue( $first( $interpreter, $this->signed_at( \time() ) ) );
		$this->assertCount( 0, \array_slice( $this->db->sent, $before ), 'the first batch reads its session once' );
	}

	public function test_a_malformed_handle_never_reaches_the_store(): void {
		Command_Auth::session_table();
		$before = \count( $this->db->sent );
		foreach ( [ 'nsh-4242', \strtoupper( self::HANDLE ), self::HANDLE . "\n", '' ] as $handle ) {
			$m = $this->command();
			Command_Auth::sign( $m );
			$value                   = $m[ Message::VALUE ];
			$value['auth']['handle'] = $handle;
			$m[ Message::VALUE ]     = $value;
			$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ), \var_export( $handle, true ) );
			$this->assertNull( Command_Auth::load_session_record( $handle ) );
		}
		$this->assertSame( [], \array_slice( $this->db->sent, $before ), 'no statement for a handle no mint could make' );
	}

	/** A labelled session's row carries its label and when it was minted. */
	public function test_a_labelled_mint_stores_its_label_and_when(): void {
		Core::$clock = static fn (): float => 1790004242.0;
		$session     = Command_Auth::mint_session( Capabilities::TUNE, self::TTL, 'kea-4242' );

		$record = Command_Auth::load_session_record( $session['handle'] );

		$this->assertSame( [ 'key' => $session['secret'], 'scope' => Capabilities::TUNE, 'user' => 0, 'ttl' => self::TTL, 'label' => 'kea-4242', 'created' => 1790004242 ], $record );
		$this->assertSame( '', Command_Auth::load_session_record( Command_Auth::mint_session( Capabilities::READ, self::TTL )['handle'] )['label'] ?? null, 'an unlabelled mint' );
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
			$this->assertSame( 'could not store the session: wpdb wp_newspack_nodes_table: [0] Deadlock found 4816', $e->getMessage() );
		}
	}

	public function test_a_store_that_will_not_open_fails_the_mint_naming_why(): void {
		$this->db->deny['CREATE TABLE'] = 'CREATE command denied 4816';

		$this->expectException( Session_Store_Unavailable::class );
		$this->expectExceptionMessage( 'the session store is unavailable: Table ' . Command_Auth::session_store() . ': wpdb backend could not create wp_newspack_nodes_table: [0] CREATE command denied 4816' );
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

		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
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

		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
	}

	/** The same-site minter path — Shell/`wp nodes cli` — must keep working untouched. */
	public function test_verify_still_accepts_a_secret_signed_command_with_no_handle(): void {
		$m = $this->command();
		Command_Auth::sign( $m );

		$this->assertArrayNotHasKey( 'handle', $m[ Message::VALUE ]['auth'] );
		$this->assertTrue( Command_Auth::verify( $m, 1000, 1000 ) );
	}

	public function test_sign_for_round_trips_under_the_remembered_session(): void {
		$session = Command_Auth::mint_session();
		Command_Auth::remember_session( 'spoke-a', $session['handle'], $session['secret'] );

		$m = $this->command();
		Command_Auth::sign_for( 'spoke-a', $m );

		$this->assertSame( $session['handle'], $m[ Message::VALUE ]['auth']['handle'] );
		$this->assertTrue( Command_Auth::verify( $m, 1000, 1000 ) );
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

		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
	}

	public function test_a_session_records_life_is_the_life_its_row_has_left(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$session     = Command_Auth::mint_session( Capabilities::READ, self::TTL );
		Core::$clock = static fn (): float => 1790000051.0;

		$record = Command_Auth::load_session_record( $session['handle'] );

		$this->assertSame( self::TTL - 51, $record['ttl'] ?? null, 'the life the row has left, not the TTL copied at mint' );
		$this->assertSame( [ 'key', 'scope', 'user', 'ttl', 'label', 'created' ], \array_keys( $record ) );
	}

	public function test_a_session_row_carries_no_copy_of_its_expiry(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );

		$this->assertSame( [ 'k', 's', 'u', 'l', 'c' ], \array_keys( Core::arr( $this->store()->lookup( $session['handle'] ) ) ) );
	}

	/**
	 * One grammar: a Table a topology declares in the sessions namespace, on
	 * wpdb, reads the very row a mint wrote, under the bare handle.
	 */
	public function test_a_declared_wpdb_table_in_the_sessions_namespace_reads_a_minted_row(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
		Core::$var['partition'] = '0';
		try {
			$table = new Table_Node();
			$table->name( 'lab-7:sessions' );
			$table->arguments( [ Command_Auth::session_store(), '900', 'wpdb' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$sink = new Capture_Sink_Node();
		$table->sink( $sink );
		$get                   = Message::new_message();
		$get[ Message::TYPE ]  = Message::TM_REQUEST;
		$get[ Message::FROM ]  = 'asker-4242';
		$get[ Message::VALUE ] = "GET {$session['handle']}\n";

		$table->fill( $get );

		$this->assertSame( Message::TM_STRUCT, $sink->captured[0][ Message::TYPE ] ?? null );
		$this->assertSame( $session['handle'], $sink->captured[0][ Message::KEY ] );
		$this->assertSame( $session['secret'], $sink->captured[0][ Message::VALUE ]['k'] ?? null );
		$this->assertSame( Capabilities::TUNE, $sink->captured[0][ Message::VALUE ]['s'] ?? null );
	}

	/** An unsigned command is refused downstream; that is the correct failure. */
	public function test_sign_for_leaves_the_message_unsigned_when_no_session_is_known(): void {
		$m = $this->command();
		Command_Auth::sign_for( 'spoke-never-authed', $m );

		$this->assertArrayNotHasKey( 'auth', $m[ Message::VALUE ] );
		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
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

		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
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
	 * each row's scope and life are asked of the store in ONE read rather
	 * than N.
	 */
	public function test_load_session_records_answers_only_the_sessions_the_store_still_holds(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$live        = Command_Auth::mint_session( Capabilities::TUNE, self::TTL );
		$gone        = '5555eeee6666ffff7777aaaa8888bbbb';
		$before      = \count( $this->db->sent );

		$records = Command_Auth::load_session_records( [ $live['handle'], $gone ] );

		$this->assertSame( [ $live['handle'] => [ 'key' => $live['secret'], 'scope' => Capabilities::TUNE, 'user' => 0, 'ttl' => self::TTL, 'label' => '', 'created' => 1790000000 ] ], $records );
		$this->assertCount( 1, \array_filter( \array_slice( $this->db->sent, $before ), static fn ( string $sql ): bool => \str_starts_with( $sql, 'SELECT' ) ), 'one read' );
	}

	/** Nothing asked for is nothing read: no keys, no round trip. */
	public function test_load_session_records_of_nothing_reads_nothing(): void {
		$this->assertSame( [], Command_Auth::load_session_records( [] ) );
	}

	/** A read the store refused is not an answer, never an empty directory. */
	public function test_load_session_records_throws_when_the_store_refuses_the_read(): void {
		$handle                    = Command_Auth::mint_session( Capabilities::READ, self::TTL )['handle'];
		$this->db->deny['SELECT cache_key'] = 'Lost connection 4817';

		$this->expectException( Session_Store_Unavailable::class );
		$this->expectExceptionMessage( 'could not read the session store: wpdb wp_newspack_nodes_table: [0] Lost connection 4817' );
		Command_Auth::load_session_records( [ $handle ] );
	}

	/**
	 * A row a mint writes carries its label and when it was minted; a row
	 * lacking either is not a session, whatever its key and scope.
	 */
	public function test_a_row_without_its_label_or_created_is_not_a_session(): void {
		$full = [ 'k' => \str_repeat( 'b', 64 ), 's' => Capabilities::TUNE, 'u' => 7731, 'l' => 'weka-7731', 'c' => 1790001234 ];
		$handles = [];
		foreach ( [ 'l', 'c' ] as $i => $drop ) {
			$handle = \str_repeat( (string) ( $i + 1 ), 32 );
			$row    = $full;
			unset( $row[ $drop ] );
			$this->seed( $handle, $row );
			$handles[] = $handle;
		}
		$this->seed( \str_repeat( 'c', 32 ), $full );

		$this->assertSame( [ \str_repeat( 'c', 32 ) ], \array_keys( Command_Auth::load_session_records( [ ...$handles, \str_repeat( 'c', 32 ) ] ) ) );
		$this->assertNull( Command_Auth::load_session_record( $handles[0] ) );
	}

	/**
	 * A revoked handle stops verifying at once — that is the whole point of
	 * revocation — so it must drop out of the liveness answer too.
	 */
	public function test_a_revoked_handle_is_no_longer_live(): void {
		$handle = Command_Auth::mint_session( Capabilities::READ, self::TTL )['handle'];
		$this->assertTrue( Command_Auth::revoke_session( $handle ) );
		$this->assertFalse( Command_Auth::revoke_session( $handle ), 'a second revoke finds nothing' );

		$this->assertSame( [], Command_Auth::load_session_records( [ $handle ] ) );
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

	/** Open a grant for GRANT_USER on `$resource` named GRANT_NAME, answering its id. */
	private static function open_grant( string $scope = Capabilities::TUNE, string $resource = self::RESOURCE ): string {
		return Oauth_Store::open_grant(
			[
				'client'   => 'c0ffee00c0ffee00c0ffee00c0ffee00',
				'user'     => self::GRANT_USER,
				'scope'    => $scope,
				'resource' => $resource,
				'name'     => self::GRANT_NAME,
			]
		)['grant'];
	}

	/** @return list<string> The session handles the store holds, OAuth rows aside. */
	private function session_handles(): array {
		return \array_values( \array_filter( \array_map( 'strval', \array_keys( $this->rows() ) ), static fn ( string $key ): bool => ! \str_starts_with( $key, 'oauth:' ) ) );
	}

	/** A grant session spends the grant's user, scope, resource and name, not the current user's. */
	public function test_a_grant_session_carries_its_grant_and_resource(): void {
		$GLOBALS['_wp_test_current_user_id'] = 1;
		Core::$clock = static fn (): float => 1790004242.0;
		$grant       = self::open_grant();

		$session = Command_Auth::mint_grant_session( $grant );

		$this->assertSame(
			[ 'key' => $session['secret'], 'scope' => Capabilities::TUNE, 'user' => self::GRANT_USER, 'ttl' => Command_Auth::SESSION_TTL_S, 'label' => self::GRANT_NAME, 'created' => 1790004242, 'grant' => $grant, 'resource' => self::RESOURCE ],
			Command_Auth::load_session_record( $session['handle'] )
		);
		$this->assertSame( [ 'k', 's', 'u', 'l', 'c', 'g', 'r' ], \array_keys( Core::arr( $this->store()->lookup( $session['handle'] ) ) ) );
		$this->assertSame( [ $session['handle'] => 1 ], Command_Auth::session_members( "oauth:grant-sessions:{$grant}" ), 'revoking the grant reaches it' );
	}

	public function test_a_hand_minted_session_names_no_resource_and_admits_any(): void {
		$record = Command_Auth::load_session_record( Command_Auth::mint_session( Capabilities::TUNE, self::TTL, 'kea-4242' )['handle'] );

		$this->assertNotNull( $record );
		$this->assertArrayNotHasKey( 'grant', $record );
		$this->assertArrayNotHasKey( 'resource', $record );
		$this->assertTrue( Command_Auth::admits_resource( $record, self::RESOURCE ) );
		$this->assertTrue( Command_Auth::admits_resource( $record, self::ELSEWHERE ) );
	}

	public function test_admits_resource_refuses_another_resource(): void {
		$record = Command_Auth::load_session_record( Command_Auth::mint_grant_session( self::open_grant( Capabilities::READ ) )['handle'] );

		$this->assertNotNull( $record );
		$this->assertTrue( Command_Auth::admits_resource( $record, self::RESOURCE ) );
		$this->assertFalse( Command_Auth::admits_resource( $record, self::ELSEWHERE ) );
		$this->assertFalse( Command_Auth::admits_resource( $record, self::RESOURCE . '/' ), 'exactly the resource, nothing like it' );
	}

	/** @return array<string,array{\Closure(): \Closure}> Each substrate verifier, built fresh. */
	public static function substrate_verifiers(): array {
		return [
			'verifier'       => [ static fn (): \Closure => Command_Auth::verifier() ],
			'batch_verifier' => [ static fn (): \Closure => Command_Auth::batch_verifier() ],
		];
	}

	/**
	 * The reply an interpreter guarded by `$authorize` answers to an `uptime`
	 * signed for `$destination`.
	 *
	 * @return array{0:int,1:mixed} The reply's TYPE and VALUE.
	 */
	private function reply_under( \Closure $authorize, string $destination ): array {
		$sink        = new Capture_Sink_Node();
		$interpreter = new \Newspack_Nodes\Command_Interpreter_Node();
		$interpreter->name( "door-{$destination}" );
		$interpreter->sink( $sink );
		$interpreter->authorize = $authorize;

		$m                       = Message::new_message();
		$m[ Message::TYPE ]      = Message::TM_COMMAND;
		$m[ Message::FROM ]      = '_http';
		$m[ Message::TIMESTAMP ] = (int) Core::right_now();
		$m[ Message::VALUE ]     = [ 'name' => 'uptime', 'arguments' => [] ];
		Command_Auth::sign_for( $destination, $m );
		$interpreter->fill( $m );

		$this->assertCount( 1, $sink->captured, 'one reply' );
		return [ $sink->captured[0][ Message::TYPE ], $sink->captured[0][ Message::VALUE ] ];
	}

	/**
	 * A grant session belongs to the resource it was issued for, and no
	 * substrate door is that resource: its key signs nothing here, and the
	 * refusal reads exactly as a wrong key's does, so it is no oracle.
	 */
	#[DataProvider( 'substrate_verifiers' )]
	public function test_a_grant_session_is_refused_at_a_substrate_verifier_as_a_wrong_key_is( \Closure $verifier ): void {
		Core::$clock = static fn (): float => 1790007746.0;
		$grant       = Command_Auth::mint_grant_session( self::open_grant( Capabilities::TUNE, self::KEA_MCP ) );
		$hand        = Command_Auth::mint_session( Capabilities::TUNE, self::TTL, 'kea-4242' );
		Command_Auth::remember_session( 'kea-grant', $grant['handle'], $grant['secret'] );
		Command_Auth::remember_session( 'kea-wrong', $hand['handle'], self::OTHER );
		Command_Auth::remember_session( 'kea-hand', $hand['handle'], $hand['secret'] );

		$refused = $this->reply_under( $verifier(), 'kea-grant' );

		$this->assertSame( [ Message::TM_COMMAND | Message::TM_ERROR, [ 'name' => 'uptime', 'arguments' => [], 'payload' => "unauthorized: uptime\n" ] ], $refused );
		$this->assertSame( $this->reply_under( $verifier(), 'kea-wrong' ), $refused, 'no oracle' );
		$this->assertSame( Message::TM_COMMAND | Message::TM_RESPONSE, $this->reply_under( $verifier(), 'kea-hand' )[0], 'a hand-issued session still signs' );
	}

	/** `verify()` refuses the grant session and closes the ceiling, as for a wrong key. */
	public function test_verify_refuses_a_grant_session_and_closes_the_ceiling(): void {
		$grant = Command_Auth::mint_grant_session( self::open_grant( Capabilities::TUNE, self::KEA_MCP ) );
		Command_Auth::remember_session( 'kea-grant', $grant['handle'], $grant['secret'] );
		$m = $this->command();
		Command_Auth::sign_for( 'kea-grant', $m );
		Capabilities::$session_scope = Capabilities::TUNE;

		$this->assertFalse( Command_Auth::verify( $m, 1000, 1000 ) );
		$this->assertSame( Capabilities::NONE, Capabilities::$session_scope );
	}

	/** An empty grant or resource column binds nothing, as a hand mint's absence does. */
	public function test_an_empty_grant_or_resource_column_is_not_read(): void {
		$this->seed( '77460000000000000000000000000001', [ 'k' => self::KEY, 's' => 'read', 'u' => 0, 'l' => '', 'c' => 1000, 'g' => '', 'r' => '' ] );

		$record = Command_Auth::load_session_record( '77460000000000000000000000000001' );

		$this->assertNotNull( $record );
		$this->assertSame( [ 'key', 'scope', 'user', 'ttl', 'label', 'created' ], \array_keys( $record ) );
	}

	/** No grant session outlives its grant, nor the index revoking the grant reaches. */
	public function test_a_grant_sessions_life_is_clamped_to_what_its_grant_has_left(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$grant       = self::open_grant();
		Core::$clock = static fn (): float => 1790000000.0 + 30 * DAY_IN_SECONDS - 1234;

		$session = Command_Auth::mint_grant_session( $grant );

		$this->assertSame( 1234, $session['expires_in'] );
		$this->assertSame( 1234, Command_Auth::load_session_record( $session['handle'] )['ttl'] ?? null );
	}

	public function test_a_grant_with_no_life_left_refuses_to_mint(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$grant       = self::open_grant();
		Core::$clock = static fn (): float => 1790000000.0 + 30 * DAY_IN_SECONDS;

		try {
			Command_Auth::mint_grant_session( $grant );
			$this->fail( 'a lapsed grant mints nothing' );
		} catch ( \RuntimeException $e ) {
			$this->assertNotInstanceOf( Session_Store_Unavailable::class, $e );
			$this->assertSame( "no live grant {$grant}; no session was minted for it", $e->getMessage() );
		}
		$this->assertSame( [], $this->session_handles() );
	}

	/** A grant never opened mints nothing, so nothing is written or revoked. */
	public function test_a_grant_never_opened_refuses_to_mint_and_writes_nothing(): void {
		Command_Auth::session_table();
		$before = \count( $this->db->sent );

		try {
			Command_Auth::mint_grant_session( '77467746774677467746774677467746' );
			$this->fail( 'a grant no approval opened mints nothing' );
		} catch ( \RuntimeException $e ) {
			$this->assertNotInstanceOf( Session_Store_Unavailable::class, $e );
			$this->assertSame( 'no live grant 77467746774677467746774677467746; no session was minted for it', $e->getMessage() );
		}
		$this->assertSame( [], \array_values( \array_filter( \array_slice( $this->db->sent, $before ), static fn ( string $sql ): bool => ! \str_starts_with( $sql, 'SELECT' ) ) ), 'only the grant is read' );
	}

	/** A grant revoked between the mint and its bind leaves no session behind. */
	public function test_a_grant_gone_before_its_bind_revokes_the_session_and_refuses(): void {
		$grant = self::open_grant();
		$this->db->before['INSERT IGNORE'] = static fn () => Oauth_Store::revoke_grant( $grant );

		try {
			Command_Auth::mint_grant_session( $grant );
			$this->fail( 'a session its grant cannot reach must not be handed back' );
		} catch ( \RuntimeException $e ) {
			$this->assertNotInstanceOf( Session_Store_Unavailable::class, $e );
			$this->assertSame( "no live grant {$grant}; no session was minted for it", $e->getMessage() );
		}
		$this->assertSame( [], $this->session_handles() );
	}

	/**
	 * A revoke landing between the bind's grant read and its member add reads
	 * the members before this session joins them, so the mint must see the
	 * grant gone itself: the session it wrote is revoked and nothing returns.
	 */
	public function test_a_grant_revoked_inside_its_bind_revokes_the_session_and_refuses(): void {
		$grant = self::open_grant();
		$this->db->before['INSERT INTO `wp_newspack_nodes_members`'] = static fn () => Oauth_Store::revoke_grant( $grant );

		try {
			Command_Auth::mint_grant_session( $grant );
			$this->fail( 'a session minted during its grant\'s revoke must not be handed back' );
		} catch ( \RuntimeException $e ) {
			$this->assertNotInstanceOf( Session_Store_Unavailable::class, $e );
			$this->assertSame( "no live grant {$grant}; no session was minted for it", $e->getMessage() );
		}
		$this->assertSame( [], $this->session_handles(), 'the minted key verifies nowhere' );
	}

	public function test_a_bind_the_store_refuses_revokes_the_session_and_raises(): void {
		$grant = self::open_grant();
		$this->db->deny['INSERT INTO `wp_newspack_nodes_members`'] = 'Deadlock found 7746';

		try {
			Command_Auth::mint_grant_session( $grant );
			$this->fail( 'an unbound session must not be handed back' );
		} catch ( Session_Store_Unavailable $e ) {
			$this->assertStringContainsString( 'Deadlock found 7746', $e->getMessage() );
		}
		$this->assertSame( [], $this->session_handles() );
	}

	/** A minted session the store cannot revoke again is named, never left silent. */
	public function test_an_unbound_session_the_store_will_not_revoke_raises(): void {
		$grant = self::open_grant();
		$this->db->before['INSERT IGNORE'] = function () use ( $grant ): void {
			Oauth_Store::revoke_grant( $grant );
			$this->db->before['SELECT'] = function (): void {
				$this->db->deny['DELETE FROM `wp_newspack_nodes_table`'] = 'Lock wait timeout 7746';
			};
		};

		try {
			Command_Auth::mint_grant_session( $grant );
			$this->fail( 'expected the store failure' );
		} catch ( Session_Store_Unavailable $e ) {
			$this->assertSame( "the session store did not answer; the session minted for grant {$grant} may still be live", $e->getMessage() );
		}
	}

	/** @return array<string,array{array<string,mixed>,string}> A grant row with one field malformed, and the field's refusal. */
	public static function malformed_grants(): array {
		$row = [
			'client'   => 'c0ffee00c0ffee00c0ffee00c0ffee00',
			'user'     => self::GRANT_USER,
			'scope'    => Capabilities::TUNE,
			'resource' => self::RESOURCE,
			'name'     => self::GRANT_NAME,
			'created'  => 1790000000,
		];
		$without = static function ( string $field ) use ( $row ): array {
			unset( $row[ $field ] );
			return $row;
		};
		return [
			'no resource'               => [ $without( 'resource' ), 'names no resource' ],
			'an empty resource'         => [ [ 'resource' => '' ] + $row, 'names no resource' ],
			'no user'                   => [ $without( 'user' ), 'names no user' ],
			'user 0'                    => [ [ 'user' => 0 ] + $row, 'names no user' ],
			'a user as a string'        => [ [ 'user' => '7746' ] + $row, 'names no user' ],
			'manage'                    => [ [ 'scope' => Capabilities::MANAGE ] + $row, 'names the scope manage; a grant holds read or tune' ],
			'a scope outside the ladder' => [ [ 'scope' => 'kea-7746' ] + $row, 'names the scope kea-7746; a grant holds read or tune' ],
		];
	}

	/**
	 * A grant row missing what the session needs refuses before anything is
	 * written: a session naming no resource would be admitted at every door.
	 *
	 * @param array<string,mixed> $row     The grant row as stored.
	 * @param string              $refusal What the refusal says of it.
	 */
	#[DataProvider( 'malformed_grants' )]
	public function test_a_malformed_grant_refuses_before_any_write( array $row, string $refusal ): void {
		$grant = '7746beef7746beef7746beef7746beef';
		$this->seed( "oauth:grant:{$grant}", $row, 30 * DAY_IN_SECONDS );
		$before = \count( $this->db->sent );

		try {
			Command_Auth::mint_grant_session( $grant );
			$this->fail( 'a malformed grant mints nothing' );
		} catch ( \RuntimeException $e ) {
			$this->assertNotInstanceOf( Session_Store_Unavailable::class, $e );
			$this->assertSame( "grant {$grant} {$refusal}; no session was minted for it", $e->getMessage() );
		}
		$this->assertSame( [], \array_values( \array_filter( \array_slice( $this->db->sent, $before ), static fn ( string $sql ): bool => ! \str_starts_with( $sql, 'SELECT' ) ) ), 'only the grant is read' );
		$this->assertSame( [], $this->session_handles() );
	}

	public function test_oauth_grants_read_and_tune(): void {
		$this->assertSame( [ Capabilities::READ, Capabilities::TUNE ], Oauth_Store::SCOPES );
	}

	/** A row not shaped as a mint writes it verifies nothing; it is not a session. */
	public function test_a_row_in_any_other_shape_is_not_a_session(): void {
		$this->seed( '88230000000000000000000000000001', [ 's' => 'read', 'u' => 0 ] );
		$this->seed( '88250000000000000000000000000002', [ 'k' => self::KEY, 'u' => 0 ] );
		$this->seed( '88270000000000000000000000000003', self::KEY );
		foreach ( [ '88230000000000000000000000000001', '88250000000000000000000000000002', '88270000000000000000000000000003' ] as $handle ) {
			$this->assertNull( Command_Auth::load_session_record( $handle ), $handle );
		}
	}
}
