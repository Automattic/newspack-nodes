<?php
/**
 * AdminTest: unit tests for the substrate WP-Settings-API admin surface.
 *
 * Owns its own minimal WP-Settings-API stubs so the runtime bootstrap stays
 * focused on substrate runtime concerns (Core, Router, Topic, etc.). The
 * stubs intentionally just record their arguments into globals — assertions
 * read those globals to verify the admin registered the right keys with the
 * right callbacks.
 *
 * Stubs MUST live in the global namespace because the Admin class calls them
 * with a leading backslash (e.g. `\register_setting(...)` resolves to
 * `\register_setting`, not `Newspack_Nodes\Admin\register_setting`). This file
 * therefore opens with a global-namespace `namespace { … }` block for the
 * stubs, then declares the test-class namespace below it.
 *
 * Auth/nonce stubs already exist in the runtime bootstrap; this file feeds
 * the right shape into `$GLOBALS['_wp_test_current_user_can']` and
 * `$GLOBALS['_wp_test_valid_nonces']` rather than redeclaring them.
 */

// -- WP Settings-API stubs (global namespace) -------------------------------

namespace {
	if ( ! \function_exists( 'register_setting' ) ) {
		function register_setting( string $group, string $option, array $args = [] ): void {
			$GLOBALS['_registered_settings'][ $option ] = [
				'group' => $group,
				'args'  => $args,
			];
		}
	}
	if ( ! \function_exists( 'add_settings_section' ) ) {
		function add_settings_section( string $id, string $title, callable $cb, string $page ): void {
			$GLOBALS['_registered_sections'][ $id ] = [
				'title'    => $title,
				'callback' => $cb,
				'page'     => $page,
			];
		}
	}
	if ( ! \function_exists( 'add_settings_field' ) ) {
		function add_settings_field( string $id, string $title, callable $cb, string $page, string $section ): void {
			$GLOBALS['_registered_fields'][ $id ] = [
				'title'    => $title,
				'callback' => $cb,
				'page'     => $page,
				'section'  => $section,
			];
		}
	}
	if ( ! \function_exists( 'settings_fields' ) ) {
		function settings_fields( string $group ): void {
			echo '<input type="hidden" name="option_page" value="' . \htmlspecialchars( $group, ENT_QUOTES ) . '" />';
		}
	}
	if ( ! \function_exists( 'do_settings_sections' ) ) {
		function do_settings_sections( string $page ): void {
			echo '<!-- do_settings_sections:' . \htmlspecialchars( $page, ENT_QUOTES ) . ' -->';
		}
	}
	if ( ! \function_exists( 'submit_button' ) ) {
		function submit_button( string $text = 'Save', string $type = 'primary', string $name = 'submit', bool $wrap = true ): void {
			echo '<input type="submit" />';
		}
	}
	if ( ! \function_exists( 'wp_nonce_field' ) ) {
		function wp_nonce_field( string $action, string $name ): void {
			echo '<input type="hidden" name="' . \htmlspecialchars( $name, ENT_QUOTES ) . '" value="' . \htmlspecialchars( ( $GLOBALS['_wp_test_valid_nonces'][ $action ] ?? '' ), ENT_QUOTES ) . '" />';
		}
	}
	if ( ! \function_exists( 'admin_url' ) ) {
		function admin_url( string $path = '' ): string {
			return 'http://localhost/wp-admin/' . \ltrim( $path, '/' );
		}
	}
	if ( ! \function_exists( 'add_query_arg' ) ) {
		function add_query_arg( array $args, string $url ): string {
			$sep = false === \strpos( $url, '?' ) ? '?' : '&';
			$kv  = [];
			foreach ( $args as $k => $v ) {
				$kv[] = \rawurlencode( (string) $k ) . '=' . \rawurlencode( (string) $v );
			}
			return $url . $sep . \implode( '&', $kv );
		}
	}
	if ( ! \function_exists( 'wp_safe_redirect' ) ) {
		// Redirect-then-exit short-circuits the test runner. Throw a sentinel
		// exception instead so each test can catch it explicitly.
		function wp_safe_redirect( string $url ): void {
			$GLOBALS['_last_redirect'] = $url;
			throw new \Newspack_Nodes\Tests\Unit\Admin\RedirectException( $url );
		}
	}
	if ( ! \function_exists( 'wp_die' ) ) {
		function wp_die( string $message ): void {
			throw new \RuntimeException( 'wp_die: ' . $message );
		}
	}
	if ( ! \function_exists( 'add_options_page' ) ) {
		function add_options_page( string $page_title, string $menu_title, string $cap, string $slug, callable $cb ): string {
			$GLOBALS['_options_pages'][ $slug ] = [
				'page_title' => $page_title,
				'menu_title' => $menu_title,
				'capability' => $cap,
				'callback'   => $cb,
			];
			return 'settings_page_' . $slug;
		}
	}
	if ( ! \function_exists( 'esc_textarea' ) ) {
		function esc_textarea( $v ): string {
			return \htmlspecialchars( (string) $v, ENT_QUOTES, 'UTF-8' );
		}
	}
	if ( ! \function_exists( 'checked' ) ) {
		function checked( $checked, $current = true ): string {
			$out = (string) $checked === (string) $current ? ' checked="checked"' : '';
			echo $out;
			return $out;
		}
	}
	if ( ! \function_exists( 'esc_attr' ) ) {
		function esc_attr( $v ): string {
			return \htmlspecialchars( (string) $v, ENT_QUOTES, 'UTF-8' );
		}
	}
	if ( ! \function_exists( 'esc_html__' ) ) {
		function esc_html__( string $v, string $domain = '' ): string {
			return \htmlspecialchars( $v, ENT_QUOTES, 'UTF-8' );
		}
	}
	if ( ! \function_exists( 'esc_html_e' ) ) {
		function esc_html_e( string $v, string $domain = '' ): void {
			echo \htmlspecialchars( $v, ENT_QUOTES, 'UTF-8' );
		}
	}
	if ( ! \function_exists( 'esc_attr__' ) ) {
		function esc_attr__( string $v, string $domain = '' ): string {
			return \htmlspecialchars( $v, ENT_QUOTES, 'UTF-8' );
		}
	}
	if ( ! \function_exists( 'esc_attr_e' ) ) {
		function esc_attr_e( string $v, string $domain = '' ): void {
			echo \htmlspecialchars( $v, ENT_QUOTES, 'UTF-8' );
		}
	}
	if ( ! \function_exists( 'esc_url' ) ) {
		function esc_url( string $v ): string {
			return $v;
		}
	}
	if ( ! \function_exists( 'esc_js' ) ) {
		function esc_js( string $v ): string {
			return \str_replace( [ "'", '"', '<', '>' ], [ "\\'", '\\"', '\\u003c', '\\u003e' ], $v );
		}
	}
	if ( ! \function_exists( '__' ) ) {
		function __( string $v, string $domain = '' ): string {
			return $v;
		}
	}
	if ( ! \function_exists( 'absint' ) ) {
		function absint( $v ): int {
			return \abs( (int) $v );
		}
	}

