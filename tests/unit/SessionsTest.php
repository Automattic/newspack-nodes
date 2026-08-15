<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Sessions;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

/**
 * The session DIRECTORY. Cache stores do not enumerate, so the option holds
 * what exists and the cache stays the authority on what is still alive — the
 * same pointer-versus-lease split SSE_Slot_Pool uses.
 */
#[CoversClass( Sessions::class )]
class SessionsTest extends TestCase {

	private ?\Memcached $prev_memd = null;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
	}

	protected function tearDown(): void {
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		Core::$memd                 = $this->prev_memd;
		\delete_option( Sessions::OPTION );
		parent::tearDown();
	}

	public function test_a_recorded_session_lists_live_and_without_its_key(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE, 900 );
		Sessions::record( $session['handle'], Capabilities::TUNE, 'reporting bot', 900 );

		$rows = Sessions::all();
		$row  = $rows[ $session['handle'] ];

		$this->assertTrue( $row['live'] );
		$this->assertSame( 'reporting bot', $row['label'] );
		$this->assertSame( Capabilities::TUNE, $row['scope'] );
		$this->assertGreaterThan( $row['created'], $row['expires'] );
		$this->assertStringNotContainsString(
			$session['key'],
			(string) \wp_json_encode( $rows ),
			'the directory must never carry the signing key'
		);
	}

	public function test_a_row_whose_lease_is_gone_reads_as_dead(): void {
		$session = Command_Auth::mint_session( Capabilities::READ, 900 );
		Sessions::record( $session['handle'], Capabilities::READ, 'expiring', 900 );
		Command_Auth::revoke_session( $session['handle'] );

		$this->assertFalse( Sessions::all()[ $session['handle'] ]['live'] );
	}

	public function test_forget_revokes_the_key_and_drops_the_row(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE, 900 );
		Sessions::record( $session['handle'], Capabilities::TUNE, 'doomed', 900 );

		Sessions::forget( $session['handle'] );

		$this->assertArrayNotHasKey( $session['handle'], Sessions::all() );
		$this->assertNull(
			( Command_Auth::load_session_record( $session['handle'] )['key'] ?? null ),
			'revoking must take the lease with it, or the key keeps verifying'
		);
	}

	public function test_expired_rows_are_pruned_on_the_next_record(): void {
		\update_option(
			Sessions::OPTION,
			[
				'ancient0000000000000000000000000' => [
					'label'   => 'last week',
					'scope'   => Capabilities::READ,
					'created' => 1,
					'expires' => 2,
				],
			]
		);

		$session = Command_Auth::mint_session( Capabilities::READ, 900 );
		Sessions::record( $session['handle'], Capabilities::READ, 'fresh', 900 );

		$rows = Sessions::all();
		$this->assertArrayNotHasKey( 'ancient0000000000000000000000000', $rows );
		$this->assertArrayHasKey( $session['handle'], $rows );
	}

	public function test_the_directory_is_bounded(): void {
		for ( $i = 0; $i < Sessions::MAX_ROWS + 5; $i++ ) {
			Sessions::record( \str_pad( (string) $i, 32, 'f', \STR_PAD_LEFT ), Capabilities::READ, "s{$i}", 900 );
		}

		$this->assertCount( Sessions::MAX_ROWS, Sessions::all() );
	}

	public function test_forgetting_an_unknown_handle_is_harmless(): void {
		Sessions::forget( 'nothing-here' );
		$this->assertSame( [], Sessions::all() );
	}
}
