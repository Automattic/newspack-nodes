<?php
/**
 * AdminEffectiveConfigTest: the substrate Admin's "Effective Configuration"
 * panel delegate.
 *
 * The per-row data shape (stored / effective / overlay / restart impact) is
 * owned by SettingsRendererEffectiveConfigTest against the shared renderer; this
 * file only proves the public Admin entry — `render_effective_config_section()`,
 * hooked to `newspack_nodes/settings_after_form` — drives that shared renderer
 * and echoes the `widefat` table. WP-Settings-API + escaping stubs are shared
 * from tests/bootstrap.php.
 */

namespace {
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
		$GLOBALS['_wp_actions'] = [];
		Topology_Registry::reset();
		$this->tmp = $this->make_temp_dir( 'admin-effective-config-' );
		Topology_Registry::register_stock_dir( $this->tmp );
		$this->use_base_dir( $this->tmp );
		// One active topology so the renderer's restart-impact resolution has a
		// live registry to consult.
		\update_option( 'newspack_nodes_topologies', [ 'combined' ] );
		Config::reset();
		\file_put_contents( "{$this->tmp}/combined.tsl", "make_node Partition requests:partition <config:logs_dir>/requests.p<partition> 1 2 0\n" );
	}

	protected function tearDown(): void {
		\delete_option( 'newspack_nodes_topologies' );
		\delete_option( 'newspack_nodes_base_directory' );
		Config::reset();
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_render_section_delegates_to_shared_renderer_and_echoes_widefat_table(): void {
		\ob_start();
		( new Admin() )->render_effective_config_section();
		$html = (string) \ob_get_clean();
		$this->assertStringContainsString( '<table class="widefat"', $html );
		$this->assertStringContainsString( 'Restart impact', $html );
		// A substrate setting label only the shared renderer's row loop emits.
		$this->assertStringContainsString( 'Num Segments', $html );
	}

	public function test_render_section_hooked_to_settings_after_form(): void {
		new Admin();
		$this->assertArrayHasKey(
			'newspack_nodes/settings_after_form',
			$GLOBALS['_wp_actions'],
			'render_effective_config_section must be hooked to settings_after_form'
		);
	}
}

}