	// Substrate Admin class is normally required by the main plugin file's
	// `is_admin()` block; in tests `is_admin()` is undefined / falsey, so
	// require it here so this test can drive the class.
	require_once \dirname( __DIR__, 3 ) . '/includes/admin/class-admin.php';
}

// -- Test class -------------------------------------------------------------

namespace Newspack_Nodes\Tests\Unit\Admin {

use Newspack_Nodes\Admin\Admin;
use Newspack_Nodes\Config;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Sentinel: thrown by the wp_safe_redirect stub so tests can intercept the
 * redirect-then-exit flow without actually killing the PHP process.
 */
class RedirectException extends \RuntimeException {
}

#[CoversClass( Admin::class )]
class AdminTest extends TestCase {

	private string $base_dir;

	protected function setUp(): void {
		parent::setUp();
		// Reset state.
		$GLOBALS['_registered_settings']         = [];
		$GLOBALS['_registered_sections']         = [];
		$GLOBALS['_registered_fields']           = [];
		$GLOBALS['_options_pages']               = [];
		$GLOBALS['_wp_options']                  = [];
		$GLOBALS['_wp_actions']                  = [];
		$GLOBALS['_wp_test_current_user_can']    = [ 'manage_options' => true ];
		$GLOBALS['_last_redirect']               = null;

		// Pre-seed the runtime bootstrap's nonce table so the Admin's
		// wp_verify_nonce() call accepts the test's nonce. Tests build the
		// posted nonce via the valid_nonce() helper.
		$GLOBALS['_wp_test_valid_nonces'] = [
			Admin::RESET_ACTION => 'nonce_' . Admin::RESET_ACTION,
		];

		// Use /tmp directly to dodge realpath/symlink mismatches on hosts whose
		// sys_get_temp_dir() returns a symlinked path (e.g. macOS /var → /private/var).
		// Config::ensure_path() requires realpath() to match the input exactly.
		$this->base_dir = '/tmp/newspack-nodes-admin-test-' . \uniqid();
		\mkdir( $this->base_dir, 0755, true );

		// Point the runtime base_dir filter at our temp dir so Config::get_locks_directory() works.
		\add_filter(
			'newspack_nodes/base_dir',
			function () {
				return $this->base_dir;
			}
		);
		Config::reset();
	}

