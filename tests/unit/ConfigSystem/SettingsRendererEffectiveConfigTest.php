<?php
/**
 * SettingsRendererEffectiveConfigTest: the shared "Effective Configuration"
 * panel renderer.
 *
 * Both plugins delegate their settings-page panel to
 * Settings_Renderer::effective_config_rows() / render_effective_config_section(),
 * which take the caller's Schema + option-prefix + already-loaded effective
 * config (each plugin's own Config::load_config()) and report per setting:
 * stored value, effective value, active overlay override, and the live restart
 * impact resolved through the shared Restart_Planner.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit\ConfigSystem;

use Newspack_Nodes\Config;
use Newspack_Nodes\Config_System\Settings_Renderer;
use Newspack_Nodes\Settings_Schema;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Settings_Renderer::class )]
class SettingsRendererEffectiveConfigTest extends TestCase {

	private const PREFIX = 'newspack_nodes_';

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'settings-renderer-effective-config-' );
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
		$rows = Settings_Renderer::effective_config_rows(
			Settings_Schema::get(),
			self::PREFIX,
			Config::load_config()
		);
		return \array_column( $rows, null, 'key' );
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

	public function test_unset_direct_read_field_reports_file_default_effective(): void {
		// overlay=false fields (remote_*) are NOT overlaid, but load_config() seeds
		// from the config FILE (load_config_defaults), which carries them — so the
		// effective array still holds the file default and the panel reports it
		// without needing any plugin-specific Config or a register default.
		$rows = $this->rows_by_key();
		$this->assertStringContainsString( 'file default', $rows['remote_num_segments']['stored'] );
		$this->assertSame( '2', (string) $rows['remote_num_segments']['effective'] );
	}

	public function test_render_section_echoes_widefat_table(): void {
		\ob_start();
		Settings_Renderer::render_effective_config_section(
			Settings_Schema::get(),
			self::PREFIX,
			Config::load_config()
		);
		$html = (string) \ob_get_clean();
		$this->assertStringContainsString( '<table class="widefat"', $html );
		$this->assertStringContainsString( 'Restart impact', $html );
		$this->assertStringContainsString( 'Num Segments', $html );
	}
}
