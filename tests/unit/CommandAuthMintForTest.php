<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\TestCase;

/**
 * One signed mint per destination (ADR-15): a session with the spoke the
 * egress speaks for, or a handshake asked for and nothing minted; then the
 * command, signed under that spoke's key, for the caller to fill.
 */
#[CoversClass( Command_Auth::class )]
class CommandAuthMintForTest extends TestCase {

	private const HANDLE = 'c4c4d5d5e6e6f7f7a8a8b9b9c0c0d1d1';

	protected function tearDown(): void {
		Command_Auth::forget_session( 'tapir-2' );
		Event_Framework::$curl_dispatch = null;
		parent::tearDown();
	}

	/** Count the `/auth` handshakes an egress starts, without any real HTTP. */
	private function count_handshakes( int &$posts ): void {
		Event_Framework::$curl_dispatch = static function ( array $opts ) use ( &$posts ): \CurlHandle {
			++$posts;
			// phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_init
			return \curl_init();
		};
	}

	public function test_mint_for_answers_a_command_signed_for_the_egress_spoke(): void {
		$egress = $this->egress( 'spokes:tapir', 'tapir-2' );
		Command_Auth::remember_session( 'tapir-2', self::HANDLE, 'key-tapir-5150' );

		$out = Command_Auth::mint_for( $egress, 'pull:okapi:kea.p0', 'raw-logs', 'read_message', [ 'kea.p0', '7:41' ] );

		$this->assertIsArray( $out );
		$this->assertSame( Message::TM_COMMAND, $out[ Message::TYPE ] );
		$this->assertSame( 'pull:okapi:kea.p0', $out[ Message::FROM ] );
		$this->assertSame( 'raw-logs', $out[ Message::TO ] );
		$this->assertSame( 'read_message', $out[ Message::VALUE ]['name'] );
		$this->assertSame( [ 'kea.p0', '7:41' ], $out[ Message::VALUE ]['arguments'] );
		$this->assertSame( self::HANDLE, $out[ Message::VALUE ]['auth']['handle'] );
	}

	public function test_mint_for_with_no_session_asks_for_one_and_mints_nothing(): void {
		$this->seed_vault_servers( [ 'tapir-2' => [ 'url' => 'https://tapir.example' ] ] );
		$egress = $this->egress( 'spokes:tapir', 'tapir-2' );
		$posts  = 0;
		$this->count_handshakes( $posts );

		$this->assertNull( Command_Auth::mint_for( $egress, 'pull:okapi', 'workers', 'heartbeat', [ '3', '9' ] ), 'unsigned, so nothing may be minted' );
		$this->assertGreaterThan( 0, $posts, 'a minter that cannot sign asks for the handshake' );
	}
}
