<?php
/**
 * An owned Table stays off the canvas like every other owned sibling, and
 * opens from its owner's sidecars; `dump_metadata` answers it by name.
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

/** Owns a Table, a schema-hidden sibling and an unowned published one. */
final class Owned_Table_Silent_Owner_Fixture_Node extends Node {
	public function own(): void {
		$ledger = new Table_Node();
		$ledger->patron( $this );
		$this->publish_sibling( 'ledger', $ledger );
		$ledger->arguments( [ 'owner-6620', '900', 'sqlite' ] );
		$plumbing = new Owned_Table_Hidden_Sibling_Fixture_Node();
		$plumbing->patron( $this );
		$this->publish_sibling( 'plumbing', $plumbing );
		$this->publish_sibling( 'member', new Node() );
	}
}

/** A sibling whose schema hides it from every console surface. */
final class Owned_Table_Hidden_Sibling_Fixture_Node extends Node {
	public static function node_schema(): array {
		return [ 'hidden' => true ] + parent::node_schema();
	}
}

/** Owns one schema-counting sibling. */
final class Owned_Table_Counted_Owner_Fixture_Node extends Node {
	public function own(): void {
		$tally = new Owned_Table_Schema_Counter_Fixture_Node();
		$tally->patron( $this );
		$this->publish_sibling( 'tally', $tally );
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

	public function test_the_full_snapshot_omits_every_owned_sibling(): void {
		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertArrayHasKey( 'crawl-4471', $meta );
		$this->assertArrayNotHasKey( 'crawl-4471:seen', $meta );
		$this->assertArrayNotHasKey( 'crawl-4471:curl', $meta );
		$this->assertArrayNotHasKey( 'crawl-4471:seen:config', $meta );
		$this->assertArrayNotHasKey( 'crawl-4471:curl:config', $meta );
	}

	/** The whole list, so a `:config` interpreter or a hidden sibling in it fails. */
	public function test_the_owner_row_lists_its_sidecars_by_name(): void {
		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertSame(
			[
				[ 'name' => 'crawl-4471:curl', 'class' => 'Curl' ],
				[ 'name' => 'crawl-4471:seen', 'class' => 'Table' ],
			],
			$meta['crawl-4471']['sidecars']
		);
	}

	public function test_a_node_owning_nothing_carries_no_sidecars_key(): void {
		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertArrayNotHasKey( 'sidecars', $meta[ Node_Names::ROUTER ] );
	}

	public function test_the_crawler_draws_no_edge_to_its_owned_table(): void {
		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertSame( [], $meta['crawl-4471']['targets'], 'no card stands at the end of an edge to a sidecar' );
		$this->assertSame( '', $meta['crawl-4471']['target'] );
	}

	public function test_a_schema_hidden_sibling_is_no_sidecar_and_answers_no_name(): void {
		$owner = $this->silent_owner();

		$meta  = $this->ci->dispatch( 'dump_metadata' );
		$named = $this->ci->dispatch( 'dump_metadata', [ 'owner-6620:plumbing' ] );

		$this->assertIsArray( $meta );
		$this->assertNotNull( Core::node( 'owner-6620:plumbing' ) );
		$this->assertArrayNotHasKey( 'owner-6620:plumbing', $meta );
		$this->assertSame( [], $named );
		$this->assertSame( [ [ 'name' => 'owner-6620:ledger', 'class' => 'Table' ] ], $meta[ $owner->name() ]['sidecars'] );
	}

	/** A published sibling with no patron draws on the canvas, as a Vault_Group's child does. */
	public function test_a_published_sibling_with_no_patron_draws_and_is_no_sidecar(): void {
		$this->silent_owner();

		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertSame( 'owner-6620', $meta['owner-6620:member']['owner'] );
		$this->assertNotContains( 'owner-6620:member', \array_column( $meta['owner-6620']['sidecars'], 'name' ) );
	}

	public function test_an_owner_declaring_no_extra_target_draws_no_edge_to_its_table(): void {
		$this->silent_owner();

		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertArrayNotHasKey( 'owner-6620:ledger', $meta );
		$this->assertSame( [], $meta['owner-6620']['targets'], 'only extra_targets() draws an edge' );
	}

	/** Every sibling the Crawler's schema declares under `owns` is a sidecar. */
	public function test_the_sidecars_carry_what_the_schema_owns(): void {
		$meta = $this->ci->dispatch( 'dump_metadata' );
		$this->assertIsArray( $meta );

		$declared = [];
		foreach ( Crawler_Node::node_schema()['owns'] as $suffix => $class ) {
			$declared[] = [ 'name' => Node::sibling_name_of( 'crawl-4471', $suffix ), 'class' => $class ];
		}

		$this->assertNotEmpty( $declared );
		foreach ( $declared as $sidecar ) {
			$this->assertContains( $sidecar, $meta['crawl-4471']['sidecars'] );
		}
	}

	public function test_every_owned_node_a_crawler_builds_keeps_its_config(): void {
		$this->assert_owned_nodes_keep_their_config();
	}

	public function test_an_owner_row_names_no_owner(): void {
		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertArrayNotHasKey( 'owner', $meta['crawl-4471'] );
	}

	public function test_dump_metadata_builds_each_nodes_schema_once(): void {
		$counted = new Owned_Table_Schema_Counter_Fixture_Node();
		$counted->name( 'counted-5501' );
		$owner = new Owned_Table_Counted_Owner_Fixture_Node();
		$owner->name( 'owner-7713' );
		$owner->own();
		Owned_Table_Schema_Counter_Fixture_Node::$built = 0;

		$meta = $this->ci->dispatch( 'dump_metadata' );

		$this->assertIsArray( $meta );
		$this->assertArrayHasKey( 'counted-5501', $meta );
		$this->assertArrayNotHasKey( 'owner-7713:tally', $meta );
		$this->assertSame( 2, Owned_Table_Schema_Counter_Fixture_Node::$built, 'one build for the unowned node, one for the sidecar list' );
	}

	public function test_naming_the_owned_table_alone_returns_its_full_row_and_owner(): void {
		$meta = $this->ci->dispatch( 'dump_metadata', [ 'crawl-4471:seen' ] );

		$this->assertIsArray( $meta );
		$this->assertSame( [ 'crawl-4471:seen' ], \array_keys( $meta ) );
		$this->assertSame( 'Table', $meta['crawl-4471:seen']['class'] );
		$this->assertSame( 'crawl-4471', $meta['crawl-4471:seen']['owner'] );
		$this->assertTrue( $meta['crawl-4471:seen']['has_config'] );
		$this->assertSame( [ 'crawl-4471', '7203', 'sqlite' ], \array_slice( $meta['crawl-4471:seen']['arguments'], 0, 3 ) );
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

		$meta  = $this->ci->dispatch( 'dump_metadata' );
		$named = $this->ci->dispatch( 'dump_metadata', [ 'crawl-5582:seen' ] );

		$this->assertIsArray( $meta );
		$this->assertIsArray( $named );
		$this->assertContains( [ 'name' => 'crawl-5582:seen', 'class' => 'Table' ], $meta['crawl-5582']['sidecars'] );
		$this->assertSame( 'crawl-5582', $named['crawl-5582:seen']['owner'] );
		$this->assertSame( [], $this->ci->dispatch( 'dump_metadata', [ 'crawl-4471:seen' ] ) );
		$this->assertNotNull( Core::node( 'crawl-5582:seen:config' ) );
		$this->assertNull( Core::node( 'crawl-4471:seen:config' ) );
	}

	/** An owner of a ledger Table and a hidden sibling, named and sunk. */
	private function silent_owner(): Owned_Table_Silent_Owner_Fixture_Node {
		$owner = new Owned_Table_Silent_Owner_Fixture_Node();
		$owner->name( 'owner-6620' );
		$owner->sink( $this->ci );
		Core::$var['partition'] = '5';
		try {
			$owner->own();
		} finally {
			unset( Core::$var['partition'] );
		}
		return $owner;
	}
}
