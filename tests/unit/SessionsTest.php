<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Core;
use Newspack_Nodes\Session_Store_Unavailable;
use Newspack_Nodes\Sessions;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\Helpers\Sqlite_Wpdb;
use Newspack_Nodes\Tests\TestCase;

/**
 * The labelled-session listing. A session's row carries its label and when
 * it was minted, and a labelled session's handle is a member of one set in
 * the same session Table, so the store is the one record of what was issued,
 * what each can do and how long it lives.
 */
#[CoversClass( Sessions::class )]
class SessionsTest extends TestCase {

	private ?\Memcached $prev_memd = null;

	private Sqlite_Wpdb $db;

	protected function setUp(): void {
		parent::setUp();
		$this->db        = $this->use_wpdb();
		$this->prev_memd = Core::$memd;
		Core::$memd      = new InMemoryMemcached();
	}

	protected function tearDown(): void {
		Cache_Backend::$apcu_usable = static fn (): bool => false;
		Core::$memd                 = $this->prev_memd;
		Core::$clock                = null;
		parent::tearDown();
	}

	/** @return list<array<string,mixed>> The index's member rows. */
	private function index_rows(): array {
		return $this->db->get_results( "SELECT set_key, member, expires FROM wp_newspack_nodes_members WHERE namespace = '" . Command_Auth::SESSIONS_TABLE . "'" );
	}

	/** @return array<string,array<string,mixed>> Each listed row by handle. */
	private static function listed(): array {
		return \array_column( Sessions::listing(), null, 'handle' );
	}

	public function test_an_issued_session_lists_without_its_key(): void {
		$session = Sessions::issue( 'reporting bot', Capabilities::TUNE, 900 );

		$rows = Sessions::listing();

		$this->assertSame( [ 'handle', 'label', 'scope', 'created', 'expires' ], \array_keys( $rows[0] ) );
		$this->assertSame( $session['handle'], $rows[0]['handle'] );
		$this->assertSame( 'reporting bot', $rows[0]['label'] );
		$this->assertSame( Capabilities::TUNE, $rows[0]['scope'] );
		$this->assertGreaterThan( $rows[0]['created'], $rows[0]['expires'] );
		$this->assertStringNotContainsString( $session['secret'], (string) \wp_json_encode( $rows ), 'the listing must never carry the signing key' );
	}

	/**
	 * The index is a set in the session Table: one member a labelled session,
	 * living exactly as long as the session, and no option at all.
	 */
	public function test_a_labelled_session_is_a_member_of_the_session_tables_index(): void {
		Core::$clock = static fn (): float => 1790002261.0;
		$session     = Sessions::issue( 'kereru-2261', Capabilities::TUNE, 5400 );

		$this->assertSame( [ [ 'set_key' => 'labelled', 'member' => $session['handle'], 'expires' => 1790002261 + 5400 ] ], $this->index_rows() );
		$this->assertFalse( \get_option( 'newspack_nodes_sessions' ), 'no option holds a directory' );
	}

	/** A listing is two statements, the index then the rows, however many it lists. */
	public function test_the_listing_reads_the_index_then_every_row_in_one_statement(): void {
		foreach ( [ 'kea-1', 'kea-2', 'kea-3' ] as $label ) {
			Sessions::issue( $label, Capabilities::READ, 900 );
		}
		$before = \count( $this->db->sent );

		$this->assertCount( 3, Sessions::listing() );
		$sent = \array_slice( $this->db->sent, $before );
		$this->assertCount( 2, $sent );
		$this->assertStringContainsString( 'FROM `wp_newspack_nodes_members`', $sent[0] );
		$this->assertStringContainsString( 'FROM `wp_newspack_nodes_table`', $sent[1] );
	}

	/**
	 * One copy of a session's scope and expiry: its row's. Moving the row's
	 * expiry moves what the listing says.
	 */
	public function test_the_listing_reads_scope_and_expiry_from_the_session_row(): void {
		$session = Sessions::issue( 'kea-5151', Capabilities::TUNE, 900 );
		Command_Auth::session_table()->touch( $session['handle'], 5151 );

		$row = Sessions::listing()[0];

		$this->assertSame( Capabilities::TUNE, $row['scope'] );
		$this->assertEqualsWithDelta( \time() + 5151, $row['expires'], 2, 'the row\'s moved expiry' );
	}

