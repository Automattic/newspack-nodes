<?php
/**
 * DevtoolsTabBundlesTest: the devtools_tab_bundles registrar enqueues every
 * filter-registered contributor bundle on the hub + overlay-bearing pages.
 */

namespace {
	if ( ! \function_exists( 'wp_enqueue_script' ) ) {
		function wp_enqueue_script( string $handle, string $src = '', array $deps = [], $ver = false, bool $in_footer = false ): void {
			$GLOBALS['_enqueued_scripts'][ $handle ] = [ 'src' => $src ];
		}
	}
	if ( ! \function_exists( 'wp_enqueue_style' ) ) {
		function wp_enqueue_style( string $handle, string $src = '', array $deps = [], $ver = false ): void {}
	}
	if ( ! \function_exists( 'wp_localize_script' ) ) {
		function wp_localize_script( string $handle, string $object_name, array $data ): bool {
			$GLOBALS['_localized_scripts'][ $handle ] = [ 'data' => $data ];
			return true;
		}
	}
	if ( ! \function_exists( 'wp_create_nonce' ) ) {
		function wp_create_nonce( string $action ): string { return 'n'; }
	}
	require_once \dirname( __DIR__, 3 ) . '/includes/admin/class-admin.php';
}

namespace Newspack_Nodes\Tests\Unit\Admin {

	use Newspack_Nodes\Admin\Admin;
	use Newspack_Nodes\Tests\TestCase;
	use PHPUnit\Framework\Attributes\CoversClass;

	#[CoversClass( Admin::class )]
	class DevtoolsTabBundlesTest extends TestCase {

		private const HOOK = 'newspack_nodes/devtools_tab_bundles';

		private string $tree_dir;

		protected function setUp(): void {
			parent::setUp();
			$GLOBALS['_enqueued_scripts']  = [];
			$GLOBALS['_localized_scripts'] = [];
			$_GET                          = [];
			$this->tree_dir               = $this->make_temp_dir( 'devtools-bundle-' );
			\file_put_contents( "{$this->tree_dir}/index.js", 'x' );
		}

		protected function tearDown(): void {
			unset( $GLOBALS['_wp_actions'][ self::HOOK ] );
			$this->rmdir_recursive( $this->tree_dir );
			parent::tearDown();
		}

		private function register_bundle(): void {
			$dir = $this->tree_dir;
			\add_filter(
				self::HOOK,
				static fn ( array $b ) => \array_merge(
					$b,
					[ [ 'handle' => 'contrib-tab', 'dir' => $dir, 'url' => 'http://x/contrib' ] ]
				)
			);
		}

		public function test_enqueues_registered_bundle_on_the_hub_page(): void {
			$this->register_bundle();
			$_GET['page'] = Admin::TOPOLOGY_MENU_SLUG;
			( new Admin() )->enqueue_devtools_tab_bundles();
			$this->assertArrayHasKey( 'contrib-tab', $GLOBALS['_enqueued_scripts'] );
		}

		public function test_enqueues_on_the_overlay_bearing_rawlogs_page(): void {
			$this->register_bundle();
			$_GET['page'] = Admin::RAWLOGS_MENU_SLUG;
			( new Admin() )->enqueue_devtools_tab_bundles();
			$this->assertArrayHasKey( 'contrib-tab', $GLOBALS['_enqueued_scripts'] );
		}

		public function test_does_not_enqueue_on_an_unrelated_page(): void {
			$this->register_bundle();
			$_GET['page'] = 'some-other-plugin';
			( new Admin() )->enqueue_devtools_tab_bundles();
			$this->assertSame( [], $GLOBALS['_enqueued_scripts'] );
		}

		public function test_no_external_registrants_enqueues_only_the_substrate_bundle(): void {
			// The substrate registers its OWN bundles (event-dashboards + the
			// topology-console) on the filter, so with no EXTERNAL registrants none
			// of the contributor handles are enqueued.
			$_GET['page'] = Admin::TOPOLOGY_MENU_SLUG;
			( new Admin() )->enqueue_devtools_tab_bundles();
			$this->assertArrayNotHasKey( 'contrib-tab', $GLOBALS['_enqueued_scripts'] );
		}

		public function test_skips_malformed_bundle_entries_without_fatal(): void {
			$dir = $this->tree_dir;
			\add_filter(
				self::HOOK,
				static fn ( array $b ) => \array_merge(
					$b,
					[
						'oops',
						[ 'handle' => [ 'arr' ], 'dir' => $dir, 'url' => 'u' ],
						[ 'handle' => 'h', 'dir' => $dir ],
					]
				)
			);
			$_GET['page'] = Admin::TOPOLOGY_MENU_SLUG;
			( new Admin() )->enqueue_devtools_tab_bundles();
			// Malformed entries (string, non-scalar handle, missing url) are skipped
			// without fatal; the substrate's own event-dashboards bundle still
			// enqueues, but none of the malformed handles do.
			$this->assertArrayNotHasKey( 'h', $GLOBALS['_enqueued_scripts'] );
			$this->assertArrayNotHasKey( 'arr', $GLOBALS['_enqueued_scripts'] );
		}

		public function test_localize_drops_non_string_keys(): void {
			$dir = $this->tree_dir;
			\add_filter(
				self::HOOK,
				static fn ( array $b ) => \array_merge(
					$b,
					[ [ 'handle' => 'contrib-tab', 'dir' => $dir, 'url' => 'http://x/contrib', 'localize' => [ 'good' => 'v', 0 => 'bad' ] ] ]
				)
			);
			$_GET['page'] = Admin::TOPOLOGY_MENU_SLUG;
			( new Admin() )->enqueue_devtools_tab_bundles();
			$this->assertArrayHasKey( 'contrib-tab', $GLOBALS['_localized_scripts'] );
			$data = $GLOBALS['_localized_scripts']['contrib-tab']['data'];
			$this->assertArrayHasKey( 'good', $data );
			$this->assertArrayNotHasKey( 0, $data );
		}
	}
}
