<?php
/**
 * EnqueueReactPageTest: the shared React-dashboard enqueue registrar.
 *
 * Covers Admin::enqueue_react_page() in isolation: page-gating, the
 * index.js existence gate, manifest-vs-fallback deps/version, the CSS
 * sidecar (+ RTL activation), and the NewspackNodesData localize merge.
 *
 * Recording stubs mirror AdminTest's — guarded by function_exists so the two
 * files coexist regardless of load order; assertions read the same globals.
 */

namespace {
	if ( ! \function_exists( 'wp_enqueue_script' ) ) {
		function wp_enqueue_script( string $handle, string $src = '', array $deps = [], $ver = false, bool $in_footer = false ): void {
			$GLOBALS['_enqueued_scripts'][ $handle ] = [
				'src'       => $src,
				'deps'      => $deps,
				'version'   => $ver,
				'in_footer' => $in_footer,
			];
		}
	}
	if ( ! \function_exists( 'wp_enqueue_style' ) ) {
		function wp_enqueue_style( string $handle, string $src = '', array $deps = [], $ver = false ): void {
			$GLOBALS['_enqueued_styles'][ $handle ] = [
				'src'     => $src,
				'deps'    => $deps,
				'version' => $ver,
			];
		}
	}
	if ( ! \function_exists( 'wp_localize_script' ) ) {
		function wp_localize_script( string $handle, string $object_name, array $data ): bool {
			$GLOBALS['_localized_scripts'][ $handle ] = [
				'object_name' => $object_name,
				'data'        => $data,
			];
			return true;
		}
	}
	if ( ! \function_exists( 'wp_style_add_data' ) ) {
		function wp_style_add_data( string $handle, string $key, $value ): bool {
			$GLOBALS['_style_data'][ $handle ][ $key ] = $value;
			return true;
		}
	}
	if ( ! \function_exists( 'wp_create_nonce' ) ) {
		function wp_create_nonce( string $action ): string {
			return 'nonce_' . \substr( \md5( $action ), 0, 10 );
		}
	}

	require_once \dirname( __DIR__, 3 ) . '/includes/admin/class-admin.php';
}

namespace Newspack_Nodes\Tests\Unit\Admin {

	use Newspack_Nodes\Admin\Admin;
	use Newspack_Nodes\Tests\TestCase;
	use PHPUnit\Framework\Attributes\CoversClass;

	#[CoversClass( Admin::class )]
	class EnqueueReactPageTest extends TestCase {

		/** @var string Build-tree fixture dir, removed in tearDown. */
		private string $tree_dir;

		protected function setUp(): void {
			parent::setUp();
			$GLOBALS['_enqueued_scripts']  = [];
			$GLOBALS['_enqueued_styles']   = [];
			$GLOBALS['_localized_scripts'] = [];
			$GLOBALS['_style_data']        = [];
			$_GET                          = [];
			$this->tree_dir                = $this->make_temp_dir( 'react-page-tree-' );
		}

		protected function tearDown(): void {
			// make_temp_dir() doesn't auto-track its dirs for removal, so clean up ours.
			$this->rmdir_recursive( $this->tree_dir );
			parent::tearDown();
		}

		/** Write index.js + (optionally) a manifest + css sidecars into the fixture tree. */
		private function seed_tree( bool $manifest = false, bool $css = false, bool $rtl = false ): void {
			\file_put_contents( "{$this->tree_dir}/index.js", "console.log('x');" );
			if ( $manifest ) {
				\file_put_contents(
					"{$this->tree_dir}/index.asset.php",
					"<?php return array('dependencies' => array('react-jsx-runtime', 'wp-element'), 'version' => 'deadbeef');"
				);
			}
			if ( $css ) {
				\file_put_contents( "{$this->tree_dir}/index.css", '.x{}' );
			}
			if ( $rtl ) {
				\file_put_contents( "{$this->tree_dir}/index-rtl.css", '.x{}' );
			}
		}

		/** @param array<string,mixed> $extra */
		private function args( array $extra = [] ): array {
			return \array_merge(
				[
					'handle' => 'test-handle',
					'page'   => 'my-page',
					'dir'    => $this->tree_dir,
					'url'    => 'http://example.test/build/tree',
				],
				$extra
			);
		}

		// ---- page gating ------------------------------------------------------

		public function test_returns_null_and_enqueues_nothing_when_page_unset(): void {
			$this->seed_tree();
			$_GET = [];
			$this->assertNull( Admin::enqueue_react_page( $this->args() ) );
			$this->assertEmpty( $GLOBALS['_enqueued_scripts'] );
			$this->assertEmpty( $GLOBALS['_localized_scripts'] );
		}

		public function test_returns_null_when_page_not_in_list(): void {
			$this->seed_tree();
			$_GET = [ 'page' => 'some-other-page' ];
			$this->assertNull( Admin::enqueue_react_page( $this->args() ) );
			$this->assertEmpty( $GLOBALS['_enqueued_scripts'] );
		}

		public function test_accepts_array_of_page_slugs(): void {
			$this->seed_tree();
			$_GET = [ 'page' => 'page-b' ];
			$handle = Admin::enqueue_react_page( $this->args( [ 'page' => [ 'page-a', 'page-b' ] ] ) );
			$this->assertSame( 'test-handle', $handle );
			$this->assertArrayHasKey( 'test-handle', $GLOBALS['_enqueued_scripts'] );
		}

		// ---- index.js existence gate -----------------------------------------

