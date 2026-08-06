<?php
/**
 * Tests for `wp nodes gc [--force]`.
 *
 * The fleet already sweeps orphan log/offset dirs every config-check tick,
 * but only once a dir has been quiet for `Log_Cleaner::DELETE_GRACE_S`. An
 * operator tearing a topology down wants the dirs gone now, so this verb runs
 * the same sweep on demand and `--force` drops the grace to zero.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Config;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_CLI_Command;

require_once \dirname( __DIR__, 2 ) . '/includes/cli/class-worker-cli-command.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( Worker_CLI_Command::class )]
class CliGcCommandTest extends TestCase {

	private string $base_dir;
	private string $stock;

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir( 'cli-gc-' );
		$this->use_base_dir( $this->base_dir );

		$this->stock = $this->make_temp_dir( 'cli-gc-stock-' );
		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->stock );

		$GLOBALS['_test_wp_cli_logs']    = [];
		$GLOBALS['_test_wp_cli_success'] = [];

		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		Config::reset();
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		Config::reset();
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->base_dir );
		parent::tearDown();
	}

	/** A topology declaring one Partition, activated so it lands in the declared set. */
	private function declare_active_topology( string $name, string $log ): void {
		\file_put_contents(
			"{$this->stock}/{$name}.tsl",
			"make_node Partition {$log} <config:logs_dir>/{$log}.p<partition>\n"
		);
		Topology_Registry::activate( $name );
	}

	/** An undeclared log dir written to RIGHT NOW — inside the delete grace. */
	private function fresh_orphan( string $name ): string {
		$path = "{$this->base_dir}/logs/{$name}";
		\mkdir( $path, 0755, true );
		\file_put_contents( "{$path}/0.log", 'being written RIGHT NOW' );
		return $path;
	}

	public function test_gc_spares_a_fresh_orphan_without_force(): void {
		$this->declare_active_topology( 'okapi-keeper', 'okapi-kept' );
		$orphan = $this->fresh_orphan( 'okapi-doomed.p0' );

		( new Worker_CLI_Command() )->gc( [], [] );

		$this->assertDirectoryExists( $orphan );
	}

	public function test_gc_force_sweeps_a_fresh_orphan(): void {
		$this->declare_active_topology( 'okapi-keeper', 'okapi-kept' );
		$orphan = $this->fresh_orphan( 'okapi-doomed.p0' );

		( new Worker_CLI_Command() )->gc( [], [ 'force' => true ] );

		$this->assertDirectoryDoesNotExist( $orphan );
	}

	public function test_gc_force_leaves_a_declared_dir_alone(): void {
		$this->declare_active_topology( 'okapi-keeper', 'okapi-kept' );
		$declared = "{$this->base_dir}/logs/okapi-kept.p0";
		\mkdir( $declared, 0755, true );
		\file_put_contents( "{$declared}/0.log", 'live data' );

		( new Worker_CLI_Command() )->gc( [], [ 'force' => true ] );

		$this->assertDirectoryExists( $declared );
	}
}
