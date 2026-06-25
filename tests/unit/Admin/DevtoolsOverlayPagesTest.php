<?php
/**
 * DevtoolsOverlayPagesTest: the `devtools_overlay_pages` registry collects admin
 * page slugs (besides the hub) that mount the debug overlay, so overlay-tab
 * bundles can enqueue their tab on any plugin's overlay page.
 */

namespace {
	require_once \dirname( __DIR__, 3 ) . '/includes/admin/class-admin.php';
}

namespace Newspack_Nodes\Tests\Unit\Admin {

	use Newspack_Nodes\Admin\Admin;
	use Newspack_Nodes\Tests\TestCase;
	use PHPUnit\Framework\Attributes\CoversClass;

	#[CoversClass( Admin::class )]
	class DevtoolsOverlayPagesTest extends TestCase {

		private const HOOK = 'newspack_nodes/devtools_overlay_pages';

		protected function tearDown(): void {
			unset( $GLOBALS['_wp_actions'][ self::HOOK ] );
			parent::tearDown();
		}

		public function test_returns_slugs_contributed_via_the_filter(): void {
			\add_filter(
				self::HOOK,
				static fn ( array $pages ): array => \array_merge( $pages, [ 'my-overlay-page' ] )
			);
			$this->assertSame( [ 'my-overlay-page' ], Admin::devtools_overlay_pages() );
		}

		public function test_returns_empty_with_no_registrants(): void {
			$this->assertSame( [], Admin::devtools_overlay_pages() );
		}

		public function test_filters_out_non_strings(): void {
			\add_filter(
				self::HOOK,
				static fn ( array $pages ): array => \array_merge( $pages, [ 'ok-page', 42, [ 'arr' ], null ] )
			);
			$this->assertSame( [ 'ok-page' ], Admin::devtools_overlay_pages() );
		}

		public function test_collapses_duplicate_slugs(): void {
			\add_filter(
				self::HOOK,
				static fn ( array $pages ): array => \array_merge( $pages, [ 'dup', 'dup' ] )
			);
			\add_filter(
				self::HOOK,
				static fn ( array $pages ): array => \array_merge( $pages, [ 'dup' ] )
			);
			$this->assertSame( [ 'dup' ], Admin::devtools_overlay_pages() );
		}
	}
}
