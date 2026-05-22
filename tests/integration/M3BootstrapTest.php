<?php
/**
 * M3BootstrapTest: end-to-end integration check that the substrate
 * plugin file registers the three M3 service-CIs (Classes_CI, Layouts_CI,
 * Topologies_CI) AND attaches a `newspack_nodes/request_graph_ready`
 * callback that constructs each one through `$base_ci->make_node(...)`.
 *
 * Mirrors the application-side mount pattern in
 * newspack-event-logger-nodes.php where `newspack_event_logger_nodes_mount_service_cis`
 * builds Workers_CI / Discovery_CI / etc. on the same hook. The
 * substrate uses its OWN hook for symmetry so app-side and substrate-side
 * CIs land in the request-scope graph by the same mechanism, and either
 * side's mount function can be replaced via add/remove_action without
 * touching plugin code.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Core;
use Newspack_Nodes\Rest\HTTP_In;
use Newspack_Nodes\Router;
use Newspack_Nodes\Tests\TestCase;

class M3BootstrapTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// Other tests wipe `$GLOBALS['_wp_actions']` for isolation, which
		// drops the bootstrap-time registration the substrate plugin file
		// makes. Re-attach by name — that's why
		// `newspack_nodes_mount_substrate_cis` is a named function in
		// newspack-nodes.php rather than a closure.
		\add_action( 'newspack_nodes/request_graph_ready', 'newspack_nodes_mount_substrate_cis' );
	}

	protected function tearDown(): void {
		Core::reset();
		parent::tearDown();
	}

	public function test_request_graph_ready_mounts_three_substrate_cis(): void {
		// Build the request-scope graph manually (mirrors what
		// HTTP_In::dispatch() does in production).
		$router = new Router();
		$router->name( '_router' );
		$base = new CommandInterpreter();
		$base->name( '_command_interpreter' );
		$base->sink( $router );
		$http = new HTTP_In( static fn ( int $c ) => null );
		$http->name( '_http' );

		\do_action( 'newspack_nodes/request_graph_ready', $base );

		foreach ( [ 'classes', 'layouts', 'topologies' ] as $name ) {
			$this->assertNotNull( Core::node( $name ), "CI '{$name}' must be registered" );
		}
	}

	public function test_legacy_classes_controller_class_is_gone(): void {
		$this->assertFalse(
			\class_exists( '\\Newspack_Nodes\\Rest\\ClassesController' ),
			'Legacy ClassesController must be deleted; Classes_CI.list replaces it.'
		);
	}

	public function test_legacy_layouts_controller_class_is_gone(): void {
		$this->assertFalse(
			\class_exists( '\\Newspack_Nodes\\Rest\\LayoutsController' ),
			'Legacy LayoutsController must be deleted; Layouts_CI.get + .save replace it.'
		);
	}

	public function test_legacy_topologies_controller_class_is_gone(): void {
		$this->assertFalse(
			\class_exists( '\\Newspack_Nodes\\Rest\\TopologiesController' ),
			'Legacy TopologiesController must be deleted; Topologies_CI.list/get/save/delete replace it.'
		);
	}

	public function test_legacy_topology_stream_controller_class_is_gone(): void {
		$this->assertFalse(
			\class_exists( '\\Newspack_Nodes\\Rest\\TopologyStreamController' ),
			'TopologyStreamController must be deleted; the topology console now rides the generic /messages/stream + /command endpoints.'
		);
	}
}
