<?php
/**
 * DevtoolsTabBundlesTest: the devtools_tab_bundles registrar enqueues every
 * filter-registered contributor bundle on the hub + overlay-bearing pages.
 *
 * The enqueue/localize/nonce recorder stubs are shared from tests/bootstrap.php.
 */

namespace {
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
			$GLOBALS['_enqueued_styles']   = [];
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
			// The top-level "Nodes" hub is the sole overlay/tab-bearing page now —
			// Raw Logs became a `host:'hub'` tab, so its former standalone page is
			// gone. The hub is where every contributor bundle enqueues.
			$this->register_bundle();
			$_GET['page'] = Admin::HUB_MENU_SLUG;
			( new Admin() )->enqueue_devtools_tab_bundles();
			$this->assertArrayHasKey( 'contrib-tab', $GLOBALS['_enqueued_scripts'] );
		}

		public function test_eager_bundle_css_keeps_the_registrar_default_ui_dependencies(): void {
			\file_put_contents( "{$this->tree_dir}/index.css", 'body{color:rgb(17,73,149)}' );
			$this->register_bundle();
			$_GET['page'] = Admin::HUB_MENU_SLUG;

			( new Admin() )->enqueue_devtools_tab_bundles();

			$this->assertSame(
				[ 'wp-components', 'newspack-nodes-ui' ],
				$GLOBALS['_enqueued_styles']['contrib-tab']['deps'] ?? null
			);
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
			$_GET['page'] = Admin::HUB_MENU_SLUG;
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
			$_GET['page'] = Admin::HUB_MENU_SLUG;
			( new Admin() )->enqueue_devtools_tab_bundles();
			// Malformed entries (string, non-scalar handle, missing url) are skipped
			// without fatal; the substrate's own event-dashboards bundle still
			// enqueues, but none of the malformed handles do.
			$this->assertArrayNotHasKey( 'h', $GLOBALS['_enqueued_scripts'] );
			$this->assertArrayNotHasKey( 'arr', $GLOBALS['_enqueued_scripts'] );
		}

		public function test_lazy_bundle_is_registered_for_on_demand_load_not_enqueued(): void {
			// A bundle flagged `lazy` must NOT ship up front; instead its script +
			// style URLs and localize payload are collected into the hub's
			// `NewspackNodesLazyTabs` map so a tab-click loader can inject it.
			$dir = $this->tree_dir;
			\file_put_contents( "{$dir}/index.css", 'body{color:teal}' );
			\add_filter(
				self::HOOK,
				static fn ( array $b ) => \array_merge(
					$b,
					[ [ 'handle' => 'lazy-tab', 'dir' => $dir, 'url' => 'http://x/lazy', 'lazy' => true, 'localize' => [ 'quux' => 'zonk' ] ] ]
				)
			);
			$_GET['page'] = Admin::HUB_MENU_SLUG;
			( new Admin() )->enqueue_devtools_tab_bundles();

			// Deferred: the lazy bundle is not enqueued on page load.
			$this->assertArrayNotHasKey( 'lazy-tab', $GLOBALS['_enqueued_scripts'] );

			// Its load recipe rides the hub handle under NewspackNodesLazyTabs.
			$this->assertArrayHasKey( 'newspack-nodes-devtools-hub', $GLOBALS['_localized_scripts'] );
			$localized = $GLOBALS['_localized_scripts']['newspack-nodes-devtools-hub'];
			$this->assertSame( 'NewspackNodesLazyTabs', $localized['object_name'] );
			$this->assertArrayHasKey( 'lazy-tab', $localized['data'] );

			$entry = $localized['data']['lazy-tab'];
			$this->assertStringContainsString( 'http://x/lazy/index.js', $entry['src'] );
			$this->assertStringContainsString( 'http://x/lazy/index.css', $entry['style'] );
			$this->assertArrayNotHasKey( 'deps', $entry );
			$this->assertArrayNotHasKey( 'styleDeps', $entry );
			// The per-tab localize + the shared restUrl/nonce ride the entry so the
			// injected bundle reads the same NewspackNodesData it would if enqueued.
			$this->assertSame( 'zonk', $entry['data']['quux'] );
			$this->assertArrayHasKey( 'restUrl', $entry['data'] );
		}

		public function test_lazy_bundle_does_no_work_on_an_unrelated_page(): void {
			// admin_enqueue_scripts fires on EVERY wp-admin page; the lazy branch
			// does filesystem work (file_exists/filemtime/md5_file) that must be
			// gated to the hub page like the eager branch already is.
			$dir = $this->tree_dir;
			\add_filter(
				self::HOOK,
				static fn ( array $b ) => \array_merge(
					$b,
					[ [ 'handle' => 'lazy-tab', 'dir' => $dir, 'url' => 'http://x/lazy', 'lazy' => true ] ]
				)
			);
			$_GET['page'] = 'some-other-plugin';
			( new Admin() )->enqueue_devtools_tab_bundles();
			$this->assertArrayNotHasKey( 'newspack-nodes-devtools-hub', $GLOBALS['_localized_scripts'] );
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
			$_GET['page'] = Admin::HUB_MENU_SLUG;
			( new Admin() )->enqueue_devtools_tab_bundles();
			$this->assertArrayHasKey( 'contrib-tab', $GLOBALS['_localized_scripts'] );
			$data = $GLOBALS['_localized_scripts']['contrib-tab']['data'];
			$this->assertArrayHasKey( 'good', $data );
			$this->assertArrayNotHasKey( 0, $data );
		}
	}
}
