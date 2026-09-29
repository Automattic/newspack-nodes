<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Cache_Backend;
use Newspack_Nodes\Core;
use Newspack_Nodes\Durable_Arm;
use Newspack_Nodes\Tests\Helpers\Sqlite_Wpdb;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Wpdb_Arm;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Wpdb_Arm::class )]
#[CoversClass( Durable_Arm::class )]
final class WpdbArmTest extends TestCase {
	private mixed $prev_wpdb = null;
	private Sqlite_Wpdb $db;

	protected function setUp(): void {
		parent::setUp();
		$this->prev_wpdb       = $GLOBALS['wpdb'];
		$this->db              = new Sqlite_Wpdb();
		$this->db->base_prefix = 'kea7_';
		$GLOBALS['wpdb']       = $this->db;
	}

	protected function tearDown(): void {
		$GLOBALS['wpdb'] = $this->prev_wpdb;
		parent::tearDown();
	}

	/** @return list<string> The statements sent that contain `$needle`. */
	private function sent( string $needle ): array {
		return \array_values( \array_filter( $this->db->sent, static fn ( string $sql ): bool => \str_contains( $sql, $needle ) ) );
	}

	public function test_the_table_is_named_under_the_network_prefix(): void {
		$this->assertSame( 'kea7_newspack_nodes_table', Wpdb_Arm::table() );
	}

	public function test_a_failed_create_table_throws_at_construction(): void {
		$this->db->deny['CREATE TABLE'] = 'CREATE command denied';
		$this->expectExceptionMessage( 'wpdb backend could not create kea7_newspack_nodes_table: CREATE command denied' );
		new Wpdb_Arm( 'kea:p3' );
	}

