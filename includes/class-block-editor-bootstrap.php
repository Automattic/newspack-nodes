<?php
/**
 * The block editor's boot sequence on a plain admin page.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Boots the block editor on an admin page WordPress does not treat as an
 * editor screen.
 *
 * WordPress boots Gutenberg only on the post, site and widget editors, so on
 * any other admin page the editor bundles are never enqueued and nothing
 * seeds `wp.blocks`. This class runs that sequence by hand, following
 * `Automattic\Blocks_Everywhere\Editor::load()`, in two steps a page calls
 * from its `admin_enqueue_scripts` handler:
 *
 *  - `load_canvas( $context )` brings up the canvas the shared `BlockCanvas`
 *    component mounts, under a `WP_Block_Editor_Context` of that name.
 *  - `load_content_blocks()` adds the core blocks, the format library, the
 *    classic-editor globals the freeform block reads, and every non-core
 *    block's editor handles. A page editing only its own blocks skips it.
 *
 * Each step runs once per request: a second pass would append its inline
 * scripts again, and a repeated `registerCoreBlocks()` warns on every block
 * type it finds registered. A step counts as run only once it completes, so
 * one that throws runs again on the next call.
 */
class Block_Editor_Bootstrap {

	/**
	 * The editor context `load_canvas()` brought the canvas up under in this
	 * request, or null before it runs.
	 *
	 * @var string|null
	 */
	private static ?string $canvas_context = null;

	/**
	 * Whether `load_content_blocks()` has run in this request.
	 *
	 * @var bool
	 */
	private static bool $content_blocks_loaded = false;

	/**
	 * Add the content blocks to a canvas `load_canvas()` brought up.
	 *
	 *  1. Enqueue `wp-block-library`, `wp-edit-post` and `wp-format-library`,
	 *     which provides `core/link`; without it links are stripped.
	 *  2. Enqueue every non-core block type's editor script and style
	 *     handles. Nothing fires `enqueue_block_editor_assets` here, so core's
	 *     own registry walk never runs and those blocks would be missing from
	 *     the inserter.
	 *  3. Emit the classic-editor globals the freeform block reads,
	 *     `tinyMCEPreInit` through a buffered throwaway `wp_editor()`, then
	 *     `wpEditorL10n` through `wp_tinymce_inline_scripts()`. The editor
	 *     also marks `dashicons` done while `ob_end_clean()` throws the
	 *     stylesheet away, so the `$wp_styles->done` snapshot around it puts
	 *     the flag back and wp-admin still prints its icons.
	 *  4. Call `registerCoreBlocks()` from an inline script, the job the post
	 *     editor's JS entry point does for itself.
	 *
	 * Every inline script follows every step that can throw, so a retry after
	 * a throw queues each one once.
	 *
	 * @api Called from consumer plugins' admin pages (cross-repo, invisible here).
	 * @return void
	 * @throws \LogicException When `load_canvas()` has not run first, because
	 *                         the blocks would load without their categories.
	 */
	public static function load_content_blocks(): void {
		if ( null === self::$canvas_context ) {
			throw new \LogicException( 'Block_Editor_Bootstrap: call load_canvas() before load_content_blocks()' );
		}
		if ( self::$content_blocks_loaded ) {
			return;
		}

		\wp_enqueue_script( 'wp-block-library' );
		\wp_enqueue_script( 'wp-edit-post' );
		\wp_enqueue_script( 'wp-format-library' );
		\wp_enqueue_style( 'wp-edit-post' );
		\wp_enqueue_style( 'wp-format-library' );

		foreach ( \WP_Block_Type_Registry::get_instance()->get_all_registered() as $block_type ) {
			if ( \str_starts_with( $block_type->name, 'core/' ) ) {
				continue;
			}
			foreach ( $block_type->editor_script_handles as $handle ) {
				\wp_enqueue_script( $handle );
			}
			foreach ( $block_type->editor_style_handles as $handle ) {
				\wp_enqueue_style( $handle );
			}
		}

		self::emit_classic_editor_globals();

		\wp_add_inline_script(
			'wp-block-library',
			'( window.wp && window.wp.blockLibrary && window.wp.blockLibrary.registerCoreBlocks ) && window.wp.blockLibrary.registerCoreBlocks();',
			'after'
		);
		self::$content_blocks_loaded = true;
	}