	protected function tearDown(): void {
		Config::reset();
		$this->rmdir_recursive( $this->base_dir );
		parent::tearDown();
	}

	/**
	 * Build a valid nonce matching the bootstrap's wp_verify_nonce stub.
	 */
	private function valid_nonce(): string {
		return $GLOBALS['_wp_test_valid_nonces'][ Admin::RESET_ACTION ];
	}

	// ---- register_settings ------------------------------------------------

	public function test_register_setting_calls_for_each_option(): void {
		$admin = new Admin();
		$admin->register_settings();

		$expected = [
			'newspack_nodes_enable_workers',
			'newspack_nodes_base_directory',
			'newspack_nodes_num_partitions',
			'newspack_nodes_num_segments',
			'newspack_nodes_segment_size',
			'newspack_nodes_max_lifespan',
			'newspack_nodes_memcache_servers',
			'newspack_nodes_aggregator_servers',
		];
		foreach ( $expected as $option ) {
			$this->assertArrayHasKey( $option, $GLOBALS['_registered_settings'], "missing option: $option" );
			$this->assertSame(
				Admin::OPTIONS_GROUP,
				$GLOBALS['_registered_settings'][ $option ]['group'],
				"option $option must be registered under the substrate group"
			);
			$this->assertArrayHasKey(
				'sanitize_callback',
				$GLOBALS['_registered_settings'][ $option ]['args'],
				"option $option must have a sanitize_callback"
			);
		}
	}

	public function test_register_settings_uses_sanitize_int_or_empty_for_int_options(): void {
		$admin = new Admin();
		$admin->register_settings();

		$int_options = [
			'newspack_nodes_num_partitions',
			'newspack_nodes_num_segments',
			'newspack_nodes_segment_size',
			'newspack_nodes_max_lifespan',
		];
		foreach ( $int_options as $option ) {
			$cb = $GLOBALS['_registered_settings'][ $option ]['args']['sanitize_callback'];
			$this->assertIsArray( $cb );
			$this->assertSame( 'sanitize_int_or_empty', $cb[1] );
			// Empty stays empty.
			$this->assertSame( '', \call_user_func( $cb, '' ) );
			// Coerces numeric.
			$this->assertSame( 42, \call_user_func( $cb, '42' ) );
		}
	}

