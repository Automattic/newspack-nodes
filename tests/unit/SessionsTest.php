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
		$this->use_wpdb();
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
			$session['secret'],
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
	public function test_a_lease_gone_before_its_expiry_reads_as_revoked_not_expired(): void {
		// A row whose store row went before its stated expiry lost it to a
		// revoke or to `wp nodes tables flush nodes-sessions`, not to its TTL,
		// and calling that "expired" sends an operator to look at TTLs.
		// Seeds distinct from every default: a 9000s TTL.
		$handle = Command_Auth::mint_session( Capabilities::MANAGE, 9000 )['handle'];
		Sessions::record( $handle, Capabilities::MANAGE, 'chris-claude', 9000 );

		$live = Sessions::all()[ $handle ];
		$this->assertTrue( $live['live'] );
		$this->assertSame( 'live', $live['state'] );

		// The store row goes; the directory row does not.
		( new \Newspack_Nodes\Wpdb_Arm( Command_Auth::SESSIONS_TABLE ) )->flush();

		$dead = Sessions::all()[ $handle ];
		$this->assertFalse( $dead['live'] );
		$this->assertGreaterThan( \time(), $dead['expires'], 'precondition: not yet expired' );
		$this->assertSame( 'revoked', $dead['state'], 'a lease gone early was revoked or flushed' );
	}

	public function test_a_lapsed_row_is_pruned_rather_than_labelled(): void {
		// Which is why `revoked` is the only dead state a reader can see: a row
		// past its expiry never reaches the listing at all.
		Sessions::record( 'handle-6612', Capabilities::MANAGE, 'stale', 1 );
		$rows = \get_option( Sessions::OPTION );
		$rows['handle-6612']['expires'] = \time() - 60;
		\update_option( Sessions::OPTION, $rows, false );

		$this->assertArrayNotHasKey( 'handle-6612', Sessions::all() );
	}

	public function test_an_unlabelled_session_is_never_recorded(): void {
		// Auto-minted `/auth` sessions carry no label and arrive several per
		// dashboard load. Listing them buries the ones an operator issued on
		// purpose, and the MAX_ROWS cap evicts those first.
		Sessions::record( 'handle-auto', Capabilities::MANAGE, '', 3600 );
		Sessions::record( 'handle-named', Capabilities::MANAGE, 'chris-claude', 3600 );

		$all = Sessions::all();
		$this->assertArrayNotHasKey( 'handle-auto', $all );
		$this->assertArrayHasKey( 'handle-named', $all );
	}

	public function test_forget_answers_null_when_the_store_did_not_answer(): void {
		$session = Command_Auth::mint_session( Capabilities::TUNE, 900 );
		Sessions::record( $session['handle'], Capabilities::TUNE, 'weka-7718', 900 );
		$GLOBALS['wpdb']->deny['DELETE FROM `wp_newspack_nodes_table`'] = 'Lock wait timeout 7718';

		$this->assertNull( Sessions::forget( $session['handle'] ) );
		$this->assertArrayHasKey( $session['handle'], Sessions::all(), 'the row stays while the key may still verify' );
	}

	public function test_handles_labelled_names_a_labels_sessions_newest_first(): void {
		$now = \time();
		\update_option(
			Sessions::OPTION,
			[
				'handle-older-4417' => [ 'label' => 'kowhai-3317', 'scope' => Capabilities::READ, 'created' => $now - 90, 'expires' => $now + 900 ],
				'handle-other-5521' => [ 'label' => 'pukeko-1162', 'scope' => Capabilities::READ, 'created' => $now - 60, 'expires' => $now + 900 ],
				'handle-newer-8823' => [ 'label' => 'kowhai-3317', 'scope' => Capabilities::TUNE, 'created' => $now - 30, 'expires' => $now + 900 ],
			],
			false
		);

		$this->assertSame( [ 'handle-newer-8823', 'handle-older-4417' ], Sessions::handles_labelled( 'kowhai-3317' ) );
		$this->assertSame( [], Sessions::handles_labelled( 'tui-0042' ) );
	}

	public function test_a_directory_option_that_is_not_an_array_reads_as_empty(): void {
		\update_option( Sessions::OPTION, 'not-a-directory-9931', false );

		$this->assertSame( [], Sessions::all() );
		$this->assertSame( [], Sessions::handles_labelled( 'kowhai-3317' ) );
	}
}
