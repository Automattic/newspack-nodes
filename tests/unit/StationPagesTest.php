<?php
/**
 * StationPagesTest: the station's four composed pages on the composition
 * layer — each context with its default layout and the shared blocks it
 * admits, the three blocks the substrate owns and where they stand, the
 * default trees `tests/fixtures/station-layouts.json` holds for the
 * browser's tests, and what a station load localizes and enqueues.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Block_Editor_Bootstrap;
use Newspack_Nodes\Composition;
use Newspack_Nodes\Composition_Store;
use Newspack_Nodes\Station_Pages;
use Newspack_Nodes\Tests\Helpers\Composes_Acme_Desk;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Station_Pages::class )]
final class StationPagesTest extends TestCase {

	use Composes_Acme_Desk;

	/** The station's contexts, by page slug. */
	private const CONTEXTS = [
		'station-overview'   => 'newspack-nodes/station-overview',
		'station-jobs'       => 'newspack-nodes/station-jobs',
		'station-tables'     => 'newspack-nodes/station-tables',
		'station-aggregator' => 'newspack-nodes/station-aggregator',
	];

	/** The shared blocks every station context admits. */
	private const SHARED = [
		'newspack-nodes/stats',
		'newspack-nodes/time-chart',
		'newspack-nodes/table',
		'newspack-nodes/log-stream',
		'newspack-nodes/sparkline',
		'newspack-nodes/section',
	];

	protected function setUp(): void {
		parent::setUp();
		$this->forget_declarations();
		$GLOBALS['_enqueued_scripts']  = [];
		$GLOBALS['_enqueued_styles']   = [];
		$GLOBALS['_localized_scripts'] = [];
		$_GET                          = [];
	}

	protected function tearDown(): void {
		$this->forget_declarations();
		( new \ReflectionProperty( Block_Editor_Bootstrap::class, 'canvas_context' ) )->setValue( null, null );
		( new \ReflectionProperty( Block_Editor_Bootstrap::class, 'content_blocks_loaded' ) )->setValue( null, false );
		\wp_shim_reset_block_editor();
		unset( $GLOBALS['_registered_scripts'], $GLOBALS['_wp_test_current_user_can'], $GLOBALS['_wp_test_current_user_id'] );
		$_GET = [];
		parent::tearDown();
	}

	/** Log in a user holding `$caps`. */
	private function log_in( array $caps ): void {
		$GLOBALS['_wp_test_current_user_id']  = 7;
		$GLOBALS['_wp_test_current_user_can'] = $caps;
	}

	public function test_each_station_page_lays_out_its_own_context(): void {
		$this->assertSame( self::CONTEXTS, Station_Pages::PAGES );
		$contexts = Composition::declarations()['contexts'];
		foreach ( self::CONTEXTS as $page => $context ) {
			$this->assertArrayHasKey( $context, $contexts );
			$this->assertSame( 'newspack-nodes', $contexts[ $context ]['namespace'] );
			$this->assertSame( \dirname( __DIR__, 2 ) . "/layouts/station/{$page}.html", \realpath( $contexts[ $context ]['default'] ) );
			$this->assertSame( self::SHARED, $contexts[ $context ]['admits'] );
		}
	}

	public function test_the_substrate_owns_three_station_blocks_where_each_stands(): void {
		$blocks = Composition::declarations()['blocks'];
		$this->assertSame( [ 'newspack-nodes/station-overview' ], $blocks['newspack-nodes/topology-rows']['contexts'] );
		$this->assertFalse( $blocks['newspack-nodes/topology-rows']['multiple'] );
		$this->assertSame(
			[ 'newspack-nodes/station-overview', 'newspack-nodes/station-jobs', 'newspack-nodes/station-tables' ],
			$blocks['newspack-nodes/probe-table']['contexts']
		);
		$this->assertSame( [ 'nodes/jobstats', 'nodes/tablestats' ], $blocks['newspack-nodes/probe-table']['attributes']['source']['enum'] );
		$this->assertSame( [ 'newspack-nodes/station-aggregator' ], $blocks['newspack-nodes/server-cards']['contexts'] );
		$this->assertFalse( $blocks['newspack-nodes/server-cards']['multiple'] );
	}

	public function test_a_station_block_stands_only_on_its_own_pages(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'newspack-nodes/server-cards' );
		Composition::validate( 'newspack-nodes/station-jobs', '<!-- wp:newspack-nodes/server-cards /-->' );
	}

	public function test_the_fixture_holds_each_default_tree_the_browser_tests_read(): void {
		$fixture = \json_decode( (string) \file_get_contents( \dirname( __DIR__ ) . '/fixtures/station-layouts.json' ), true );
		$trees   = [];
		foreach ( self::CONTEXTS as $context ) {
			$trees[ $context ] = Composition::validate( $context, Composition::default_markup( $context ) );
		}
		$this->assertSame( $trees, $fixture );
	}

	public function test_the_overview_default_opens_on_the_fleet_and_closes_on_the_rows(): void {
		$tree = Composition::validate( 'newspack-nodes/station-overview', Composition::default_markup( 'newspack-nodes/station-overview' ) );
		$this->assertSame( 'newspack-nodes/stats', $tree[0]['name'] );
		$this->assertSame( 'nodes/fleet', $tree[0]['attributes']['source'] );
		$this->assertSame( 'newspack-nodes/topology-rows', \end( $tree )['name'] );
	}

	public function test_page_data_says_who_may_tune_and_holds_every_layout(): void {
		$this->log_in( [ 'manage_options' => true ] );
		$data = Station_Pages::page_data();
		$this->assertTrue( $data['canTune'] );
		$this->assertTrue( $data['canManage'] );
		$this->assertSame( \array_values( self::CONTEXTS ), \array_keys( $data['compositions'] ) );
		$this->assertSame( Composition_Store::read( 'newspack-nodes/station-jobs' ), $data['compositions']['newspack-nodes/station-jobs'] );
	}

	public function test_page_data_withholds_tune_from_a_reader(): void {
		$this->log_in( [] );
		$data = Station_Pages::page_data();
		$this->assertFalse( $data['canTune'] );
		$this->assertFalse( $data['canManage'] );
	}

	public function test_enqueue_sets_the_page_data_before_the_station_bundle(): void {
		$this->log_in( [ 'manage_options' => true ] );
		$GLOBALS['_inline_scripts'] = [];
		Station_Pages::enqueue( 'newspack-nodes-station', $this->make_temp_dir( 'station-unbuilt-' ), 'https://kaka-7930.test/build' );
		[ [ $handle, $script, $position ] ] = $GLOBALS['_inline_scripts'];
		$this->assertSame( [ 'newspack-nodes-station', 'before' ], [ $handle, $position ] );
		$prefix = 'window.' . Station_Pages::GLOBAL . ' = ';
		$this->assertStringStartsWith( $prefix, $script );
		$data = \json_decode( \substr( $script, \strlen( $prefix ), -1 ), true );
		$this->assertSame( Station_Pages::page_data(), $data );
		$this->assertArrayNotHasKey( Station_Pages::DASHBOARDS_EDITOR, $GLOBALS['_enqueued_scripts'] );
		$this->assertArrayNotHasKey( Station_Pages::AGGREGATOR_EDITOR, $GLOBALS['_enqueued_scripts'] );
	}

	public function test_the_page_data_cannot_close_its_script_element(): void {
		$this->log_in( [ 'manage_options' => true ] );
		\update_option( 'newspack_nodes_composition:newspack-nodes/station-jobs', [ 'markup' => '<!-- wp:paragraph --><p><strong>kea 7931</strong></p><!-- /wp:paragraph -->', 'actor' => 'kea', 'ts' => 1.5 ] );
		$GLOBALS['_inline_scripts'] = [];
		try {
			Station_Pages::enqueue( 'newspack-nodes-station', $this->make_temp_dir( 'station-unbuilt-' ), 'https://kaka-7930.test/build' );
		} finally {
			\delete_option( 'newspack_nodes_composition:newspack-nodes/station-jobs' );
		}
		$script = $GLOBALS['_inline_scripts'][0][1];
		$this->assertStringContainsString( 'kea 7931', $script );
		$this->assertStringNotContainsString( '<', $script );
	}

	public function test_enqueue_loads_the_dashboards_editor_on_its_pages_edit(): void {
		$this->log_in( [ 'manage_options' => true ] );
		$build = $this->make_temp_dir( 'station-editor-' );
		\mkdir( "{$build}/station-editor" );
		\file_put_contents( "{$build}/station-editor/layout-editor.js", 'x' );
		\file_put_contents( "{$build}/station-editor/layout-editor.asset.php", "<?php return [ 'dependencies' => [ 'wp-element' ], 'version' => 'kaka-7930' ];" );
		$_GET['edit'] = 'station-tables';
		Station_Pages::enqueue( 'newspack-nodes-station', $build, 'https://kaka-7930.test/build' );
		$this->assertArrayHasKey( Station_Pages::DASHBOARDS_EDITOR, $GLOBALS['_enqueued_scripts'] );
		$this->assertArrayNotHasKey( Station_Pages::AGGREGATOR_EDITOR, $GLOBALS['_enqueued_scripts'] );
		$this->assertSame( 'https://kaka-7930.test/build/station-editor/layout-editor.js', $GLOBALS['_registered_scripts'][ Station_Pages::DASHBOARDS_EDITOR ]['src'] );
		$this->assertSame( 'newspack-nodes/station-tables', $GLOBALS['_localized_scripts'][ Station_Pages::DASHBOARDS_EDITOR ]['data']['context'] );
		$this->rmdir_recursive( $build );
	}
}