	public function test_sanitize_memcache_servers_strips_invalid_entries(): void {
		$admin = new Admin();
		$admin->register_settings();

		$cb = $GLOBALS['_registered_settings']['newspack_nodes_memcache_servers']['args']['sanitize_callback'];
		$this->assertIsArray( $cb );
		$this->assertSame( 'sanitize_memcache_servers', $cb[1] );

		// Valid: host:port (incl. underscore for Docker container names).
		$this->assertSame( "127.0.0.1:11211\nmem-cache_1:11211", \call_user_func( $cb, "127.0.0.1:11211\nmem-cache_1:11211" ) );

		// Invalid lines silently dropped; valid ones survive.
		$this->assertSame( '127.0.0.1:11211', \call_user_func( $cb, "127.0.0.1:11211\nbogus_no_port\nhost:notaport" ) );

		// All-invalid input → empty string.
		$this->assertSame( '', \call_user_func( $cb, "no-port-here\nalso-bad" ) );

		// Empty / null preserved.
		$this->assertSame( '', \call_user_func( $cb, '' ) );
		$this->assertSame( '', \call_user_func( $cb, null ) );

		// Memcache servers must NOT be autoloaded (extended option).
		$this->assertFalse( $GLOBALS['_registered_settings']['newspack_nodes_memcache_servers']['args']['autoload'] );
	}

	public function test_register_settings_base_directory_rejects_relative_and_traversal(): void {
		$admin = new Admin();
		$admin->register_settings();

		$cb = $GLOBALS['_registered_settings']['newspack_nodes_base_directory']['args']['sanitize_callback'];
		$this->assertIsCallable( $cb );

		$this->assertSame( '/var/log/foo', \call_user_func( $cb, '/var/log/foo/' ) ); // trailing slash trimmed
		$this->assertSame( '', \call_user_func( $cb, 'relative/path' ) ); // not absolute
		$this->assertSame( '', \call_user_func( $cb, '/etc/../foo' ) );   // traversal
		$this->assertSame( '', \call_user_func( $cb, "with\0null" ) );    // null byte
		$this->assertSame( '', \call_user_func( $cb, '' ) );              // empty
	}

	public function test_register_settings_adds_general_and_storage_sections(): void {
		$admin = new Admin();
		$admin->register_settings();

		$this->assertArrayHasKey( 'newspack_nodes_general_section', $GLOBALS['_registered_sections'] );
		$this->assertArrayHasKey( 'newspack_nodes_storage_section', $GLOBALS['_registered_sections'] );

		// Fields populated under the right page.
		foreach ( [ 'enable_workers', 'num_partitions', 'num_segments', 'segment_size', 'max_lifespan', 'total_storage', 'base_directory', 'memcache_servers' ] as $field ) {
			$this->assertArrayHasKey( $field, $GLOBALS['_registered_fields'], "field $field not registered" );
			$this->assertSame( Admin::SETTINGS_PAGE, $GLOBALS['_registered_fields'][ $field ]['page'] );
		}
	}

	// ---- current_user_allowed --------------------------------------------

	public function test_current_user_allowed_requires_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = false;
		$this->assertFalse( Admin::current_user_allowed() );

		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$this->assertTrue( Admin::current_user_allowed() );
	}

	// ---- handle_reset_settings -------------------------------------------

	public function test_handle_reset_settings_rejects_missing_nonce(): void {
		$_POST = [];
		$admin = new Admin();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Security check failed' );
		$admin->handle_reset_settings();
	}

