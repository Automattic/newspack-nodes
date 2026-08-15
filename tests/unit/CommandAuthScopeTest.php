<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * A session carries a SCOPE, and verifying under it lowers the request's
 * capability ceiling for exactly as long as that command is being handled.
 */
#[CoversClass( Command_Auth::class )]
class CommandAuthScopeTest extends TestCase {

	private const LEGACY_HANDLE = 'beef0011223344556677889900aabbcc';
	private const LEGACY_KEY    = 'legacy-bare-string-key-7319-7319-73';

	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
		Command_Auth::$claim_nonce = static fn ( string $nonce, int $ttl ): bool => true;
	}

	protected function tearDown(): void {
		Command_Auth::$claim_nonce   = null;
		Cache_Backend::$apcu_usable  = static fn (): bool => false;
		Capabilities::$session_scope = null;
		Core::$memd                  = $this->prev_memd;
		parent::tearDown();
	}

	private function command(): array {
		$m                       = Message::new_message();
		$m[ Message::TYPE ]      = Message::TM_COMMAND;
		$m[ Message::VALUE ]     = [ 'name' => 'overview', 'arguments' => [] ];
		$m[ Message::TIMESTAMP ] = 1000;
		return $m;
	}

	public function test_a_minted_session_remembers_the_scope_it_was_asked_for(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE );

		$this->assertSame( Capabilities::TUNE, $session['scope'] );
		$this->assertSame( Capabilities::TUNE, ( Command_Auth::load_session_record( $session['handle'] )['scope'] ?? null ) );
		$this->assertSame( $session['key'], Command_Auth::load_session_record( $session['handle'] )['key'] );
	}

	public function test_a_session_minted_without_a_scope_is_unrestricted(): void {
		$session = Command_Auth::mint_session();

		$this->assertSame( Capabilities::MANAGE, $session['scope'] );
	}

	public function test_an_unknown_scope_is_refused_at_the_mint(): void {
		$this->expectException( \InvalidArgumentException::class );
		Command_Auth::mint_session( 'wizard' );
	}

	public function test_verifying_a_scoped_command_lowers_the_ceiling(): void {
		$session = Command_Auth::mint_session( Capabilities::READ );
		Command_Auth::remember_session( 'agent', $session['handle'], $session['key'] );

		$m = $this->command();
		Command_Auth::sign_for( 'agent', $m );

		$this->assertTrue( Command_Auth::verify( $m, 1000 ) );
		$this->assertSame( Capabilities::READ, Capabilities::$session_scope );
	}

	public function test_verifying_a_secret_signed_command_clears_a_stale_ceiling(): void {
		Capabilities::$session_scope = Capabilities::READ;

		$m = $this->command();
		Command_Auth::sign( $m );

		$this->assertTrue( Command_Auth::verify( $m, 1000 ) );
		$this->assertNull(
			Capabilities::$session_scope,
			'a per-site-secret command carries the minter authority, not the last session'
		);
	}

	public function test_a_bad_signature_closes_the_ceiling_completely(): void {
		Capabilities::$session_scope = Capabilities::MANAGE;
		$session = Command_Auth::mint_session( Capabilities::TUNE );
		Command_Auth::remember_session( 'agent', $session['handle'], $session['key'] );

		$m = $this->command();
		Command_Auth::sign_for( 'agent', $m );
		$value                = $m[ Message::VALUE ];
		$value['auth']['sig'] = \str_repeat( '0', 64 );
		$m[ Message::VALUE ]  = $value;

		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
		$this->assertSame(
			Capabilities::NONE,
			Capabilities::$session_scope,
			'a refusal must never leave a usable ceiling behind, whatever stood before'
		);
	}

	public function test_an_unresolvable_handle_closes_the_ceiling_completely(): void {
		Capabilities::$session_scope = Capabilities::MANAGE;

		$m = $this->command();
		Command_Auth::sign( $m );
		$value                   = $m[ Message::VALUE ];
		$value['auth']['handle'] = 'deadbeefdeadbeefdeadbeefdeadbeef';
		$m[ Message::VALUE ]     = $value;

		$this->assertFalse( Command_Auth::verify( $m, 1000 ) );
		$this->assertSame( Capabilities::NONE, Capabilities::$session_scope );
		$this->assertFalse( Capabilities::scope_covers( Capabilities::NONE, Capabilities::READ ) );
	}

	public function test_a_revoked_session_stops_verifying(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE );
		Command_Auth::remember_session( 'agent', $session['handle'], $session['key'] );

		$m = $this->command();
		Command_Auth::sign_for( 'agent', $m );
		$this->assertTrue( Command_Auth::verify( $m, 1000 ) );

		Command_Auth::revoke_session( $session['handle'] );

		$again = $this->command();
		Command_Auth::sign_for( 'agent', $again );
		$this->assertFalse( Command_Auth::verify( $again, 1000 ) );
	}

	/**
	 * Sessions live in a cache with an hour's TTL, so a deploy that changes the
	 * record shape meets live entries written by the previous one. The bare
	 * string was unrestricted; it must keep resolving as such.
	 */
	public function test_a_pre_scope_record_still_resolves_and_is_unrestricted(): void {
		$address = ( new \ReflectionMethod( Command_Auth::class, 'session_address' ) )
			->invoke( null, self::LEGACY_HANDLE );
		Core::$memd->add( $address, self::LEGACY_KEY, 600 );

		$this->assertSame( self::LEGACY_KEY, Command_Auth::load_session_record( self::LEGACY_HANDLE )['key'] );
		$this->assertSame( Capabilities::MANAGE, ( Command_Auth::load_session_record( self::LEGACY_HANDLE )['scope'] ?? null ) );
	}
}
