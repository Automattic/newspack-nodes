<?php
/**
 * AdminEffectiveConfigTest: the read-only "Effective Configuration" panel.
 *
 * Asserts the pure `Admin::effective_config_rows()` data shape (stored value,
 * effective value, active overlay override, live restart impact) against a
 * fixture active set, plus a render smoke test that the section echoes a
 * `widefat` table. WP-Settings-API + esc stubs live in AdminTest.php's
 * global-namespace block (required by the bootstrap test set); this file only
 * adds `esc_attr` defensively.
 */

namespace {
	if ( ! \function_exists( 'esc_attr' ) ) {
		function esc_attr( $v ): string {
			return \htmlspecialchars( (string) $v, ENT_QUOTES, 'UTF-8' );
		}
	}
	require_once \dirname( __DIR__, 3 ) . '/includes/admin/class-admin.php';
}

namespace Newspack_Nodes\Tests\Unit\Admin {

use Newspack_Nodes\Admin\Admin;
use Newspack_Nodes\Config;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Admin::class )]
class AdminEffectiveConfigTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'admin-effective-config-' );
		Topology_Registry::register_stock_dir( $this->tmp );
		$this->use_base_dir( $this->tmp );
		// Active set mirrors RestartPlannerTest::setUp — `combined` instantiates a
		// Partition (geometry-classified num_segments restarts it).
		\update_option( 'newspack_nodes_topologies', [ 'combined', 'aggregator', 'job-worker' ] );
		Config::reset();
		$this->write_tsl( 'combined', "make_node Partition requests:partition <config:logs_dir>/requests.p<partition> 1 2 0\nmake_node Tee fanout\n" );
		$this->write_tsl( 'aggregator', "make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} 1 1 2 0\n" );
		$this->write_tsl( 'job-worker', "make_node Consumer jobintake:consumer <config:logs_dir>/jobintake.p<partition> <config:offsets_dir>/ji.p<partition>\nmake_node Job_Worker job-worker\n" );
	}

	protected function tearDown(): void {
		\delete_option( 'newspack_nodes_topologies' );
		\delete_option( 'newspack_nodes_num_segments' );
		\delete_option( 'newspack_nodes_num_partitions' );
		\delete_option( 'newspack_nodes_base_directory' );
		Config::reset();
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function write_tsl( string $name, string $contents ): void {
		\file_put_contents( "{$this->tmp}/{$name}.tsl", $contents );
	}

	/** @return array<string,array<string,mixed>> */
	private function rows_by_key(): array {
		return \array_column( ( new Admin() )->effective_config_rows(), null, 'key' );
	}

	public function test_rows_report_stored_effective_and_restart_impact(): void {
		\update_option( 'newspack_nodes_num_segments', 7 );
		Config::reset();
		$rows = $this->rows_by_key();
		$this->assertSame( '7', (string) $rows['num_segments']['stored'] );
		$this->assertStringContainsString( 'combined', $rows['num_segments']['restart'] );
		$this->assertStringContainsString( 'supervisor', \strtolower( $rows['num_partitions']['restart'] ) );
	}

	public function test_unstored_setting_reports_file_default_and_no_overlay(): void {
		$rows = $this->rows_by_key();
		$this->assertStringContainsString( 'file default', $rows['num_segments']['stored'] );
		$this->assertNull( $rows['num_segments']['overlay'] );
	}

	public function test_stored_overlaid_setting_reports_overlay_value(): void {
		\update_option( 'newspack_nodes_num_segments', 9 );
		Config::reset();
		$rows = $this->rows_by_key();
		$this->assertSame( '9', $rows['num_segments']['overlay'] );
		$this->assertSame( '9', (string) $rows['num_segments']['effective'] );
	}

	public function test_immediate_and_supervisor_restart_strings(): void {
		$rows = $this->rows_by_key();
		// num_partitions is classified supervisor_only.
		$this->assertSame( 'Applies on next supervisor tick', $rows['num_partitions']['restart'] );
		// remote_num_segments is classified [] (read directly, no worker restart).
		$this->assertSame( 'Takes effect immediately', $rows['remote_num_segments']['restart'] );
	}

	public function test_render_section_echoes_widefat_table(): void {
		\ob_start();
		( new Admin() )->render_effective_config_section();
		$html = (string) \ob_get_clean();
		$this->assertStringContainsString( '<table class="widefat"', $html );
		$this->assertStringContainsString( 'Restart impact', $html );
		$this->assertStringContainsString( 'Num Segments', $html );
	}
}

}
