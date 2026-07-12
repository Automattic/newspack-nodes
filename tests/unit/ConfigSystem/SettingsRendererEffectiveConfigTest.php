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
		// Partition (geometry-classified max_segments restarts it).
		\update_option( 'newspack_nodes_topologies', [ 'combined', 'aggregator', 'job-worker' ] );
		Config::reset();
		$this->write_tsl( 'combined', "make_node Partition requests:partition <config:logs_dir>/requests.p<partition> 1 2 0\nmake_node Tee fanout\n" );
		$this->write_tsl( 'aggregator', "make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} 1 1 2 0\n" );
		$this->write_tsl( 'job-worker', "make_node Consumer jobintake:consumer <config:logs_dir>/jobintake.p<partition> <config:offsets_dir>/ji.p<partition>\nmake_node Job_Worker job-worker\n" );
	}

	protected function tearDown(): void {
		\delete_option( 'newspack_nodes_topologies' );
		\delete_option( 'newspack_nodes_max_segments' );
		\delete_option( 'newspack_nodes_num_partitions' );
		\delete_option( 'newspack_nodes_base_directory' );
		\delete_option( 'newspack_nodes_remote_segment_size' );
		\delete_option( 'newspack_nodes_memcache_servers' );
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
		\update_option( 'newspack_nodes_max_segments', 7 );
		Config::reset();
		$rows = $this->rows_by_key();
		$this->assertSame( '7', (string) $rows['max_segments']['stored'] );
		$this->assertStringContainsString( 'combined', $rows['max_segments']['restart'] );
		$this->assertStringContainsString( 'supervisor', \strtolower( $rows['num_partitions']['restart'] ) );
	}

	public function test_unstored_setting_reports_file_default_and_no_overlay(): void {
		$rows = $this->rows_by_key();
		$this->assertStringContainsString( 'file default', $rows['max_segments']['stored'] );
		$this->assertNull( $rows['max_segments']['overlay'] );
	}

	public function test_stored_overlaid_setting_reports_overlay_value(): void {
		\update_option( 'newspack_nodes_max_segments', 9 );
		Config::reset();
		$rows = $this->rows_by_key();
		$this->assertSame( '9', $rows['max_segments']['overlay'] );
		$this->assertSame( '9', (string) $rows['max_segments']['effective'] );
	}

	public function test_immediate_and_supervisor_restart_strings(): void {
		$rows = $this->rows_by_key();
		// num_partitions is classified supervisor_only.
		$this->assertSame( 'Applies on next supervisor tick', $rows['num_partitions']['restart'] );
		// remote_max_segments is classified [] (read directly, no worker restart).
		$this->assertSame( 'Takes effect immediately', $rows['remote_max_segments']['restart'] );
	}

	public function test_unset_remote_field_reports_file_default(): void {
		// remote_* are now overlaid like every other setting: when unset, load_config
		// carries the config-file default, and the Effective cell shows it — uniform
		// with every other field, no blank cell.
		$rows = $this->rows_by_key();
		$this->assertStringContainsString( 'file default', $rows['remote_max_segments']['stored'] );
		$this->assertSame(
			(string) ( Config::load_config()['remote_max_segments'] ?? '' ),
			(string) $rows['remote_max_segments']['effective']
		);
		$this->assertNotSame( '', (string) $rows['remote_max_segments']['effective'] );
	}

	public function test_stored_remote_field_reports_stored_value(): void {
		// remote_segment_size is now overlaid: a stored value is overlaid into
		// load_config, so the Effective cell shows the stored value via the uniform path.
		\update_option( 'newspack_nodes_remote_segment_size', 67108864 );
		Config::reset();
		$rows = $this->rows_by_key();
		$this->assertSame( '67108864', (string) $rows['remote_segment_size']['effective'] );
	}

	public function test_overlaid_field_still_reports_load_config_value(): void {
		// Control: overlay=true fields keep reporting the load_config (overlay-resolved)
		// value — the common-case behavior must not change.
		\update_option( 'newspack_nodes_max_segments', 11 );
		Config::reset();
		$rows = $this->rows_by_key();
		$this->assertSame( '11', (string) $rows['max_segments']['effective'] );
		$this->assertSame( (string) ( Config::load_config()['max_segments'] ?? '' ), (string) $rows['max_segments']['effective'] );
	}

	public function test_small_array_value_renders_in_full(): void {
		// <=6 entries render fully (memcache_servers is the common small case).
		\update_option( 'newspack_nodes_memcache_servers', [ '10.0.0.1:11211', '10.0.0.2:11211' ] );
		Config::reset();
		$rows = $this->rows_by_key();
		$this->assertSame( '10.0.0.1:11211, 10.0.0.2:11211', $rows['memcache_servers']['effective'] );
	}

	public function test_large_array_value_renders_as_count_and_sample(): void {
		// >6 entries collapse to a count + first-6 sample + remainder, so a 412-hook
		// list can't dominate the row.
		$servers = [];
		for ( $i = 1; $i <= 20; $i++ ) {
			$servers[] = "10.0.0.{$i}:11211";
		}
		\update_option( 'newspack_nodes_memcache_servers', $servers );
		Config::reset();
		$rows     = $this->rows_by_key();
		$expected = '20 values: 10.0.0.1:11211, 10.0.0.2:11211, 10.0.0.3:11211, 10.0.0.4:11211, 10.0.0.5:11211, 10.0.0.6:11211, … (+14 more)';
		$this->assertSame( $expected, $rows['memcache_servers']['effective'] );
	}

	public function test_empty_array_value_renders_none(): void {
		\update_option( 'newspack_nodes_memcache_servers', [] );
		Config::reset();
		$rows = $this->rows_by_key();
		$this->assertSame( '(none)', $rows['memcache_servers']['effective'] );
	}

	public function test_associative_array_value_renders_keys_not_values(): void {
		// An associative array (e.g. custom_events {event => true}) carries its meaning
		// in the KEYS; the panel must show those, not the true→'1' values.
		\update_option( 'newspack_nodes_memcache_servers', [ 'alpha' => true, 'beta' => true ] );
		Config::reset();
		$rows = $this->rows_by_key();
		$this->assertSame( 'alpha, beta', $rows['memcache_servers']['effective'] );
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
		$this->assertStringContainsString( 'Max Segments', $html );
	}
}
