<?php
/**
 * The analyzer's Table pass: what `make_node Table` declares, and the one
 * file a SQLite Table claims in the write set.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Topology_Analyzer::class )]
final class TopologyAnalyzerTablesTest extends TestCase {
	private string $stock = '';

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		Core::register_config_namespace(
			'lab',
			static fn ( string $key ): ?string => [ 'store' => 'sqlite', 'shelf' => 'wpdb' ][ $key ] ?? null
		);
		$this->stock = $this->stock_topology_dir( 'tables-stock-' );
		$this->write_tsl( 'kea-base', "make_node Table lab-7:kea kea:p{partition} 777 sqlite\nmake_node Table lab-7:owl owl:p{partition} 37\n" );
		$this->write_tsl( 'kea-lab', "include kea-base\nmake_node Echo hush-relay\n" );
		$this->write_tsl( 'kea-twin', "make_node Table lab-7:kea kea:p{partition} 777 sqlite\n" );
		$this->write_tsl( 'kea-broken', "include kea-missing\nmake_node Table lab-7:kea kea:p{partition} 777 sqlite\n" );
		$this->write_tsl( 'emu-bare', "make_node Table lab-7:emu emu:p{partition}\n" );
		$this->write_tsl( 'emu-ttl', "make_node Table lab-7:emu emu:p{partition} 37\n" );
		$this->write_tsl( 'kea-token', "make_node Table lab-7:kea kea:p{partition} 777 <lab:store>\nmake_node Table lab-7:owl owl:p{partition} 37 <lab:shelf>\n" );
		$this->write_tsl( 'crawl-a', "make_node Crawler crawl-8821 4407\n" );
		$this->write_tsl( 'crawl-b', "make_node Crawler crawl-8821 4407 crawl-g3\n" );
		$this->write_tsl( 'crawl-table', "make_node Table crawl-8821:seen crawl-8821 4407 sqlite\n" );
		$this->write_tsl( 'crawl-bare', "make_node Crawler crawl-8821\n" );
		$this->write_tsl( 'crawl-tokened', "make_node Crawler <topology>-crawl 4407\n" );
		$this->write_tsl( 'yak-token', "make_node Table lab-7:yak yak:p{partition} 37 <lab:nope>\n" );
		$this->write_tsl( 'wombat-base', "make_node Row_Table wombats-6620 Wombat\nmake_node Table lab-7:kea kea:p{partition} 777 sqlite\n" );
		$this->write_tsl( 'wombat-lab', "include wombat-base\nmake_node Row_Table numbats-4409 Numbat\n" );
		$this->write_tsl( 'wombat-bare', "make_node Row_Table wombats-6620\n" );
		$this->write_tsl( 'wombat-twin', "make_node Row_Table wombats-6620 Wombat\n" );
		$this->write_tsl( 'wombat-keyed', "make_node Table wombats-6620 wombat:p{partition} 777 sqlite\n" );
		$this->write_tsl( 'wombat-volatile', "make_node Table wombats-6620 wombat:p{partition} 777 memcache\n" );
	}

	protected function tearDown(): void {
		unset( Core::$config_resolvers['lab'] );
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->stock );
		parent::tearDown();
	}

	public function test_an_include_s_tables_are_declared_with_their_raw_tokens(): void {
		$this->assertSame(
			[
				'lab-7:kea' => [ 'kind' => 'table', 'namespace' => 'kea:p{partition}', 'ttl' => '777', 'backend' => 'sqlite' ],
				'lab-7:owl' => [ 'kind' => 'table', 'namespace' => 'owl:p{partition}', 'ttl' => '37', 'backend' => 'auto' ],
			],
			Topology_Analyzer::declared_tables( 'kea-lab' )
		);
	}

	public function test_an_omitted_backend_reads_the_schema_default(): void {
		$this->assertSame(
			[ 'lab-7:emu' => [ 'kind' => 'table', 'namespace' => 'emu:p{partition}', 'ttl' => '37', 'backend' => 'auto' ] ],
			Topology_Analyzer::declared_tables( 'emu-ttl' )
		);
	}

	public function test_an_omitted_ttl_is_refused(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Table lab-7:emu declares no TTL' );
		Topology_Analyzer::declared_tables( 'emu-bare' );
	}

	public function test_a_broken_include_throws_rather_than_declaring_nothing(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'kea-missing' );
		Topology_Analyzer::declared_tables( 'kea-broken' );
	}

	public function test_a_sqlite_table_claims_its_file_so_two_topologies_conflict(): void {
		$this->assertContains( 'table:lab-7:kea.p{partition}', Topology_Analyzer::write_set( 'kea-lab' ) );
		$this->assertNotContains( 'table:lab-7:owl.p{partition}', Topology_Analyzer::write_set( 'kea-lab' ), 'a volatile Table writes no file' );
		$this->assertSame( [ 'table:lab-7:kea.p{partition}' ], Topology_Analyzer::find_conflicts( [ 'kea-lab', 'kea-twin' ] )[0]['shared'] ?? [] );
	}

	public function test_a_backend_token_resolving_to_sqlite_claims_the_file(): void {
		$set = Topology_Analyzer::write_set( 'kea-token' );
		$this->assertContains( 'table:lab-7:kea.p{partition}', $set );
		$this->assertNotContains( 'table:lab-7:owl.p{partition}', $set, 'a token resolving to wpdb writes no file' );
		$this->assertSame( [ 'table:lab-7:kea.p{partition}' ], Topology_Analyzer::find_conflicts( [ 'kea-lab', 'kea-token' ] )[0]['shared'] ?? [] );
	}

	public function test_a_backend_token_no_namespace_owns_throws(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'lab:nope' );
		Topology_Analyzer::write_set( 'yak-token' );
	}

	public function test_a_crawler_claims_its_seen_table_file(): void {
		$this->assertContains( 'table:crawl-8821:seen.p{partition}', Topology_Analyzer::write_set( 'crawl-a' ) );
		$this->assertContains( 'table:crawl-tokened-crawl:seen.p{partition}', Topology_Analyzer::write_set( 'crawl-tokened' ), 'the topology token is substituted as for a Table' );
	}

	public function test_two_topologies_declaring_one_crawler_conflict(): void {
		$this->assertSame( [ 'table:crawl-8821:seen.p{partition}' ], Topology_Analyzer::find_conflicts( [ 'crawl-a', 'crawl-b' ] )[0]['shared'] ?? [] );
	}

	public function test_a_crawler_and_a_literal_table_on_its_file_conflict(): void {
		$this->assertSame( [ 'table:crawl-8821:seen.p{partition}' ], Topology_Analyzer::find_conflicts( [ 'crawl-a', 'crawl-table' ] )[0]['shared'] ?? [] );
	}

	public function test_a_crawler_declares_its_seen_table(): void {
		$this->assertSame(
			[ 'crawl-8821:seen' => [ 'kind' => 'table', 'namespace' => 'crawl-8821', 'ttl' => '4407', 'backend' => 'sqlite' ] ],
			Topology_Analyzer::declared_tables( 'crawl-a' )
		);
	}

	public function test_the_write_set_refuses_a_crawler_declaring_no_ttl(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Crawler crawl-8821 declares no TTL' );
		Topology_Analyzer::write_set( 'crawl-bare' );
	}

	public function test_a_crawler_declaring_no_ttl_is_refused(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Crawler crawl-8821 declares no TTL' );
		Topology_Analyzer::declared_tables( 'crawl-bare' );
	}

	public function test_an_include_s_row_tables_are_declared_by_kind_with_their_schema_words(): void {
		$this->assertSame(
			[
				'wombats-6620' => [ 'kind' => 'row', 'schema' => 'Wombat' ],
				'lab-7:kea'    => [ 'kind' => 'table', 'namespace' => 'kea:p{partition}', 'ttl' => '777', 'backend' => 'sqlite' ],
				'numbats-4409' => [ 'kind' => 'row', 'schema' => 'Numbat' ],
			],
			Topology_Analyzer::declared_tables( 'wombat-lab' )
		);
	}

	public function test_a_row_table_declaring_no_schema_is_refused(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Row_Table wombats-6620 declares no schema' );
		Topology_Analyzer::declared_tables( 'wombat-bare' );
	}

	public function test_a_row_table_claims_its_file_per_partition(): void {
		$set = Topology_Analyzer::write_set( 'wombat-lab' );
		$this->assertContains( 'table:wombats-6620.p{partition}', $set );
		$this->assertContains( 'table:numbats-4409.p{partition}', $set );
	}

	public function test_two_topologies_declaring_one_row_table_conflict(): void {
		$this->assertSame( [ 'table:wombats-6620.p{partition}' ], Topology_Analyzer::find_conflicts( [ 'wombat-lab', 'wombat-twin' ] )[0]['shared'] ?? [] );
	}

	public function test_a_row_table_and_a_sqlite_table_on_one_name_conflict(): void {
		$this->assertSame( [ 'table:wombats-6620.p{partition}' ], Topology_Analyzer::find_conflicts( [ 'wombat-twin', 'wombat-keyed' ] )[0]['shared'] ?? [] );
	}

	public function test_a_row_table_and_a_volatile_table_on_one_name_do_not_conflict(): void {
		$this->assertSame( [], Topology_Analyzer::find_conflicts( [ 'wombat-twin', 'wombat-volatile' ] ) );
	}
}