	public function test_an_unreadable_packet_limit_throws_at_construction(): void {
		$this->db->deny['@@max_allowed_packet'] = 'SELECT command denied';
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'wpdb backend could not read max_allowed_packet: SELECT command denied' );
		new Wpdb_Arm( 'kea:p3' );
	}

	public function test_the_table_and_packet_limit_are_read_once_per_connection(): void {
		new Wpdb_Arm( 'kea:p3' );
		$this->db->deny['CREATE TABLE'] = 'CREATE command denied';
		new Wpdb_Arm( 'kea:p4' );
		$this->assertCount( 2, $this->sent( 'CREATE TABLE' ), 'a second arm on the same connection creates nothing' );
		$this->assertCount( 1, $this->sent( '@@max_allowed_packet' ) );

		$fresh                       = new Sqlite_Wpdb();
		$fresh->base_prefix          = 'kea7_';
		$fresh->deny['CREATE TABLE'] = 'CREATE command denied';
		$GLOBALS['wpdb']             = $fresh;
		$this->expectExceptionMessage( 'CREATE command denied' );
		new Wpdb_Arm( 'kea:p3' );
	}

	public function test_expiry_is_indexed_within_a_namespace(): void {
		new Wpdb_Arm( 'kea:p3' );
		$this->assertStringContainsString( 'KEY namespace_expires ( namespace, expires )', $this->sent( 'CREATE TABLE' )[0] );
	}

	public function test_two_namespaces_share_the_table_and_never_each_others_keys(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$p3          = new Wpdb_Arm( 'kea:p3' );
		$p4          = new Wpdb_Arm( 'kea:p4' );
		$p3->set( 'sku-41', 'p3', 37 );
		$p3->set( 'sku-43', 'p3', 0 );
		$p4->set( 'sku-43', 'p4', 37 );
		$this->assertFalse( $p4->get( 'sku-41' ) );
		$this->assertFalse( $p4->delete( 'sku-41' ) );
		$this->assertFalse( $p4->touch( 'sku-41', 777 ) );
		$this->assertSame( 'p3', $p3->get( 'sku-41' ) );
		$this->assertTrue( $p4->delete( 'sku-43' ) );
		$this->assertSame( 'p3', $p3->get( 'sku-43' ) );
		$p4->set( 'sku-47', 'p4', 37 );
		$this->assertSame( 1, $p4->purge( 1790000037, 10 ), 'a purge reclaims its own namespace alone' );
		$this->assertSame( 1, $p3->purge( 1790000037, 10 ), 'the p3 row expired alongside survived the p4 purge' );
	}

	public function test_a_namespace_no_column_can_hold_refuses_to_build(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'wpdb backend cannot hold namespace' );
		new Wpdb_Arm( \str_repeat( 'k', 192 ) );
	}

	public function test_a_namespace_holding_whitespace_refuses_to_build(): void {
		$this->expectException( \InvalidArgumentException::class );
		new Wpdb_Arm( 'kea p3' );
	}

	public function test_a_key_longer_than_its_column_is_refused_before_any_statement(): void {
		$arm   = new Wpdb_Arm( 'kea:p3' );
		$items = [];
		for ( $i = 0; $i < 600; ++$i ) {
			$items[ "sku-{$i}" ] = $i;
		}
		$items[ \str_repeat( 'k', 256 ) ] = 41;
		$this->db->sent                  = [];
		$this->assertFalse( $arm->write_multi( $items, 777 ) );
		$this->assertFalse( $arm->add( \str_repeat( 'k', 256 ), 41, 777 ) );
		$this->assertSame( [], $this->db->sent, 'nothing reached the server' );
		$this->assertStringContainsString( 'key longer than 255 bytes', $arm->last_failure() );
		$this->assertTrue( $arm->set( \str_repeat( 'k', 255 ), 43, 0 ) );
		$this->assertSame( 43, $arm->get( \str_repeat( 'k', 255 ) ) );
	}

	public function test_no_verb_opens_a_transaction_on_the_callers_connection(): void {
		$arm = new Wpdb_Arm( 'kea:p3' );
		$arm->write_multi( [ 'sku-41' => 7, 'sku-42' => 1 ], 777 );
		$arm->add( 'sku-43', 1, 777 );
		$arm->increment( 'sku-41' );
		$arm->compare_and_swap( 'sku-42', 1, 2 );
		$arm->delete( 'sku-43' );
		foreach ( [ 'START TRANSACTION', 'BEGIN', 'COMMIT', 'ROLLBACK', 'FOR UPDATE' ] as $verb ) {
			$this->assertSame( [], $this->sent( $verb ), "the arm sent {$verb}" );
		}
		$this->assertSame( [ 'sku-41' => 8, 'sku-42' => 2 ], $arm->read_multi( [ 'sku-41', 'sku-42' ] ) );
	}

	public function test_a_batch_is_cut_into_statements_that_fit_the_packet(): void {
		$this->db->max_allowed_packet = 4096;
		$arm                          = new Wpdb_Arm( 'kea:p3' );
		$items                        = [];
		for ( $i = 0; $i < 40; ++$i ) {
			$items[ "sku-{$i}" ] = \str_repeat( 'x', 300 );
		}
		$this->assertFalse( $arm->batch_is_atomic() );
		$this->assertTrue( $arm->write_multi( $items, 777 ) );
		$inserts = $this->sent( 'INSERT INTO' );
		$this->assertGreaterThan( 1, \count( $inserts ) );
		foreach ( $inserts as $sql ) {
			$this->assertLessThanOrEqual( 4096, \strlen( $sql ) );
		}
		$this->assertCount( 40, $arm->read_multi( \array_keys( $items ) ) );
	}

	public function test_a_row_too_large_for_the_packet_is_refused_before_any_statement(): void {
		$this->db->max_allowed_packet = 4096;
		$arm                          = new Wpdb_Arm( 'kea:p3' );
		$this->db->sent               = [];
		$this->assertFalse( $arm->write_multi( [ 'sku-41' => 1, 'sku-42' => \str_repeat( 'x', 5000 ) ], 777 ) );
		$this->assertFalse( $arm->add( 'sku-43', \str_repeat( 'x', 5000 ), 777 ) );
		$this->assertSame( [], $this->db->sent, 'nothing reached the server' );
		$this->assertMatchesRegularExpression( '/row of \d+ bytes cannot fit max_allowed_packet 4096/', $arm->last_failure() );
		$this->assertFalse( $arm->get( 'sku-41' ) );
	}

	public function test_a_counter_swap_updates_the_row_it_read_in_place(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$arm         = new Wpdb_Arm( 'kea:p3' );
		$arm->set( 'sku-41', 7, 777 );
		$this->db->sent = [];
		$this->assertSame( 8, $arm->increment( 'sku-41' ) );
		$this->assertCount( 2, $this->db->sent, 'one read, one conditional write' );
		$this->assertStringStartsWith( 'SELECT ', $this->db->sent[0] );
		$this->assertStringStartsWith( 'UPDATE ', $this->db->sent[1] );
		$this->assertStringContainsString( '`value` = ', \explode( 'WHERE', $this->db->sent[1] )[1], 'the write names the value it read' );
		$rows = $this->db->get_results( "SELECT expires FROM kea7_newspack_nodes_table WHERE cache_key = 'sku-41'" );
		$this->assertSame( [ [ 'expires' => 1790000777 ] ], $rows );
	}

	public function test_a_compare_and_swap_that_lost_a_race_answers_false(): void {
		$arm   = new Wpdb_Arm( 'kea:p3' );
		$other = new Wpdb_Arm( 'kea:p3' );
		$arm->set( 'sku-41', 7, 0 );
		$this->db->before['SET `value` = '] = static function () use ( $other ): void {
			$other->set( 'sku-41', 99, 0 );
		};
		$this->assertFalse( $arm->compare_and_swap( 'sku-41', 7, 43 ) );
		$this->assertSame( 99, $arm->get( 'sku-41' ), 'the concurrent write stands' );
		$this->assertCount( 1, $this->sent( 'SET `value` = ' ), 'a lost compare is an answer, never retried' );
		$this->assertSame( [ 'wpdb_error' => '' ], $arm->diagnostic_metadata(), 'nor recorded as a failure' );
	}

	public function test_an_increment_that_lost_a_race_rereads_and_lands(): void {
		$arm   = new Wpdb_Arm( 'kea:p3' );
		$other = new Wpdb_Arm( 'kea:p3' );
		$arm->set( 'sku-41', 7, 0 );
		$this->db->before['SET `value` = '] = static function () use ( $other ): void {
			$other->increment( 'sku-41' );
		};
		$this->assertSame( 9, $arm->increment( 'sku-41' ), 'both increments count' );
		$this->assertSame( 9, $arm->get( 'sku-41' ) );
	}

	public function test_a_decrement_that_lost_a_race_rereads_and_lands(): void {
		$arm   = new Wpdb_Arm( 'kea:p3' );
		$other = new Wpdb_Arm( 'kea:p3' );
		$arm->set( 'sku-41', 7, 0 );
		$this->db->before['SET `value` = '] = static function () use ( $other ): void {
			$other->decrement( 'sku-41' );
		};
		$this->assertSame( 5, $arm->decrement( 'sku-41' ) );
		$this->assertSame( 5, $arm->get( 'sku-41' ) );
	}

	public function test_a_counter_losing_every_race_gives_up_and_names_the_contention(): void {
		$arm   = new Wpdb_Arm( 'kea:p3' );
		$other = new Wpdb_Arm( 'kea:p3' );
		$db    = $this->db;
		$arm->set( 'sku-41', 7, 0 );
		$bump = static function () use ( $other, $db, &$bump ): void {
			$other->set( 'sku-41', 100 + \count( $db->sent ), 0 );
			$db->before['SET `value` = '] = $bump;
		};
		$db->before['SET `value` = '] = $bump;
		$this->assertFalse( $arm->increment( 'sku-41' ) );
		$this->assertCount( 3, $this->sent( 'SET `value` = ' ), 'three attempts, then it gives up' );
		$this->assertSame( [ 'wpdb_error' => 'a counter lost 3 races to concurrent writers' ], $arm->diagnostic_metadata(), 'the contention is named, never the key' );
	}

	public function test_a_refused_swap_writes_nothing(): void {
		$arm = new Wpdb_Arm( 'kea:p3' );
		$arm->set( 'sku-41', 'not-a-counter', 0 );
		$this->db->sent = [];
		$this->assertFalse( $arm->increment( 'sku-41' ) );
		$this->assertSame( [], $this->sent( 'UPDATE' ) );
		$this->assertSame( 'not-a-counter', $arm->get( 'sku-41' ) );
	}

	public function test_a_swap_to_the_same_value_succeeds_without_a_write(): void {
		$arm = new Wpdb_Arm( 'kea:p3' );
		$arm->set( 'sku-41', 0, 0 );
		$arm->set( 'sku-42', 7, 0 );
		$this->db->sent = [];
		$this->assertSame( 0, $arm->decrement( 'sku-41' ) );
		$this->assertTrue( $arm->compare_and_swap( 'sku-42', 7, 7 ) );
		$this->assertSame( [], $this->sent( 'UPDATE' ), 'MySQL would count an unchanged row as no change' );
	}

	public function test_a_failed_swap_write_names_the_cause(): void {
		$arm = new Wpdb_Arm( 'kea:p3' );
		$arm->set( 'sku-41', 5, 0 );
		$this->db->deny['UPDATE'] = 'Deadlock found when trying to get lock';
		$this->assertFalse( $arm->compare_and_swap( 'sku-41', 5, 6 ) );
		$this->assertStringContainsString( 'Deadlock found', $arm->last_failure() );
		unset( $this->db->deny['UPDATE'] );
		$this->assertSame( 5, $arm->get( 'sku-41' ) );
	}

	public function test_a_failed_read_is_an_error_never_a_miss(): void {
		$arm = new Wpdb_Arm( 'kea:p3' );
		$arm->set( 'sku-41', 41, 0 );
		$this->db->deny['SELECT'] = 'Lost connection to server during query';
		$this->assertSame( Cache_Backend::READ_ERROR, $arm->read( 'sku-41' )['status'] );
		$this->assertFalse( $arm->get( 'sku-41' ) );
		$this->assertSame( [], $arm->read_multi( [ 'sku-41' ], $failed ) );
		$this->assertTrue( $failed );
		$this->assertSame( 'wpdb kea7_newspack_nodes_table: Lost connection to server during query', $arm->last_failure() );
	}

	public function test_the_failure_records_the_servers_own_text(): void {
		$arm                      = new Wpdb_Arm( 'kea:p3' );
		$this->db->deny['SELECT'] = "Table 'kea7_x' doesn't exist <here>";
		$arm->get( 'sku-41' );
		$this->assertSame( [ 'wpdb_error' => "Table 'kea7_x' doesn't exist <here>" ], $arm->diagnostic_metadata() );
	}

	public function test_every_failed_write_verb_answers_as_a_failure(): void {
		$arm = new Wpdb_Arm( 'kea:p3' );
		$arm->set( 'sku-41', 5, 777 );
		$this->db->deny['DELETE'] = 'Lock wait timeout exceeded';
		$this->db->deny['UPDATE'] = 'Lock wait timeout exceeded';
		$this->db->deny['INSERT'] = 'Lock wait timeout exceeded';
		$this->assertFalse( $arm->delete( 'sku-41' ) );
		$this->assertNull( $arm->touch( 'sku-41', 37 ), 'a touch the server did not answer is unknown, not absent' );
		$this->assertSame( 0, $arm->purge( 1790099999, 10 ) );
		$this->assertFalse( $arm->set( 'sku-42', 1, 0 ) );
		$this->assertFalse( $arm->add( 'sku-43', 1, 0 ) );
		$this->assertStringContainsString( 'Lock wait timeout exceeded', $arm->last_failure() );
	}

	public function test_a_row_no_serializer_wrote_reads_as_an_error(): void {
		$arm = new Wpdb_Arm( 'kea:p3' );
		$this->db->query( "INSERT INTO kea7_newspack_nodes_table ( namespace, cache_key, `value`, expires ) VALUES ( 'kea:p3', 'sku-99', '!!not-base64!!', 0 )" );
		$this->assertSame( Cache_Backend::READ_ERROR, $arm->read( 'sku-99' )['status'] );
		$this->assertStringContainsString( 'undecodable row', $arm->last_failure() );
	}

	public function test_vacuum_optimizes_the_table_and_throws_when_refused(): void {
		$arm = new Wpdb_Arm( 'kea:p3' );
		$arm->vacuum();
		$this->assertSame( 'OPTIMIZE TABLE `kea7_newspack_nodes_table`, `kea7_newspack_nodes_members`', \end( $this->db->sent ) );
		$this->db->deny['OPTIMIZE'] = 'INDEX command denied';
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'vacuum failed: INDEX command denied' );
		$arm->vacuum();
	}

	public function test_vacuum_throws_on_an_error_the_server_reports_as_a_row(): void {
		$arm                          = new Wpdb_Arm( 'kea:p3' );
		$this->db->canned['OPTIMIZE'] = [
			[ 'Table' => 'db.kea7_newspack_nodes_table', 'Op' => 'optimize', 'Msg_type' => 'note', 'Msg_text' => 'Table does not support optimize, doing recreate + analyze instead' ],
			[ 'Table' => 'db.kea7_newspack_nodes_table', 'Op' => 'optimize', 'Msg_type' => 'error', 'Msg_text' => 'Table is marked as crashed' ],
		];
		try {
			$arm->vacuum();
			$this->fail( 'an error row must fail the vacuum' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'vacuum failed: Table is marked as crashed', $e->getMessage() );
		}
		$this->assertStringContainsString( 'Table is marked as crashed', $arm->last_failure() );
	}

	public function test_the_arm_names_itself(): void {
		$this->assertSame( 'wpdb', ( new Wpdb_Arm( 'kea:p3' ) )->backend_name() );
	}

	public function test_outside_wordpress_the_arm_refuses_to_build(): void {
		$GLOBALS['wpdb'] = null;
		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'wpdb backend needs $wpdb' );
		new Wpdb_Arm( 'kea:p3' );
	}

	public function test_members_live_in_their_own_table_keyed_by_namespace_set_and_member(): void {
		new Wpdb_Arm( 'kea:p3' );
		$create = $this->sent( 'CREATE TABLE' );
		$this->assertCount( 2, $create );
		$this->assertStringContainsString( '`kea7_newspack_nodes_members`', $create[1] );
		$this->assertStringContainsString( 'PRIMARY KEY ( namespace, set_key, member )', $create[1] );
		$this->assertStringContainsString( 'KEY namespace_expires ( namespace, expires )', $create[1] );
	}

	public function test_a_member_read_names_one_set_and_its_limit(): void {
		$arm = new Wpdb_Arm( 'kea:p3' );
		$arm->add_members( [ 'owl:set-7' => [ [ 'm-41' => 1 ], 777 ] ] );
		$this->db->sent = [];
		$arm->members( [ 'owl:set-7', 'owl:set-9' ], 13 );
		$reads = $this->sent( 'SELECT' );
		$this->assertCount( 2, $reads );
		$this->assertStringContainsString( "WHERE namespace = 'kea:p3' AND set_key = 'owl:set-7' AND expires > ", $reads[0] );
		$this->assertStringEndsWith( 'ORDER BY member LIMIT 14', $reads[0], 'one row past the limit tells a full set from one over it' );
	}

	public function test_two_namespaces_never_see_each_others_members(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$p3          = new Wpdb_Arm( 'kea:p3' );
		$p4          = new Wpdb_Arm( 'kea:p4' );
		$p3->add_members( [ 'owl:set-7' => [ [ 'm-41' => 'p3' ], 37 ] ] );
		$p4->add_members( [ 'owl:set-7' => [ [ 'm-43' => 'p4' ], 37 ] ] );
		$this->assertSame( [ 'owl:set-7' => [ 'm-43' => 'p4' ] ], $p4->members( [ 'owl:set-7' ], 9 ) );
		$this->assertSame( 1, $p4->purge( 1790000037, 10 ), 'a purge reclaims its own namespace alone' );
		$this->assertSame( 1, $p3->purge( 1790000037, 10 ) );
	}

	public function test_a_member_add_is_cut_into_statements_that_fit_the_packet(): void {
		$this->db->max_allowed_packet = 4096;
		$arm                          = new Wpdb_Arm( 'kea:p3' );
		$members                      = [];
		for ( $i = 0; $i < 40; ++$i ) {
			$members[ "m-{$i}" ] = \str_repeat( 'x', 300 );
		}
		$this->assertTrue( $arm->add_members( [ 'owl:set-7' => [ $members, 777 ] ] ) );
		$inserts = $this->sent( 'INSERT INTO `kea7_newspack_nodes_members`' );
		$this->assertGreaterThan( 1, \count( $inserts ) );
		foreach ( $inserts as $sql ) {
			$this->assertLessThanOrEqual( 4096, \strlen( $sql ) );
		}
		$this->assertCount( 40, $arm->members( [ 'owl:set-7' ], 99 )['owl:set-7'] );
	}

	public function test_a_member_or_set_key_wider_than_its_column_is_refused_before_any_statement(): void {
		$arm            = new Wpdb_Arm( 'kea:p3' );
		$this->db->sent = [];
		$this->assertFalse( $arm->add_members( [ 'owl:set-7' => [ [ 'm-41' => 1, \str_repeat( 'm', 256 ) => 2 ], 777 ] ] ) );
		$this->assertStringContainsString( 'member longer than 255 bytes', $arm->last_failure() );
		$this->assertFalse( $arm->add_members( [ \str_repeat( 'k', 256 ) => [ [ 'm-41' => 1 ], 777 ] ] ) );
		$this->assertStringContainsString( 'key longer than 255 bytes', $arm->last_failure() );
		$this->assertSame( [], $this->db->sent, 'nothing reached the server' );
		$this->assertTrue( $arm->add_members( [ \str_repeat( 'k', 255 ) => [ [ \str_repeat( 'm', 255 ) => 3 ], 777 ] ] ) );
	}

	public function test_a_failed_member_read_is_a_failure_never_an_empty_set(): void {
		$arm                      = new Wpdb_Arm( 'kea:p3' );
		$this->db->deny['SELECT'] = 'Lost connection to server during query';
		$this->assertFalse( $arm->members( [ 'owl:set-7' ], 9 ) );
		$this->assertStringContainsString( 'Lost connection to server during query', $arm->last_failure() );
	}

	public function test_bind_refuses_a_statement_whose_values_and_placeholders_disagree(): void {
		$bind = new \ReflectionMethod( Wpdb_Arm::class, 'bind' );
		foreach ( [ [ 'SELECT %d FROM %i', [ 41, 'kea', 43 ] ], [ 'SELECT %s, %d FROM %i', [ 'kea', 41 ] ], [ "SELECT '%%s', %s FROM %i", [ 'kea', 'owl', 'emu' ] ] ] as [ $sql, $args ] ) {
			try {
				$bind->invoke( null, $this->db, $sql, $args );
				$this->fail( "bind() took {$sql}" );
			} catch ( \UnexpectedValueException $e ) {
				$this->assertStringContainsString( 'placeholders', $e->getMessage() );
			}
		}
		$this->assertSame( "SELECT '%s', 'kea' FROM `emu`", $bind->invoke( null, $this->db, "SELECT '%%s', %s FROM %i", [ 'kea', 'emu' ] ) );
	}

	public function test_a_member_row_no_serializer_wrote_fails_the_read(): void {
		$arm = new Wpdb_Arm( 'kea:p3' );
		$arm->add_members( [ 'owl:set-7' => [ [ 'm-41' => 'kea' ], 777 ] ] );
		$this->db->query( "INSERT INTO kea7_newspack_nodes_members ( namespace, set_key, member, `value`, expires ) VALUES ( 'kea:p3', 'owl:set-7', 'm-43', '!!not-base64!!', 1999999999 )" );
		$this->assertFalse( $arm->members( [ 'owl:set-7' ], 9 ) );
		$this->assertStringContainsString( 'undecodable row', $arm->last_failure() );
	}

	public function test_the_purge_takes_keyed_rows_before_members(): void {
		Core::$clock = static fn (): float => 1790000000.0;
		$arm         = new Wpdb_Arm( 'kea:p3' );
		$arm->write_multi( [ 'kea-1' => 1, 'kea-2' => 2, 'kea-3' => 3, 'kea-4' => 4, 'kea-5' => 5 ], 37 );
		$arm->add_members( [ 'owl:set-7' => [ [ 'm-1' => 1, 'm-2' => 2, 'm-3' => 3 ], 37 ] ] );
		$this->assertSame( 4, $arm->purge( 1790000037, 4 ) );
		$counts = \array_map( fn ( string $t ): int => (int) $this->db->get_results( "SELECT COUNT(*) AS n FROM kea7_newspack_nodes_{$t}" )[0]['n'], [ 'table', 'members' ] );
		$this->assertSame( [ 1, 3 ], $counts, 'a limit the keyed rows fill leaves every member' );
	}
}