	public function test_a_revoked_session_leaves_the_listing_and_stops_verifying(): void {
		$session = Sessions::issue( 'doomed', Capabilities::TUNE, 900 );

		Sessions::revoke( $session['handle'] );

		$this->assertArrayNotHasKey( $session['handle'], self::listed() );
		$this->assertNull( Command_Auth::load_session_record( $session['handle'] ), 'revoking must take the row with it, or the key keeps verifying' );
	}

	/** Flushing the session Table empties the index with the rows: nothing is left to list. */
	public function test_a_flushed_session_table_leaves_no_index_behind(): void {
		Sessions::issue( 'chris-claude', Capabilities::MANAGE, 9000 );

		Command_Auth::session_table()->flush();

		$this->assertSame( [], $this->index_rows() );
		$this->assertFalse( \get_option( 'newspack_nodes_sessions' ), 'no directory outlives the flush' );
		$this->assertSame( [], Sessions::listing() );
	}

	public function test_a_lapsed_session_leaves_the_listing(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$handle      = Sessions::issue( 'stale', Capabilities::MANAGE, 60 )['handle'];
		Core::$clock = static fn (): float => 1790000060.0;

		$this->assertArrayNotHasKey( $handle, self::listed() );
	}

	public function test_an_unlabelled_session_is_never_indexed(): void {
		// Auto-minted `/auth` sessions carry no label and arrive several per
		// dashboard load; listing them buries the ones issued on purpose.
		$auto  = Sessions::issue( '  ', Capabilities::MANAGE, 4200 );
		$named = Sessions::issue( 'chris-claude', Capabilities::MANAGE, 4200 );

		$this->assertSame( [ $named['handle'] ], \array_keys( self::listed() ) );
		$this->assertCount( 1, $this->index_rows() );
		$this->assertSame( $auto['secret'], Command_Auth::load_session_record( $auto['handle'] )['key'] ?? null, 'an unlisted session still works' );
	}

	public function test_the_label_is_sanitized_and_cut_to_its_cap(): void {
		Sessions::issue( '<b>kea</b> ' . \str_repeat( 'k', 90 ), Capabilities::READ, 900 );

		$this->assertSame( 'kea ' . \str_repeat( 'k', Sessions::MAX_LABEL - 4 ), Sessions::listing()[0]['label'] );
	}

	public function test_revoking_a_handle_no_session_holds_is_refused(): void {
		$bystander = Sessions::issue( 'bystander-3390', Capabilities::READ, 900 );

		try {
			Sessions::revoke( 'nsh-absent-3390' );
			$this->fail( 'expected a refusal' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'no session with handle nsh-absent-3390', $e->getMessage() );
		}
		$this->assertArrayHasKey( $bystander['handle'], self::listed(), 'a refused revoke touches no other session' );
	}

