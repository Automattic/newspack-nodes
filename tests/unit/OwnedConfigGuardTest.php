<?php
/**
 * Every patroned node whose class declares verbs keeps its `:config`, so a
 * sidecar's verbs reach it as a canvas node's do. The guard walks graphs the
 * substrate really builds; a class built as a patroned sibling with verbs and
 * no interpreter fails it.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Loader;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\AssertionFailedError;
use PHPUnit\Framework\Attributes\CoversNothing;
use PHPUnit\Framework\Attributes\DataProvider;

/** Declares a verb and never wires the interpreter that would take it. */
final class Owned_Config_Unwired_Fixture_Node extends Node {
	public static function node_schema(): array {
		return [
			'commands' => [
				[ 'name' => 'nudge', 'handler' => static fn (): string => 'ok' ],
			],
		] + parent::node_schema();
	}
}

#[CoversNothing]
final class OwnedConfigGuardTest extends TestCase {
	protected function tearDown(): void {
		Topology_Registry::reset();
		parent::tearDown();
	}

	public function test_the_guard_fails_a_patroned_node_with_verbs_and_no_config(): void {
		$owner    = new Node();
		$unwired  = new Owned_Config_Unwired_Fixture_Node();
		$unwired->patron( $owner );
		$unwired->name( 'unwired-8830' );

		$this->expectException( AssertionFailedError::class );
		$this->expectExceptionMessage( 'unwired-8830' );
		$this->assert_owned_nodes_keep_their_config();
	}

	public function test_the_guard_exempts_a_node_its_builder_opted_out(): void {
		$owner = new Node();
		$kept  = new Partition_Node();
		$kept->patron( $owner );
		$kept->name( 'kept-6120' );
		$skipped = new Partition_Node();
		$skipped->patron( $owner );
		$skipped->without_config();
		$skipped->name( 'skipped-6121' );

		$this->assert_owned_nodes_keep_their_config();
		$this->assertNull( Core::node( 'skipped-6121:config' ) );
	}

	/** @return array<string,array{string}> */
	public static function stock_topologies(): array {
		return [
			'job-worker'    => [ 'job-worker' ],
			'job-intake'    => [ 'job-intake' ],
			'settings-sync' => [ 'settings-sync' ],
		];
	}

	#[DataProvider( 'stock_topologies' )]
	public function test_every_owned_node_a_stock_topology_builds_keeps_its_config( string $topology ): void {
		$this->use_base_dir( $this->make_temp_dir( 'owned-config-' ), [ 'num_partitions' => 1 ] );
		Topology_Registry::register_stock_dir( \dirname( __DIR__, 2 ) . '/topologies' );
		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		$ci = new Command_Interpreter_Node();
		$ci->name( Node_Names::COMMAND_INTERPRETER );
		$ci->sink( $router );

		Topology_Loader::load( $topology, 0, $ci );

		$this->assertNotEmpty( Core::$nodes_by_name );
		$this->assert_owned_nodes_keep_their_config();
	}
}
