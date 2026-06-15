<?php
/**
 * EnqueueInsightsTest: the example's Publisher Insights enqueue now delegates
 * to the substrate's shared Admin::enqueue_react_page() registrar.
 *
 * Recording stubs (function_exists-guarded) capture the enqueue/localize calls
 * the registrar makes; assertions read them off the globals.
 */

declare(strict_types=1);

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
	if ( ! \function_exists( 'wp_create_nonce' ) ) {
		function wp_create_nonce( string $action ): string {
			return 'nonce_' . \substr( \md5( $action ), 0, 10 );
		}
	}
	if ( ! \function_exists( 'wp_style_add_data' ) ) {
		function wp_style_add_data( string $handle, string $key, $value ): bool {
			$GLOBALS['_style_data'][ $handle ][ $key ] = $value;
			return true;
		}
	}

	require_once \dirname( __DIR__ ) . '/example-ai-newsletter.php';
}

namespace Example_AI_Newsletter\Tests {

	use Newspack_Nodes\Tests\TestCase;
	use function Example_AI_Newsletter\enqueue_insights_assets;
	use const Example_AI_Newsletter\INSIGHTS_MENU_SLUG;

	final class EnqueueInsightsTest extends TestCase {

		protected function setUp(): void {
			parent::setUp();
			$GLOBALS['_enqueued_scripts']  = [];
			$GLOBALS['_enqueued_styles']   = [];
			$GLOBALS['_localized_scripts'] = [];
			$GLOBALS['_style_data']        = [];
			$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
			$_GET = [];
		}

		public function test_skips_on_wrong_page(): void {
			$_GET = [ 'page' => 'some-other-page' ];
			enqueue_insights_assets();
			$this->assertEmpty( $GLOBALS['_enqueued_scripts'] );
		}

		public function test_delegates_to_registrar_on_insights_page(): void {
			// The example ships build/dashboard/index.js + manifest; enqueue must
			// run through the substrate registrar and localize NewspackNodesData.
			$asset = \dirname( __DIR__ ) . '/build/dashboard/index.js';
			$this->assertFileExists( $asset, 'example dashboard build missing — run `npm run build`' );

			$_GET = [ 'page' => INSIGHTS_MENU_SLUG ];
			enqueue_insights_assets();

			$handle = 'example-ai-newsletter-insights';
			$this->assertArrayHasKey( $handle, $GLOBALS['_enqueued_scripts'] );
			$this->assertStringEndsWith( 'build/dashboard/index.js', (string) $GLOBALS['_enqueued_scripts'][ $handle ]['src'] );

			$this->assertArrayHasKey( $handle, $GLOBALS['_localized_scripts'] );
			$payload = $GLOBALS['_localized_scripts'][ $handle ];
			$this->assertSame( 'NewspackNodesData', $payload['object_name'] );
			$this->assertArrayHasKey( 'restUrl', $payload['data'] );
			$this->assertArrayHasKey( 'nonce', $payload['data'] );

			// Delegation-specific: the registrar activates RTL when index-rtl.css
			// ships (the old hand-rolled enqueue never did).
			if ( \file_exists( \dirname( __DIR__ ) . '/build/dashboard/index-rtl.css' ) ) {
				$this->assertSame( 'replace', $GLOBALS['_style_data'][ $handle ]['rtl'] ?? null );
			}
		}
	}
}