	/**
	 * Emit `tinyMCEPreInit` and `wpEditorL10n` for the freeform block, leaving
	 * `$wp_styles->done` as the throwaway `wp_editor()` found it. `wp_editor()`
	 * loads `_WP_Editors` itself, ahead of `enqueue_default_editor()`.
	 *
	 * @return void
	 */
	private static function emit_classic_editor_globals(): void {
		global $wp_styles;

		/** @var \WP_Styles|null $wp_styles */
		$styles_done_before = $wp_styles ? $wp_styles->done : [];
		\ob_start();
		try {
			\wp_editor(
				'',
				'newspack-nodes-classic-editor-bootstrap',
				[
					'tinymce'       => true,
					'quicktags'     => false,
					'media_buttons' => false,
				]
			);
		} finally {
			\ob_end_clean();
			if ( $wp_styles ) {
				$wp_styles->done = $styles_done_before;
			}
		}
		\wp_tinymce_inline_scripts();
		\_WP_Editors::enqueue_default_editor();
	}

	/**
	 * Bring up the block-editor canvas under the named editor context.
	 *
	 * Forces `should_load_block_editor_scripts_and_styles` true, so every
	 * later reader of that gate treats the page as an editor screen; marking
	 * the screen a block editor instead would let wp-admin hide the page's
	 * own `.wrap` markup. Enqueues `wp-block-editor` and its styles, then
	 * seeds `wp.blocks` with the block categories for `$context` and the
	 * server-side block definitions, both inline on `wp-blocks` as
	 * `wp-admin/edit-form-blocks.php` seeds the post editor.
	 *
	 * A repeat call under the same context does nothing; one under another
	 * context throws, because the page's categories are already seeded. A
	 * call that throws seeds nothing, so the next call runs the step again.
	 *
	 * @param string $context The editor context name, which reaches every
	 *                        `block_categories_all` filter verbatim.
	 * @api Called from consumer plugins' admin pages (cross-repo, invisible here).
	 * @return void
	 * @throws \LogicException When the canvas is already up under another context.
	 * @throws \RuntimeException When the categories or the server-side block
	 *                           definitions will not encode as JSON.
	 */
	public static function load_canvas( string $context ): void {
		if ( $context === self::$canvas_context ) {
			return;
		}
		if ( null !== self::$canvas_context ) {
			throw new \LogicException(
				\sprintf(
					'Block_Editor_Bootstrap: load_canvas( "%s" ) after "%s"; one page boots one editor context',
					$context,
					self::$canvas_context
				)
			);
		}

		// Both reads run filters that may throw, so they precede every write.
		$categories  = self::encode(
			\get_block_categories( new \WP_Block_Editor_Context( [ 'name' => $context ] ) ),
			\sprintf( 'the block categories for "%s"', $context )
		);
		$server_defs = self::encode(
			\get_block_editor_server_block_settings(),
			'the server-side block definitions'
		);

		\add_filter( 'should_load_block_editor_scripts_and_styles', '__return_true' );
		\wp_enqueue_script( 'wp-block-editor' );
		\wp_enqueue_style( 'wp-block-editor' );
		\wp_add_inline_script(
			'wp-blocks',
			\sprintf( 'wp.blocks.setCategories( %s );', $categories ),
			'after'
		);
		// unstable__ is a stability flag, not a private API.
		\wp_add_inline_script(
			'wp-blocks',
			'wp.blocks.unstable__bootstrapServerSideBlockDefinitions(' . $server_defs . ');'
		);
		self::$canvas_context = $context;
	}

	/**
	 * Encode a seed for an inline script, refusing one that will not encode.
	 *
	 * @param mixed  $value What the inline script seeds.
	 * @param string $what  Names the value in the refusal.
	 * @return string The JSON.
	 * @throws \RuntimeException When `wp_json_encode()` answers false.
	 */
	private static function encode( mixed $value, string $what ): string {
		$json = \wp_json_encode( $value );
		if ( false === $json ) {
			throw new \RuntimeException( \sprintf( 'Block_Editor_Bootstrap: %s will not encode as JSON', $what ) );
		}
		return $json;
	}
}
