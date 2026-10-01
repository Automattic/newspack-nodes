<?php
/**
 * The analyzer's store pass: what `make_node Table` and `make_node Ledger`
 * declare, and the file a SQLite Table and a Ledger claim per partition in
 * the write set.
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
		$this->write_tsl( 'kea-base', "make_node Table lab-7:kea kea:p<partition> 777 sqlite\nmake_node Table lab-7:owl owl:p<partition> 37\n" );
		$this->write_tsl( 'kea-lab', "include kea-base\nmake_node Echo hush-relay\n" );
		$this->write_tsl( 'kea-twin', "make_node Table lab-7:kea kea:p<partition> 777 sqlite\n" );
		$this->write_tsl( 'kea-broken', "include kea-missing\nmake_node Table lab-7:kea kea:p<partition> 777 sqlite\n" );
		$this->write_tsl( 'emu-bare', "make_node Table lab-7:emu emu:p<partition>\n" );
		$this->write_tsl( 'emu-ttl', "make_node Table lab-7:emu emu:p<partition> 37\n" );
		$this->write_tsl( 'kea-token', "make_node Table lab-7:kea kea:p<partition> 777 <lab:store>\nmake_node Table lab-7:owl owl:p<partition> 37 <lab:shelf>\n" );
		$this->write_tsl( 'yak-token', "make_node Table lab-7:yak yak:p<partition> 37 <lab:nope>\n" );
		$this->write_tsl( 'kea-ledger', "make_node Ledger lab-7:kea 600 3 qty lo:min hi:max\nmake_node Table lab-7:owl owl:p<partition> 37\n" );
		$this->write_tsl( 'kea-ledger-lab', "include kea-ledger\nmake_node Ledger lab-7:heron <lab:span> 3\n" );
		$this->write_tsl( 'kea-ledger-bare', "make_node Ledger lab-7:kea 600\n" );
		$this->write_tsl( 'kea-ledger-twin', "make_node Ledger lab-7:kea 900 2 qty\n" );
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
				'lab-7:kea' => [ 'namespace' => 'kea:p<partition>', 'ttl' => '777', 'backend' => 'sqlite' ],
				'lab-7:owl' => [ 'namespace' => 'owl:p<partition>', 'ttl' => '37', 'backend' => 'auto' ],
			],
			Topology_Analyzer::declared_tables( 'kea-lab' )
		);
	}

	public function test_an_omitted_backend_reads_the_schema_default(): void {
		$this->assertSame(
			[ 'lab-7:emu' => [ 'namespace' => 'emu:p<partition>', 'ttl' => '37', 'backend' => 'auto' ] ],
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
		$this->assertContains( 'table:lab-7:kea.p<partition>', Topology_Analyzer::write_set( 'kea-lab' ) );
		$this->assertNotContains( 'table:lab-7:owl.p<partition>', Topology_Analyzer::write_set( 'kea-lab' ), 'a volatile Table writes no file' );
		$this->assertSame( [ 'table:lab-7:kea.p<partition>' ], Topology_Analyzer::find_conflicts( [ 'kea-lab', 'kea-twin' ] )[0]['shared'] ?? [] );
	}

	public function test_a_backend_token_resolving_to_sqlite_claims_the_file(): void {
		$set = Topology_Analyzer::write_set( 'kea-token' );
		$this->assertContains( 'table:lab-7:kea.p<partition>', $set );
		$this->assertNotContains( 'table:lab-7:owl.p<partition>', $set, 'a token resolving to wpdb writes no file' );
		$this->assertSame( [ 'table:lab-7:kea.p<partition>' ], Topology_Analyzer::find_conflicts( [ 'kea-lab', 'kea-token' ] )[0]['shared'] ?? [] );
	}

	public function test_a_backend_token_no_namespace_owns_throws(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'lab:nope' );
		Topology_Analyzer::write_set( 'yak-token' );
	}

	public function test_a_ledger_is_declared_with_its_counts_and_columns_as_written(): void {
		$this->assertSame(
			[
				'lab-7:kea'   => [ 'segment_seconds' => '600', 'num_segments' => '3', 'columns' => [ 'qty', 'lo:min', 'hi:max' ] ],
				'lab-7:heron' => [ 'segment_seconds' => '<lab:span>', 'num_segments' => '3', 'columns' => [] ],
			],
			Topology_Analyzer::declared_ledgers( 'kea-ledger-lab' )
		);
	}

	public function test_a_ledger_is_no_table_and_a_table_no_ledger(): void {
		$this->assertSame( [ 'lab-7:owl' ], \array_keys( Topology_Analyzer::declared_tables( 'kea-ledger' ) ) );
		$this->assertSame( [ 'lab-7:kea' ], \array_keys( Topology_Analyzer::declared_ledgers( 'kea-ledger' ) ) );
	}

	public function test_a_ledger_claims_each_partitions_file_so_two_topologies_conflict(): void {
		$this->assertContains( 'ledger:lab-7:kea.p<partition>', Topology_Analyzer::write_set( 'kea-ledger-lab' ) );
		$this->assertContains( 'ledger:lab-7:heron.p<partition>', Topology_Analyzer::write_set( 'kea-ledger-lab' ) );
		$this->assertSame( [ 'ledger:lab-7:kea.p<partition>' ], Topology_Analyzer::find_conflicts( [ 'kea-ledger-lab', 'kea-ledger-twin' ] )[0]['shared'] ?? [] );
		$this->assertSame( [], Topology_Analyzer::find_conflicts( [ 'kea-ledger', 'kea-twin' ] ), 'a Ledger and a Table of one name write different files' );
	}

	public function test_a_ledger_declaring_no_segment_count_is_refused(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Ledger lab-7:kea declares no num_segments' );
		Topology_Analyzer::declared_ledgers( 'kea-ledger-bare' );
	}
}
