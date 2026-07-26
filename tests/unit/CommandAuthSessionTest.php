<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;

#[CoversClass( Command_Auth::class )]
class CommandAuthSessionTest extends TestCase {

	/** Distinct from every default: not 3600 (session), not 60 (nonce TTL). */
	private const TTL = 4242;

	private const HANDLE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

	/** Distinct from anything secret() could produce. */
	private const KEY   = 'first-key-4242-4242-4242-4242-4242';
	private const OTHER = 'second-key-9999-9999-9999-9999-99';

	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
		// Single-use claim is not what these tests exercise; keep it always-claimable.
		Command_Auth::$claim_nonce = static fn ( string $nonce, int $ttl ): bool => true;
	}

	protected function tearDown(): void {
		Command_Auth::$claim_nonce  = null;
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		Core::$memd                = $this->prev_memd;
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

	public function test_store_session_refuses_to_overwrite_a_live_handle(): void {
		$this->assertTrue( Command_Auth::store_session( self::HANDLE, self::KEY, self::TTL ) );

		$this->assertFalse(
			Command_Auth::store_session( self::HANDLE, self::OTHER, self::TTL ),
			'a second store under a live handle must fail the atomic claim'
		);
		$this->assertSame(
			self::KEY,
			Command_Auth::load_session( self::HANDLE ),
			'the losing store must leave the original key intact'
		);
	}

	public function test_load_session_returns_null_for_an_unknown_handle(): void {
		$this->assertNull(
			Command_Auth::load_session( 'ffffffffffffffffffffffffffffffff' ),
			'a miss must be null, never false or a default'
		);
	}

	public function test_load_session_returns_null_when_no_store_is_available(): void {
		Core::$memd = null;
		$this->assertNull( Command_Auth::load_session( self::HANDLE ) );
	}

	public function test_store_session_fails_closed_when_no_store_is_available(): void {
		Core::$memd = null;
		$this->assertFalse( Command_Auth::store_session( self::HANDLE, self::KEY, self::TTL ) );
	}

	public function test_mint_session_returns_a_key_that_resolves_by_its_handle(): void {
		$session = Command_Auth::mint_session();

		$this->assertSame(
			$session['key'],
			Command_Auth::load_session( $session['handle'] ),
			'the returned key must be the one that was persisted'
		);
		$this->assertSame( Command_Auth::SESSION_TTL_S, $session['expires_in'] );
	}

	public function test_mint_session_never_repeats_a_handle_or_a_key(): void {
		$first  = Command_Auth::mint_session();
		$second = Command_Auth::mint_session();

		$this->assertNotSame( $first['handle'], $second['handle'] );
		$this->assertNotSame( $first['key'], $second['key'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{32}$/', $first['handle'] );
		$this->assertMatchesRegularExpression( '/^[0-9a-f]{64}$/', $first['key'] );
	}

	public function test_mint_session_throws_rather_than_hand_back_an_unstored_key(): void {
		Core::$memd = null;

		$this->expectException( \RuntimeException::class );
		Command_Auth::mint_session();
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
		Command_Auth::remember_session( 'spoke-a', $session['handle'], $session['key'] );

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
		Command_Auth::remember_session( 'spoke-a', $a['handle'], $a['key'] );
		Command_Auth::remember_session( 'spoke-b', $b['handle'], $b['key'] );

		$m = $this->command();
		Command_Auth::sign_for( 'spoke-a', $m );

		$value                   = $m[ Message::VALUE ];
		$value['auth']['handle'] = $b['handle'];
		$m[ Message::VALUE ]     = $value;

		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
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
		Command_Auth::remember_session( 'spoke-a', $session['handle'], $session['key'] );

		$m = $this->command();
		Command_Auth::sign_for( 'spoke-a', $m );

		$value = $m[ Message::VALUE ];
		unset( $value['auth']['handle'] );
		$m[ Message::VALUE ] = $value;

		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
	}

	/**
	 * The cache is not a trusted store. Anything that can write memcached could
	 * plant a key at a guessable address; the session namespace must be derived
	 * from the site secret so a foreign entry never resolves here.
	 */
	public function test_a_key_planted_at_the_bare_address_does_not_resolve(): void {
		Core::$memd->add( 'nodes-cmd-session:' . self::HANDLE, 'planted-key-4242', self::TTL );

		$this->assertNull( Command_Auth::load_session( self::HANDLE ) );
	}

	/**
	 * Sessions must never land in per-host APCu: the verifier is usually a worker
	 * or another host. Refusing loudly beats minting a key that resolves nowhere.
	 */
	public function test_session_storage_refuses_the_per_host_tier(): void {
		Core::$memd = null;
		Cache_Backend::$apcu_usable = static fn (): bool => true;

		$this->assertFalse( Command_Auth::store_session( self::HANDLE, self::KEY, self::TTL ) );
	}

	public function test_remember_session_rejects_empty_required_inputs(): void {
		$this->expectException( \InvalidArgumentException::class );
		Command_Auth::remember_session( 'spoke-a', '', self::KEY );
	}

	/**
	 * ID is the originator's opaque continuation token — Tachikoma's Shell3 keys
	 * its pipe stages on it. The substrate must never read or write it, and the
	 * temptation is to reuse it as the session handle.
	 */
	public function test_signing_never_touches_the_originators_id(): void {
		$session = Command_Auth::mint_session();
		Command_Auth::remember_session( 'spoke-a', $session['handle'], $session['key'] );

		$m                 = $this->command();
		$m[ Message::ID ]  = 'continuation-7';
		Command_Auth::sign_for( 'spoke-a', $m );

		$this->assertSame( 'continuation-7', $m[ Message::ID ] );
		$this->assertNotSame( $session['handle'], $m[ Message::ID ] );
	}
}