	public function test_revoking_a_label_names_its_handles_newest_first_and_revokes_none(): void {
		Core::$clock = static fn (): float => 1790003390.0;
		$older       = Sessions::issue( 'kaka-3390', Capabilities::READ, 900 );
		Sessions::issue( 'pukeko-3390', Capabilities::READ, 900 );
		Core::$clock = static fn (): float => 1790003391.0;
		$newer       = Sessions::issue( 'kaka-3390', Capabilities::TUNE, 900 );

		try {
			Sessions::revoke( 'kaka-3390' );
			$this->fail( 'expected a refusal' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( "no session with handle kaka-3390; the label kaka-3390 names {$newer['handle']}, {$older['handle']}", $e->getMessage() );
		}
		$this->assertArrayHasKey( $older['handle'], self::listed() );
		$this->assertArrayHasKey( $newer['handle'], self::listed() );
	}

	public function test_revoke_drops_an_unlisted_live_session(): void {
		$session = Sessions::issue( '', Capabilities::READ, 900 );

		Sessions::revoke( $session['handle'] );
		$this->assertNull( Command_Auth::load_session_record( $session['handle'] ) );
	}

	public function test_revoke_is_refused_when_the_store_did_not_answer(): void {
		$session = Sessions::issue( 'weka-7718', Capabilities::TUNE, 900 );
		$this->db->deny['DELETE FROM `wp_newspack_nodes_table`'] = 'Lock wait timeout 7718';

		try {
			Sessions::revoke( $session['handle'] );
			$this->fail( 'expected a refusal' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( "session store did not answer; {$session['handle']} may still be live", $e->getMessage() );
		}
		$this->assertArrayHasKey( $session['handle'], self::listed(), 'the row stays while the key may still verify' );
	}

	public function test_issue_mints_the_session_it_lists(): void {
		$session = Sessions::issue( 'kereru-2261', Capabilities::TUNE, 5400 );

		$record = Command_Auth::load_session_record( $session['handle'] );
		$this->assertSame( $session['secret'], $record['key'] ?? null );
		$this->assertSame( Capabilities::TUNE, $record['scope'] ?? null );
		$this->assertSame( 5400, $session['expires_in'] );
		$row = self::listed()[ $session['handle'] ];
		$this->assertSame( 'kereru-2261', $row['label'] );
		$this->assertEqualsWithDelta( \time() + 5400, $row['expires'], 5 );
	}

	public function test_issue_lists_nothing_the_store_refused(): void {
		$this->db->deny['INSERT IGNORE'] = 'Deadlock found 2261';

		try {
			Sessions::issue( 'outage-2261', Capabilities::READ, 900 );
			$this->fail( 'expected the store refusal' );
		} catch ( Session_Store_Unavailable $e ) {
			$this->assertStringContainsString( 'Deadlock found 2261', $e->getMessage() );
		}
		$this->assertSame( [], Sessions::listing() );
	}

	/** A session the index refused is revoked before the refusal: no live key goes unlisted. */
	public function test_an_index_refusal_revokes_the_session_it_minted(): void {
		$this->db->deny['INSERT INTO `wp_newspack_nodes_members`'] = 'Deadlock found 6613';

		try {
			Sessions::issue( 'tui-6613', Capabilities::READ, 900 );
			$this->fail( 'expected the index refusal' );
		} catch ( Session_Store_Unavailable $e ) {
			$this->assertSame( 'could not index the session: wpdb wp_newspack_nodes_table: Deadlock found 6613', $e->getMessage() );
		}
		$this->assertSame( [], $this->db->get_results( "SELECT cache_key FROM wp_newspack_nodes_table WHERE namespace = 'nodes-sessions'" ) );
	}

	/** Past the index read's ceiling the listing refuses by name, never answers a part. */
	public function test_an_index_past_the_members_limit_refuses_the_listing(): void {
		Sessions::issue( 'huia-9001', Capabilities::READ, 900 );
		$this->db->canned['FROM `wp_newspack_nodes_members`'] = \array_map( static fn ( int $n ): array => [ 'member' => "m-{$n}", 'value' => '', 'expires' => 1999999999 ], \range( 0, Table_Node::MAX_MEMBERS_LIMIT ) );

		$this->expectException( Session_Store_Unavailable::class );
		$this->expectExceptionMessage( 'more than 10000 labelled sessions are indexed; `wp nodes tables flush nodes-sessions` revokes every session' );
		Sessions::listing();
	}

	public function test_an_index_read_the_store_refused_throws_naming_why(): void {
		Sessions::issue( 'kokako-4471', Capabilities::READ, 900 );
		$this->db->deny['FROM `wp_newspack_nodes_members`'] = 'Lost connection 4471';

		$this->expectException( Session_Store_Unavailable::class );
		$this->expectExceptionMessage( 'could not read the session index: wpdb wp_newspack_nodes_table: Lost connection 4471' );
		Sessions::listing();
	}

	public function test_listing_is_newest_first(): void {
		Core::$clock = static fn (): float => 1790004471.0;
		$older       = Sessions::issue( 'hoiho-4471', Capabilities::READ, 900 );
		Core::$clock = static fn (): float => 1790004531.0;
		$newer       = Sessions::issue( 'takahe-4471', Capabilities::TUNE, 1800 );

		$listing = Sessions::listing();

		$this->assertSame( [ $newer['handle'], $older['handle'] ], \array_column( $listing, 'handle' ) );
		$this->assertSame( [ 1790004531, 1790004471 ], \array_column( $listing, 'created' ) );
		$this->assertSame( [ 1790004531 + 1800, 1790004471 + 900 ], \array_column( $listing, 'expires' ) );
	}
}