	public function test_handle_reset_settings_rejects_invalid_nonce(): void {
		$_POST = [ Admin::RESET_NONCE => 'wrong_value' ];
		$admin = new Admin();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'Security check failed' );
		$admin->handle_reset_settings();
	}

	public function test_handle_reset_settings_rejects_unauthorized_user(): void {
		$_POST                                                  = [ Admin::RESET_NONCE => $this->valid_nonce() ];
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = false;
		$admin                                                  = new Admin();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'You do not have permission' );
		$admin->handle_reset_settings();
	}

	public function test_handle_reset_settings_clears_substrate_options_only(): void {
		$_POST = [ Admin::RESET_NONCE => $this->valid_nonce() ];

		// Seed substrate + unrelated options.
		\update_option( 'newspack_nodes_enable_workers', 0 );
		\update_option( 'newspack_nodes_num_partitions', 8 );
		\update_option( 'unrelated_option', 'survives' );
		\update_option( 'newspack_event_logger_nodes_enable_logging', 1 );

		$admin = new Admin();
		try {
			$admin->handle_reset_settings();
			$this->fail( 'expected RedirectException from wp_safe_redirect()' );
		} catch ( RedirectException $e ) {
			// Expected — the handler completes via redirect.
		}

		$this->assertFalse( \get_option( 'newspack_nodes_enable_workers' ) );
		$this->assertFalse( \get_option( 'newspack_nodes_num_partitions' ) );
		$this->assertSame( 'survives', \get_option( 'unrelated_option' ) ); // unrelated options untouched
		// Application options are NOT touched by substrate reset.
		$this->assertSame( 1, \get_option( 'newspack_event_logger_nodes_enable_logging' ) );
		$this->assertNotNull( $GLOBALS['_last_redirect'] );
		$this->assertStringContainsString( Admin::MENU_SLUG, $GLOBALS['_last_redirect'] );
		$this->assertStringContainsString( 'reset=1', $GLOBALS['_last_redirect'] );
	}

	public function test_handle_reset_settings_only_deletes_prefixed_options_via_filter(): void {
		// Filter that tries to inject a non-prefixed option — must be silently dropped.
		\add_filter(
			'newspack_nodes/reset_options',
			function ( $opts ) {
				$opts[] = 'malicious_unrelated_option';
				return $opts;
			}
		);
		$_POST = [ Admin::RESET_NONCE => $this->valid_nonce() ];
		\update_option( 'malicious_unrelated_option', 'should-survive' );

		$admin = new Admin();
		try {
			$admin->handle_reset_settings();
			$this->fail( 'expected RedirectException' );
		} catch ( RedirectException $e ) {
			// Expected.
		}
		$this->assertSame( 'should-survive', \get_option( 'malicious_unrelated_option' ) );
	}

	// ---- maybe_request_worker_restart ------------------------------------

	public function test_maybe_request_worker_restart_no_op_for_unrelated_option(): void {
		$admin = new Admin();
		$admin->maybe_request_worker_restart( 'completely_unrelated_option' );

		// No lock dir created — nothing happened.
		$this->assertFalse( \is_dir( $this->base_dir . '/locks' ) );
	}

	public function test_maybe_request_worker_restart_no_op_for_application_option(): void {
		// Application-prefixed options are not the substrate Admin's
		// concern; it must early-return on prefix mismatch.
		$this->prepare_lock_dir( 'request-workers', 0 );
		$admin = new Admin();
		$admin->maybe_request_worker_restart( 'newspack_event_logger_nodes_log_events' );

		$this->assertFalse( \file_exists( $this->base_dir . '/locks/request-workers.p0.lock.d/restart' ) );
	}

	public function test_maybe_request_worker_restart_no_op_for_supervisor_only_options(): void {
		$this->prepare_lock_dir( 'request-workers', 0 );
		$this->prepare_lock_dir( 'job-workers', 0 );
		$admin = new Admin();
		$admin->maybe_request_worker_restart( 'newspack_nodes_enable_workers' );
		$admin->maybe_request_worker_restart( 'newspack_nodes_num_partitions' );
		$admin->maybe_request_worker_restart( 'newspack_nodes_aggregator_servers' );
		$this->assertFalse( \file_exists( $this->base_dir . '/locks/request-workers.p0.lock.d/restart' ) );
		$this->assertFalse( \file_exists( $this->base_dir . '/locks/job-workers.p0.lock.d/restart' ) );
	}

	public function test_maybe_request_worker_restart_all_workers_for_base_directory(): void {
		$this->prepare_lock_dir( 'request-workers', 0 );
		$this->prepare_lock_dir( 'job-workers', 0 );

		$admin = new Admin();
		$admin->maybe_request_worker_restart( 'newspack_nodes_base_directory' );

		$this->assertFileExists( $this->base_dir . '/locks/request-workers.p0.lock.d/restart' );
		$this->assertFileExists( $this->base_dir . '/locks/job-workers.p0.lock.d/restart' );
	}

	public function test_maybe_request_worker_restart_request_workers_for_memcache_servers(): void {
		$this->prepare_lock_dir( 'request-workers', 0 );
		$this->prepare_lock_dir( 'job-workers', 0 );

		$admin = new Admin();
		$admin->maybe_request_worker_restart( 'newspack_nodes_memcache_servers' );

		$this->assertFileExists( $this->base_dir . '/locks/request-workers.p0.lock.d/restart' );
		$this->assertFileDoesNotExist( $this->base_dir . '/locks/job-workers.p0.lock.d/restart' );
	}

	public function test_maybe_request_worker_restart_iterates_all_partitions(): void {
		// Force num_partitions=4 via the substrate WP option.
		\update_option( 'newspack_nodes_num_partitions', 4 );
		Config::reset();
		for ( $p = 0; $p < 4; $p++ ) {
			$this->prepare_lock_dir( 'request-workers', $p );
		}

		$admin = new Admin();
		$admin->maybe_request_worker_restart( 'newspack_nodes_memcache_servers' );

		for ( $p = 0; $p < 4; $p++ ) {
			$this->assertFileExists( "{$this->base_dir}/locks/request-workers.p{$p}.lock.d/restart" );
		}
	}

	public function test_maybe_request_worker_restart_filter_extends_groups(): void {
		$this->prepare_lock_dir( 'custom-workers', 0 );

		\add_filter(
			'newspack_nodes/worker_restart_groups',
			function ( $groups, $option_short ) {
				if ( 'memcache_servers' === $option_short ) {
					$groups[] = 'custom-workers';
				}
				return $groups;
			}
		);

		$admin = new Admin();
		$admin->maybe_request_worker_restart( 'newspack_nodes_memcache_servers' );

		$this->assertFileExists( $this->base_dir . '/locks/custom-workers.p0.lock.d/restart' );
	}

	// ---- render_settings_page --------------------------------------------

	public function test_render_settings_page_outputs_settings_fields_markup(): void {
		$admin = new Admin();
		$admin->register_settings();

		\ob_start();
		$admin->render_settings_page();
		$html = \ob_get_clean();

		// Settings-API plumbing rendered.
		$this->assertStringContainsString( 'option_page', $html );
		$this->assertStringContainsString( Admin::OPTIONS_GROUP, $html );
		$this->assertStringContainsString( 'do_settings_sections:' . Admin::SETTINGS_PAGE, $html );

		// Reset form is wired.
		$this->assertStringContainsString( Admin::RESET_ACTION, $html );
		$this->assertStringContainsString( Admin::RESET_NONCE, $html );

		// Submit + reset buttons present.
		$this->assertStringContainsString( '<input type="submit"', $html );
	}

	public function test_render_settings_page_blocks_unauthorized_user(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = false;
		$admin                                                  = new Admin();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'You do not have permission' );
		$admin->render_settings_page();
	}

	public function test_add_admin_menu_registers_options_page(): void {
		$admin = new Admin();
		$admin->add_admin_menu();
		$this->assertArrayHasKey( Admin::MENU_SLUG, $GLOBALS['_options_pages'] );
		$this->assertSame( 'manage_options', $GLOBALS['_options_pages'][ Admin::MENU_SLUG ]['capability'] );
	}

	public function test_add_admin_menu_skips_unauthorized_user(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = false;
		$admin                                                  = new Admin();
		$admin->add_admin_menu();
		$this->assertArrayNotHasKey( Admin::MENU_SLUG, $GLOBALS['_options_pages'] );
	}

	// ---- helpers ----------------------------------------------------------

	private function prepare_lock_dir( string $group, int $partition ): string {
		$dir = "{$this->base_dir}/locks/{$group}.p{$partition}.lock.d";
		\mkdir( $dir, 0755, true );
		return $dir;
	}
}

} // close namespace Newspack_Nodes\Tests\Unit\Admin