		public function test_returns_null_when_index_js_missing(): void {
			// No seed_tree() — dir has no index.js.
			$_GET = [ 'page' => 'my-page' ];
			$this->assertNull( Admin::enqueue_react_page( $this->args() ) );
			$this->assertEmpty( $GLOBALS['_enqueued_scripts'] );
		}

		// ---- deps + version: manifest -----------------------------------------

		public function test_reads_manifest_deps_and_version(): void {
			$this->seed_tree( manifest: true );
			$_GET   = [ 'page' => 'my-page' ];
			$handle = Admin::enqueue_react_page( $this->args() );

			$this->assertSame( 'test-handle', $handle );
			$enq = $GLOBALS['_enqueued_scripts']['test-handle'];
			$this->assertSame( [ 'react-jsx-runtime', 'wp-element' ], $enq['deps'] );
			$this->assertSame( 'deadbeef', $enq['version'] );
			$this->assertSame( 'http://example.test/build/tree/index.js', $enq['src'] );
			$this->assertTrue( $enq['in_footer'] );
		}

		// ---- deps + version: fallback (no manifest) --------------------------

		public function test_falls_back_to_hardcoded_deps_and_filemtime_version(): void {
			$this->seed_tree( manifest: false );
			$_GET   = [ 'page' => 'my-page' ];
			$handle = Admin::enqueue_react_page( $this->args() );

			$this->assertSame( 'test-handle', $handle );
			$enq = $GLOBALS['_enqueued_scripts']['test-handle'];
			$this->assertSame( [ 'wp-element', 'wp-components', 'wp-api-fetch', 'wp-i18n' ], $enq['deps'] );
			// filemtime of the seeded index.js — a non-empty numeric string.
			$this->assertSame( (string) \filemtime( "{$this->tree_dir}/index.js" ), $enq['version'] );
		}

		// ---- CSS sidecar ------------------------------------------------------

		public function test_enqueues_index_css_when_present(): void {
			$this->seed_tree( css: true );
			$_GET = [ 'page' => 'my-page' ];
			Admin::enqueue_react_page( $this->args() );

			$this->assertArrayHasKey( 'test-handle', $GLOBALS['_enqueued_styles'] );
			$css = $GLOBALS['_enqueued_styles']['test-handle'];
			$this->assertSame( 'http://example.test/build/tree/index.css', $css['src'] );
			$this->assertSame( [ 'wp-components', 'newspack-nodes-theme' ], $css['deps'] );
		}

		public function test_skips_index_css_when_absent(): void {
			$this->seed_tree( css: false );
			$_GET = [ 'page' => 'my-page' ];
			Admin::enqueue_react_page( $this->args() );
			$this->assertArrayNotHasKey( 'test-handle', $GLOBALS['_enqueued_styles'] );
		}

		public function test_uses_caller_style_deps_when_given(): void {
			$this->seed_tree( css: true );
			$_GET = [ 'page' => 'my-page' ];
			Admin::enqueue_react_page( $this->args( [ 'style_deps' => [] ] ) );
			$this->assertSame( [], $GLOBALS['_enqueued_styles']['test-handle']['deps'] );
		}

		public function test_activates_rtl_when_rtl_css_present(): void {
			$this->seed_tree( css: true, rtl: true );
			$_GET = [ 'page' => 'my-page' ];
			Admin::enqueue_react_page( $this->args() );
			$this->assertSame( 'replace', $GLOBALS['_style_data']['test-handle']['rtl'] ?? null );
		}

		public function test_does_not_activate_rtl_when_no_rtl_css(): void {
			$this->seed_tree( css: true, rtl: false );
			$_GET = [ 'page' => 'my-page' ];
			Admin::enqueue_react_page( $this->args() );
			$this->assertArrayNotHasKey( 'test-handle', $GLOBALS['_style_data'] );
		}

		// ---- localize ---------------------------------------------------------

		public function test_localizes_rest_url_and_nonce(): void {
			$this->seed_tree();
			$_GET = [ 'page' => 'my-page' ];
			Admin::enqueue_react_page( $this->args() );

			$this->assertArrayHasKey( 'test-handle', $GLOBALS['_localized_scripts'] );
			$payload = $GLOBALS['_localized_scripts']['test-handle'];
			$this->assertSame( 'NewspackNodesData', $payload['object_name'] );
			$this->assertArrayHasKey( 'restUrl', $payload['data'] );
			$this->assertArrayHasKey( 'nonce', $payload['data'] );
			$this->assertNotSame( '', $payload['data']['nonce'] );
		}

		public function test_localize_extras_merge_in(): void {
			$this->seed_tree();
			$_GET = [ 'page' => 'my-page' ];
			Admin::enqueue_react_page( $this->args( [ 'localize' => [ 'tree' => 'topology-console', 'extra' => 7 ] ] ) );

			$data = $GLOBALS['_localized_scripts']['test-handle']['data'];
			$this->assertSame( 'topology-console', $data['tree'] );
			$this->assertSame( 7, $data['extra'] );
			// Defaults still present alongside the extras.
			$this->assertArrayHasKey( 'restUrl', $data );
			$this->assertArrayHasKey( 'nonce', $data );
		}

		public function test_localize_extras_override_default_rest_url(): void {
			$this->seed_tree();
			$_GET = [ 'page' => 'my-page' ];
			Admin::enqueue_react_page( $this->args( [ 'localize' => [ 'restUrl' => '/custom/rest/' ] ] ) );

			$data = $GLOBALS['_localized_scripts']['test-handle']['data'];
			$this->assertSame( '/custom/rest/', $data['restUrl'] );
		}
	}
}
