<?php
/**
 * BlockEditorBootstrapTest: the block editor's boot sequence on a plain
 * admin page, in its two steps.
 *
 * `load_canvas()` brings up the block-editor canvas under a named editor
 * context; `load_content_blocks()` adds the core block library, the format
 * library and the classic-editor globals the freeform block reads. The
 * suite loads no WordPress: the block-editor shims in `Helpers/wp-shims.php`
 * record each WordPress call the bootstrap makes and model the one side
 * effect it guards against, `wp_editor()` marking `dashicons` done.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Block_Editor_Bootstrap;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Block_Editor_Bootstrap::class )]
final class BlockEditorBootstrapTest extends TestCase {

	private const REGISTER_CORE_BLOCKS = '( window.wp && window.wp.blockLibrary && window.wp.blockLibrary.registerCoreBlocks ) && window.wp.blockLibrary.registerCoreBlocks();';

	protected function setUp(): void {
		parent::setUp();
		\wp_shim_reset_block_editor();
		$GLOBALS['_enqueued_scripts']              = [];
		$GLOBALS['_enqueued_styles']               = [];
		$GLOBALS['_wp_test_server_block_settings'] = [ 'test/one' => [ 'title' => 'Harbor One' ] ];
		$GLOBALS['wp_styles']->done                = [ 'admin-bar' ];
		$this->reset_steps();
	}

	protected function tearDown(): void {
		$this->reset_steps();
		\wp_shim_reset_block_editor();
		parent::tearDown();
	}

	public function test_load_canvas_seeds_the_named_context(): void {
		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );

		$this->assertTrue( \apply_filters( 'should_load_block_editor_scripts_and_styles', false ) );
		$this->assertArrayHasKey( 'wp-block-editor', $GLOBALS['_enqueued_scripts'] );
		$this->assertArrayHasKey( 'wp-block-editor', $GLOBALS['_enqueued_styles'] );
		$this->assertSame(
			[
				'wp.blocks.setCategories( [{"slug":"for-test\/canvas-context"}] );',
				'wp.blocks.unstable__bootstrapServerSideBlockDefinitions({"test\/one":{"title":"Harbor One"}});',
			],
			$this->inline_data( 'wp-blocks' )
		);
		foreach ( [ 'wp-edit-post', 'wp-format-library', 'wp-block-library' ] as $handle ) {
			$this->assertArrayNotHasKey( $handle, $GLOBALS['_enqueued_scripts'], $handle );
		}
		$this->assertSame( [], $this->inline_data( 'wp-block-library' ) );
		$this->assertSame( [], $GLOBALS['_wp_test_wp_editor'] );
	}

	public function test_load_content_blocks_adds_the_library(): void {
		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );
		Block_Editor_Bootstrap::load_content_blocks();

		foreach ( [ 'wp-block-library', 'wp-edit-post', 'wp-format-library' ] as $handle ) {
			$this->assertArrayHasKey( $handle, $GLOBALS['_enqueued_scripts'], $handle );
		}
		foreach ( [ 'wp-edit-post', 'wp-format-library' ] as $handle ) {
			$this->assertArrayHasKey( $handle, $GLOBALS['_enqueued_styles'], $handle );
		}
		$this->assertSame(
			[
				[ 'wp-block-library', 'window.wpEditorL10n = {};', 'before' ],
				[ 'wp-block-library', self::REGISTER_CORE_BLOCKS, 'after' ],
			],
			\array_values(
				\array_filter( $GLOBALS['_inline_scripts'], static fn ( array $rec ): bool => 'wp-block-library' === $rec[0] )
			)
		);
		$this->assertSame( [ 'newspack-nodes-classic-editor-bootstrap' ], $GLOBALS['_wp_test_wp_editor'] );
		$this->assertTrue( $GLOBALS['_wp_test_default_editor'] );
	}

	public function test_load_content_blocks_keeps_dashicons_printable(): void {
		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );
		Block_Editor_Bootstrap::load_content_blocks();

		$this->assertSame( [ 'admin-bar' ], $GLOBALS['wp_styles']->done );
		$this->expectOutputString( '' );
	}

	public function test_a_throwing_editor_leaves_the_buffer_and_the_done_list_as_it_found_them(): void {
		$GLOBALS['_wp_test_wp_editor_throws'] = new \RuntimeException( 'Harbor editor refused' );
		$level                                = \ob_get_level();
		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );

		try {
			Block_Editor_Bootstrap::load_content_blocks();
			$this->fail( 'the editor\'s throw must propagate' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'Harbor editor refused', $e->getMessage() );
		}
		$this->assertSame( $level, \ob_get_level() );
		$this->assertSame( [ 'admin-bar' ], $GLOBALS['wp_styles']->done );
		$this->expectOutputString( '' );
	}

	public function test_a_throwing_editor_leaves_the_content_blocks_re_runnable(): void {
		$GLOBALS['_wp_test_wp_editor_throws'] = new \RuntimeException( 'Heron editor refused' );
		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );
		try {
			Block_Editor_Bootstrap::load_content_blocks();
			$this->fail( 'the editor\'s throw must propagate' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'Heron editor refused', $e->getMessage() );
		}
		$GLOBALS['_wp_test_wp_editor_throws'] = null;

		Block_Editor_Bootstrap::load_content_blocks();
		Block_Editor_Bootstrap::load_content_blocks();

		$this->assertCount( 2, $GLOBALS['_wp_test_wp_editor'] );
		$this->assertSame(
			[ 'window.wpEditorL10n = {};', self::REGISTER_CORE_BLOCKS ],
			$this->inline_data( 'wp-block-library' )
		);
		$this->expectOutputString( '' );
	}

	public function test_a_throwing_block_walk_leaves_each_inline_script_queued_once(): void {
		$GLOBALS['_wp_test_block_types'] = [
			(object) [
				'name'                  => 'heron/ledger',
				'editor_script_handles' => ( static function () {
					yield 'heron-ledger-editor';
					throw new \RuntimeException( 'Heron block walk refused' );
				} )(),
				'editor_style_handles'  => [],
			],
		];
		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );
		try {
			Block_Editor_Bootstrap::load_content_blocks();
			$this->fail( 'the walk\'s throw must propagate' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'Heron block walk refused', $e->getMessage() );
		}
		$GLOBALS['_wp_test_block_types'] = [];

		Block_Editor_Bootstrap::load_content_blocks();
		Block_Editor_Bootstrap::load_content_blocks();

		$this->assertSame(
			[ 'window.wpEditorL10n = {};', self::REGISTER_CORE_BLOCKS ],
			$this->inline_data( 'wp-block-library' )
		);
		$this->expectOutputString( '' );
	}

	public function test_categories_that_will_not_encode_refuse_the_canvas_and_seed_nothing(): void {
		$refusals = 1;
		\add_filter(
			'block_categories_all',
			static function ( array $categories ) use ( &$refusals ): array {
				return 0 < $refusals-- ? [ [ 'slug' => "heron-\xB1" ] ] : $categories;
			}
		);
		try {
			Block_Editor_Bootstrap::load_canvas( 'heron/ledger-layout' );
			$this->fail( 'unencodable categories must refuse the canvas' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'block categories for "heron/ledger-layout"', $e->getMessage() );
		}
		$this->assertSame( [], $this->inline_data( 'wp-blocks' ) );
		$this->assertArrayNotHasKey( 'wp-block-editor', $GLOBALS['_enqueued_scripts'] );

		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );
		$this->assertCount( 2, $this->inline_data( 'wp-blocks' ) );
	}

	public function test_server_definitions_that_will_not_encode_refuse_the_canvas(): void {
		$GLOBALS['_wp_test_server_block_settings'] = [ 'heron/ledger' => [ 'title' => "Heron \xB1" ] ];

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'server-side block definitions' );

		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );
	}

	public function test_a_throwing_category_filter_leaves_the_canvas_re_runnable(): void {
		$refusals = 1;
		\add_filter(
			'block_categories_all',
			static function ( array $categories ) use ( &$refusals ): array {
				if ( 0 < $refusals-- ) {
					throw new \RuntimeException( 'Heron categories refused' );
				}
				return $categories;
			}
		);
		try {
			Block_Editor_Bootstrap::load_canvas( 'heron/ledger-layout' );
			$this->fail( 'the filter\'s throw must propagate' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'Heron categories refused', $e->getMessage() );
		}

		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );
		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );

		$this->assertSame(
			[
				'wp.blocks.setCategories( [{"slug":"for-test\/canvas-context"}] );',
				'wp.blocks.unstable__bootstrapServerSideBlockDefinitions({"test\/one":{"title":"Harbor One"}});',
			],
			$this->inline_data( 'wp-blocks' )
		);
		$this->assertCount( 1, $GLOBALS['_wp_actions']['should_load_block_editor_scripts_and_styles'] );
	}

	public function test_a_second_canvas_under_another_context_is_refused(): void {
		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );

		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'load_canvas( "harbor/ledger-layout" ) after "test/canvas-context"' );

		Block_Editor_Bootstrap::load_canvas( 'harbor/ledger-layout' );
	}

	public function test_load_content_blocks_enqueues_each_non_core_blocks_editor_handles(): void {
		$GLOBALS['_wp_test_block_types'] = [
			(object) [
				'name'                  => 'core/paragraph',
				'editor_script_handles' => [ 'core-paragraph-editor' ],
				'editor_style_handles'  => [ 'core-paragraph-editor-style' ],
			],
			(object) [
				'name'                  => 'harbor/ledger',
				'editor_script_handles' => [ 'harbor-ledger-editor' ],
				'editor_style_handles'  => [ 'harbor-ledger-editor-style' ],
			],
		];
		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );
		Block_Editor_Bootstrap::load_content_blocks();

		$this->assertArrayHasKey( 'harbor-ledger-editor', $GLOBALS['_enqueued_scripts'] );
		$this->assertArrayHasKey( 'harbor-ledger-editor-style', $GLOBALS['_enqueued_styles'] );
		$this->assertArrayNotHasKey( 'core-paragraph-editor', $GLOBALS['_enqueued_scripts'] );
		$this->assertArrayNotHasKey( 'core-paragraph-editor-style', $GLOBALS['_enqueued_styles'] );
	}

	public function test_load_content_blocks_refuses_to_run_before_the_canvas(): void {
		$this->expectException( \LogicException::class );
		$this->expectExceptionMessage( 'load_canvas()' );

		Block_Editor_Bootstrap::load_content_blocks();
	}

	public function test_each_step_runs_once_per_request(): void {
		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );
		Block_Editor_Bootstrap::load_content_blocks();
		Block_Editor_Bootstrap::load_canvas( 'test/canvas-context' );
		Block_Editor_Bootstrap::load_content_blocks();

		$this->assertCount( 2, $this->inline_data( 'wp-blocks' ) );
		$this->assertSame(
			[ 'window.wpEditorL10n = {};', self::REGISTER_CORE_BLOCKS ],
			$this->inline_data( 'wp-block-library' )
		);
		$this->assertCount( 1, $GLOBALS['_wp_test_wp_editor'] );
		$this->assertCount( 1, $GLOBALS['_wp_actions']['should_load_block_editor_scripts_and_styles'] );
	}

	/**
	 * The data of every inline script added to `$handle`, in order.
	 *
	 * @return list<string>
	 */
	private function inline_data( string $handle ): array {
		$data = [];
		foreach ( $GLOBALS['_inline_scripts'] as [ $added_to, $script ] ) {
			if ( $handle === $added_to ) {
				$data[] = $script;
			}
		}
		return $data;
	}

	/** Clear the once-per-request gates, which outlive a test in-process. */
	private function reset_steps(): void {
		( new \ReflectionProperty( Block_Editor_Bootstrap::class, 'canvas_context' ) )->setValue( null, null );
		( new \ReflectionProperty( Block_Editor_Bootstrap::class, 'content_blocks_loaded' ) )->setValue( null, false );
	}
}
