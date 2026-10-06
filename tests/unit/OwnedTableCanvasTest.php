<?php
/**
 * An owned Table draws on the canvas; every other owned sibling stays hidden.
 *
 * The graph is a real Crawler built through `make_node`, so its `:curl` and
 * `:seen` siblings and each one's `:config` interpreter are the ones the node
 * publishes itself.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Crawler_Node;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Vault;
use Newspack_Nodes\Tests\TestCase;

/** Owns a Table and declares no destination: its canvas row draws no edge to it. */
final class Owned_Table_Silent_Owner_Fixture_Node extends Node {
	public function own(): void {
		$ledger = new Table_Node();
		$ledger->patron( $this );
		$this->publish_sibling( 'ledger', $ledger );
		$ledger->arguments( [ 'owner-6620', '900', 'sqlite' ] );
	}
}

/** Counts how often its schema is built. */
final class Owned_Table_Schema_Counter_Fixture_Node extends Node {
	public static int $built = 0;

	public static function node_schema(): array {
		++self::$built;
		return parent::node_schema();
	}
}

#[CoversClass( Command_Interpreter_Node::class )]
#[CoversClass( Node::class )]
#[CoversClass( Table_Node::class )]
final class OwnedTableCanvasTest extends TestCase {

	private Command_Interpreter_Node $ci;

	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
		$this->use_base_dir( $this->make_temp_dir( 'owned-table-' ), [ 'vault_require_ssl' => false ] );
		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		$this->ci = new Command_Interpreter_Node();
		$this->ci->name( Node_Names::COMMAND_INTERPRETER );
		$this->ci->sink( $router );
		Core::$var['partition'] = '5';
		try {
			$this->ci->dispatch( 'make_node', [ 'Crawler', 'crawl-4471', '7203' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$this->assertInstanceOf( Crawler_Node::class, Core::node( 'crawl-4471' ) );
	}

	protected function tearDown(): void {
		Vault::get_instance()->reset_cache();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		Config::reset();
		parent::tearDown();
	}

	public function test_dump_metadata_lists_the_owned_table_and_hides_the_other_siblings(): void {
		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertArrayHasKey( 'crawl-4471:seen', $meta );
		$this->assertSame( 'Table', $meta['crawl-4471:seen']['class'] );
		$this->assertTrue( $meta['crawl-4471:seen']['has_config'] );
		$this->assertArrayNotHasKey( 'crawl-4471:curl', $meta );
		$this->assertArrayNotHasKey( 'crawl-4471:seen:config', $meta );
		$this->assertArrayNotHasKey( 'crawl-4471:curl:config', $meta );
	}

	public function test_the_crawler_declares_its_owned_table_as_its_one_extra_target(): void {
		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertSame( [ 'crawl-4471:seen' ], $meta['crawl-4471']['targets'], 'extra_targets() names the Table and not the Curl' );
		$this->assertSame( '', $meta['crawl-4471']['target'] );
	}

	public function test_an_owner_declaring_no_extra_target_draws_no_edge_to_its_shown_table(): void {
		$owner = new Owned_Table_Silent_Owner_Fixture_Node();
		$owner->name( 'owner-6620' );
		$owner->sink( $this->ci );
		Core::$var['partition'] = '5';
		try {
			$owner->own();
		} finally {
			unset( Core::$var['partition'] );
		}

		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertArrayHasKey( 'owner-6620:ledger', $meta, 'shown_when_owned still draws the Table' );
		$this->assertSame( [], $meta['owner-6620']['targets'], 'only extra_targets() draws an edge' );
	}

	/** What the console draws as owned is exactly what the Crawler builds and wires. */
	public function test_the_rows_the_crawler_owns_are_what_its_schema_declares(): void {
		$meta = $this->ci->dispatch( 'dump_metadata' );
		$this->assertIsArray( $meta );

		$declared = [];
		foreach ( Crawler_Node::node_schema()['owns'] as $suffix => $class ) {
			$declared[ Node::sibling_name_of( 'crawl-4471', $suffix ) ] = $class;
		}
		$owned = [];
		foreach ( $meta as $name => $row ) {
			if ( 'crawl-4471' === ( $row['owner'] ?? null ) ) {
				$owned[ $name ] = $row['class'];
			}
		}

		$this->assertNotEmpty( $declared );
		$this->assertSame( $declared, $owned );
		foreach ( \array_keys( $declared ) as $name ) {
			$this->assertContains( $name, $meta['crawl-4471']['targets'] );
		}
	}

	public function test_an_owned_row_names_its_owner_and_an_unowned_row_names_none(): void {
		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertSame( 'crawl-4471', $meta['crawl-4471:seen']['owner'] );
		$this->assertArrayNotHasKey( 'owner', $meta['crawl-4471'] );
	}

	public function test_dump_metadata_builds_each_nodes_schema_once(): void {
		$counted = new Owned_Table_Schema_Counter_Fixture_Node();
		$counted->name( 'counted-5501' );
		Owned_Table_Schema_Counter_Fixture_Node::$built = 0;

		$this->ci->dispatch( 'dump_metadata' );

		$this->assertSame( 1, Owned_Table_Schema_Counter_Fixture_Node::$built );
	}

	public function test_naming_the_owned_table_alone_returns_its_row(): void {
		$meta = $this->ci->dispatch( 'dump_metadata', [ 'crawl-4471:seen' ] );

		$this->assertIsArray( $meta );
		$this->assertSame( [ 'crawl-4471:seen' ], \array_keys( $meta ) );
	}

	public function test_dump_config_still_leaves_the_owned_table_to_its_patron(): void {
		$dump = $this->ci->dispatch( 'dump_config' );

		$this->assertIsString( $dump );
		$this->assertStringContainsString( 'make_node Crawler crawl-4471 7203', $dump );
		$this->assertStringNotContainsString( 'crawl-4471:seen', $dump );
	}

	public function test_remove_node_refuses_the_owned_table_and_leaves_it_registered(): void {
		$table = Core::node( 'crawl-4471:seen' );

		$out = $this->ci->dispatch( 'remove_node', [ 'crawl-4471:seen' ] );

		$this->assertSame( "refusing to destroy owned node: crawl-4471:seen, owned by crawl-4471\n", $out );
		$this->assertSame( $table, Core::node( 'crawl-4471:seen' ) );
		$this->assertNotNull( Core::node( 'crawl-4471:seen:config' ) );
	}

	public function test_move_node_refuses_the_owned_table_and_keeps_its_name(): void {
		$table = Core::node( 'crawl-4471:seen' );

		$refusal = null;
		try {
			$this->ci->dispatch( 'move_node', [ 'crawl-4471:seen', 'ledger-9031' ] );
		} catch ( \RuntimeException $e ) {
			$refusal = $e->getMessage();
		}
		$this->assertSame( 'refusing to rename owned node: crawl-4471:seen, owned by crawl-4471', $refusal );
		$this->assertSame( $table, Core::node( 'crawl-4471:seen' ) );
		$this->assertNull( Core::node( 'ledger-9031' ) );
	}

	public function test_renaming_the_patron_carries_the_owned_table_and_its_edge(): void {
		$this->ci->dispatch( 'move_node', [ 'crawl-4471', 'crawl-5582' ] );

		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertArrayHasKey( 'crawl-5582:seen', $meta );
		$this->assertArrayNotHasKey( 'crawl-4471:seen', $meta );
		$this->assertSame( [ 'crawl-5582:seen' ], $meta['crawl-5582']['targets'] );
		$this->assertSame( 'crawl-5582', $meta['crawl-5582:seen']['owner'] );
	}
}
