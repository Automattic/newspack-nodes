<?php
/**
 * The analyzer's owned pass: what each class declares it `owns`, read once,
 * and the owned Tables it therefore declares.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Topology_Analyzer::class )]
final class TopologyAnalyzerOwnedTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		require_once __DIR__ . '/../Helpers/fixtures/class-wombat-hidden-patron-node.php';
		require_once __DIR__ . '/../Helpers/fixtures/class-wombat-table-patron-node.php';
		require_once __DIR__ . '/../Helpers/fixtures/class-wombat-ledger-table-node.php';
		require_once __DIR__ . '/../Helpers/fixtures/class-wombat-subtable-patron-node.php';
		require_once __DIR__ . '/../Helpers/fixtures/class-wombat-bare-table-patron-node.php';
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\Fixtures\\' );
		Topology_Registry::reset();
		$this->stock_topology_dir( 'owned-stock-' );
		$this->write_tsl( 'crawl-owned', "make_node Crawler crawl-3307 5519\n" );
		$this->write_tsl( 'tally-owned', "make_node Wombat_Table_Patron tally-8842 6131 wpdb\n" );
		$this->write_tsl( 'tally-sqlite', "make_node Wombat_Table_Patron tally-5517 2903 sqlite\n" );
		$this->write_tsl( 'tally-twin', "make_node Wombat_Table_Patron tally-5517 2903 sqlite\n" );
		$this->write_tsl( 'hidden-owned', "make_node Wombat_Hidden_Patron hush-2209\n" );
		$this->write_tsl( 'subtable-owned', "make_node Wombat_Subtable_Patron ledger-6650 4127\n" );
		$this->write_tsl( 'bare-owned', "make_node Wombat_Bare_Table_Patron bare-4410\n" );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		parent::tearDown();
	}

	/** Every owned Table is a declared Table, whatever class owns it. */
	public function test_every_owned_table_is_a_declared_table(): void {
		foreach ( [ 'crawl-owned', 'tally-owned' ] as $topology ) {
			$tables = \array_column(
				\array_filter(
					Topology_Analyzer::owned_nodes( $topology ),
					static fn ( array $node ): bool => 'Table' === $node['class']
				),
				'name'
			);
			$this->assertNotEmpty( $tables, "{$topology} owns a Table" );
			foreach ( $tables as $table ) {
				$this->assertArrayHasKey( $table, Topology_Analyzer::declared_tables( $topology ) );
			}
		}
	}

	/** An owned Table takes the arguments its owner's declaration gives it. */
	public function test_an_owned_table_is_declared_from_its_owner(): void {
		$this->assertSame(
			[ 'tally-8842:tally' => [ 'namespace' => 'tally-8842-tally', 'ttl' => '6131', 'backend' => 'wpdb' ] ],
			Topology_Analyzer::declared_tables( 'tally-owned' )
		);
	}

	/** An owned sqlite Table claims its file, so two owners of one file conflict. */
	public function test_an_owned_sqlite_table_claims_its_file(): void {
		$this->assertContains( 'table:tally-5517:tally.p<partition>', Topology_Analyzer::write_set( 'tally-sqlite' ) );
		$this->assertSame( [ 'table:tally-5517:tally.p<partition>' ], Topology_Analyzer::find_conflicts( [ 'tally-sqlite', 'tally-twin' ] )[0]['shared'] ?? [] );
	}

	/** An owned Table on any other backend writes no file and claims none. */
	public function test_an_owned_wpdb_table_claims_no_file(): void {
		$this->assertSame( [], Topology_Analyzer::write_set( 'tally-owned' ) );
	}

	/** An owned Table subclass is a Table: declared, and its file claimed. */
	public function test_an_owned_table_subclass_is_declared_and_claimed(): void {
		$this->assertSame(
			[ 'ledger-6650:ledger' => [ 'namespace' => 'ledger-6650-ledger', 'ttl' => '4127', 'backend' => 'sqlite' ] ],
			Topology_Analyzer::declared_tables( 'subtable-owned' )
		);
		$this->assertContains( 'table:ledger-6650:ledger.p<partition>', Topology_Analyzer::write_set( 'subtable-owned' ) );
	}

	/** A class owning a Table must say what its line gives it. */
	public function test_an_owned_table_without_owned_table_is_refused(): void {
		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'Newspack_Nodes\\Tests\\Fixtures\\Wombat_Bare_Table_Patron_Node declares no owned Table tally for bare-4410' );
		Topology_Analyzer::declared_tables( 'bare-owned' );
	}

	/** A class off the palette cannot own: the editor's catalog never carries it. */
	public function test_an_owner_off_the_palette_is_refused(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Wombat_Hidden_Patron declares owns but is not a palette class' );
		Topology_Analyzer::owned_nodes( 'hidden-owned' );
	}
}
