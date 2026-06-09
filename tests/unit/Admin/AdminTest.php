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
	if ( ! \function_exists( 'add_menu_page' ) ) {
		function add_menu_page(
			string $page_title,
			string $menu_title,
			string $cap,
			string $slug,
			callable $cb,
			string $icon = '',
			?int $position = null
		): string {
			$GLOBALS['_admin_menu_pages'][ $slug ] = [
				'page_title' => $page_title,
				'menu_title' => $menu_title,
				'capability' => $cap,
				'callback'   => $cb,
				'icon'       => $icon,
				'position'   => $position,
			];
			return 'toplevel_page_' . $slug;
		}
	}
	if ( ! \function_exists( 'add_submenu_page' ) ) {
		function add_submenu_page(
			string $parent_slug,
			string $page_title,
			string $menu_title,
			string $cap,
			string $slug,
			callable $cb
		): string {
			$GLOBALS['_admin_submenu_pages'][ $slug ] = [
				'parent_slug' => $parent_slug,
				'page_title'  => $page_title,
				'menu_title'  => $menu_title,
				'capability'  => $cap,
				'callback'    => $cb,
			];
			return $parent_slug . '_page_' . $slug;
		}
	}
	if ( ! \function_exists( 'wp_enqueue_script' ) ) {
		function wp_enqueue_script(
			string $handle,
			string $src = '',
			array $deps = [],
			$ver = false,
			bool $in_footer = false
		): void {
			$GLOBALS['_enqueued_scripts'][ $handle ] = [
				'src'       => $src,
				'deps'      => $deps,
				'version'   => $ver,
				'in_footer' => $in_footer,
			];
		}
	}
	if ( ! \function_exists( 'wp_enqueue_style' ) ) {
		function wp_enqueue_style(
			string $handle,
			string $src = '',
			array $deps = [],
			$ver = false
		): void {
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
		$GLOBALS['_admin_menu_pages']            = [];
		$GLOBALS['_admin_submenu_pages']         = [];
		$GLOBALS['_enqueued_scripts']            = [];
		$GLOBALS['_enqueued_styles']             = [];
		$GLOBALS['_localized_scripts']           = [];
		$GLOBALS['_wp_options']                  = [];
		$GLOBALS['_wp_actions']                  = [];
		$GLOBALS['_wp_test_current_user_can']    = [ 'manage_options' => true ];
		$GLOBALS['_wp_test_current_user_login']  = '';
		$GLOBALS['_last_redirect']               = null;
		// Sanitize $_GET so enqueue_topology_console_assets() isn't influenced by
		// a previous test that left a page= behind.
		$_GET = [];

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

		$this->use_base_dir( $this->base_dir );
	}

	protected function tearDown(): void {
		Config::reset();
		// Clear any registry leakage from tests that registered stock dirs;
		// the next test starts with an empty registry.
		if ( \class_exists( '\\Newspack_Nodes\\Topology_Registry' ) ) {
			\Newspack_Nodes\Topology_Registry::reset();
		}
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
			'newspack_nodes_base_directory',
			'newspack_nodes_num_partitions',
			'newspack_nodes_num_segments',
			'newspack_nodes_segment_size',
			'newspack_nodes_max_lifespan',
			'newspack_nodes_memcache_servers',
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

		// Valid: host:port (incl. underscore for Docker container names). Stored as the typed array shape.
		$this->assertSame( [ '127.0.0.1:11211', 'mem-cache_1:11211' ], \call_user_func( $cb, "127.0.0.1:11211\nmem-cache_1:11211" ) );

		// Invalid lines silently dropped; valid ones survive.
		$this->assertSame( [ '127.0.0.1:11211' ], \call_user_func( $cb, "127.0.0.1:11211\nbogus_no_port\nhost:notaport" ) );

		// All-invalid input → empty array.
		$this->assertSame( [], \call_user_func( $cb, "no-port-here\nalso-bad" ) );

		// Empty / null → empty array.
		$this->assertSame( [], \call_user_func( $cb, '' ) );
		$this->assertSame( [], \call_user_func( $cb, null ) );

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

		$this->assertArrayHasKey( 'newspack_nodes_storage_section', $GLOBALS['_registered_sections'] );

		// Fields populated under the right page.
		foreach ( [ 'num_partitions', 'num_segments', 'segment_size', 'max_lifespan', 'total_storage', 'base_directory', 'memcache_servers' ] as $field ) {
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

	public function test_current_user_allowed_empty_whitelist_allows_any_admin(): void {
		$this->use_base_dir( $this->base_dir, [ 'allowed_users' => [] ] );
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$GLOBALS['_wp_test_current_user_login']                 = 'someone';
		$this->assertTrue( Admin::current_user_allowed() );
	}

	public function test_current_user_allowed_whitelist_admits_listed_user(): void {
		$this->use_base_dir( $this->base_dir, [ 'allowed_users' => [ 'alice', 'bob' ] ] );
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$GLOBALS['_wp_test_current_user_login']                 = 'bob';
		$this->assertTrue( Admin::current_user_allowed() );
	}

	public function test_current_user_allowed_whitelist_blocks_unlisted_user(): void {
		$this->use_base_dir( $this->base_dir, [ 'allowed_users' => [ 'alice', 'bob' ] ] );
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$GLOBALS['_wp_test_current_user_login']                 = 'carol';
		$this->assertFalse( Admin::current_user_allowed() );
	}

	public function test_current_user_allowed_whitelist_still_requires_manage_options(): void {
		$this->use_base_dir( $this->base_dir, [ 'allowed_users' => [ 'alice' ] ] );
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = false;
		$GLOBALS['_wp_test_current_user_login']                 = 'alice';
		$this->assertFalse( Admin::current_user_allowed() );
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

		$this->assertFalse( \get_option( 'newspack_nodes_num_partitions' ) );
		$this->assertSame( 'survives', \get_option( 'unrelated_option' ) ); // unrelated options untouched
		// Application options are NOT touched by substrate reset.
		$this->assertSame( 1, \get_option( 'newspack_event_logger_nodes_enable_logging' ) );
		$this->assertNotNull( $GLOBALS['_last_redirect'] );
		$this->assertStringContainsString( Admin::MENU_SLUG, $GLOBALS['_last_redirect'] );
		$this->assertStringContainsString( 'reset=1', $GLOBALS['_last_redirect'] );
	}

	public function test_handle_reset_settings_clears_topologies(): void {
		// Reset must delete every UI-exposed setting — including the selection
		// key `topologies`, which is excluded from delete-on-blank but resets via
		// its toggle. (allowed_users is NOT a settings field, so it's not in the
		// reset set.)
		$_POST = [ Admin::RESET_NONCE => $this->valid_nonce() ];
		\update_option( 'newspack_nodes_topologies', [ 'combined' ] );

		$admin = new Admin();
		try {
			$admin->handle_reset_settings();
			$this->fail( 'expected RedirectException' );
		} catch ( RedirectException $e ) {
			// Expected.
		}

		$this->assertFalse( \get_option( 'newspack_nodes_topologies' ), 'reset must delete topologies' );
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
		$admin->maybe_request_worker_restart( 'newspack_nodes_num_partitions' );
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

	// ---- section callbacks -----------------------------------------------

public function test_storage_section_callback_outputs_paragraph(): void {
		$admin = new Admin();

		\ob_start();
		$admin->storage_section_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( '<p>', $html );
		$this->assertStringContainsString( 'log storage', $html );
	}

	// ---- base_directory_callback (render_directory_field) ----------------

	public function test_base_directory_callback_renders_text_input_with_default_placeholder(): void {
		// No option saved → placeholder shows the default; value is empty.
		$admin = new Admin();

		\ob_start();
		$admin->base_directory_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'type="text"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_base_directory"', $html );
		$this->assertStringContainsString( 'id="base_directory"', $html );
		$this->assertStringContainsString( 'value=""', $html );
		// Default-placeholder + reset button + description block + class="regular-text code".
		$this->assertStringContainsString( 'class="regular-text code"', $html );
		$this->assertStringContainsString( 'placeholder="', $html );
		$this->assertStringContainsString( 'Base directory for logs', $html );
		// Per-field reset toggle: wrapper carries the marker name, button is the toggle.
		$this->assertStringContainsString( 'data-nn-reset="newspack_nodes_reset[newspack_nodes_base_directory]"', $html );
		$this->assertStringContainsString( 'data-nn-reset-toggle', $html );
	}

	public function test_base_directory_callback_renders_saved_value(): void {
		\update_option( 'newspack_nodes_base_directory', '/var/log/foo' );
		$admin = new Admin();

		\ob_start();
		$admin->base_directory_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'value="/var/log/foo"', $html );
	}

	// ---- num_partitions_callback (render_number_field, max=16 → small-text) --

	public function test_num_partitions_callback_renders_number_input_with_bounds(): void {
		$admin = new Admin();

		\ob_start();
		$admin->num_partitions_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'type="number"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_num_partitions"', $html );
		$this->assertStringContainsString( 'id="num_partitions"', $html );
		$this->assertStringContainsString( 'min="1"', $html );
		$this->assertStringContainsString( 'max="16"', $html );
		// max <= 999 → small-text input class.
		$this->assertStringContainsString( 'class="small-text"', $html );
		// Per-field reset toggle.
		$this->assertStringContainsString( 'data-nn-reset="newspack_nodes_reset[newspack_nodes_num_partitions]"', $html );
		$this->assertStringContainsString( 'data-nn-reset-toggle', $html );
		// No saved option → empty value, default in placeholder.
		$this->assertStringContainsString( 'value=""', $html );
	}

	public function test_num_partitions_callback_renders_saved_value_when_not_default(): void {
		// Save a value different from the default (1) — should render that value, not empty.
		\update_option( 'newspack_nodes_num_partitions', 4 );
		$admin = new Admin();

		\ob_start();
		$admin->num_partitions_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'value="4"', $html );
	}

	public function test_num_partitions_callback_blanks_value_when_equals_default(): void {
		// Saving a value equal to the default also blanks the input (uses placeholder).
		\update_option( 'newspack_nodes_num_partitions', 1 );
		$admin = new Admin();

		\ob_start();
		$admin->num_partitions_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'value=""', $html );
	}

	// ---- num_segments_callback (max=32 → small-text) ---------------------

	public function test_num_segments_callback_renders_number_input_with_bounds(): void {
		$admin = new Admin();

		\ob_start();
		$admin->num_segments_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'type="number"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_num_segments"', $html );
		$this->assertStringContainsString( 'id="num_segments"', $html );
		$this->assertStringContainsString( 'min="2"', $html );
		$this->assertStringContainsString( 'max="32"', $html );
		// max <= 999.
		$this->assertStringContainsString( 'class="small-text"', $html );
	}

	// ---- segment_size_callback (max=536870912 → regular-text) ------------

	public function test_segment_size_callback_renders_number_input_with_bounds(): void {
		$admin = new Admin();

		\ob_start();
		$admin->segment_size_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'type="number"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_segment_size"', $html );
		$this->assertStringContainsString( 'min="1048576"', $html );
		$this->assertStringContainsString( 'max="536870912"', $html );
		// max > 999 → regular-text branch.
		$this->assertStringContainsString( 'class="regular-text"', $html );
	}

	// ---- max_lifespan_callback (max=604800 → regular-text) ---------------

	public function test_max_lifespan_callback_renders_number_input_with_bounds(): void {
		$admin = new Admin();

		\ob_start();
		$admin->max_lifespan_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'type="number"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_max_lifespan"', $html );
		$this->assertStringContainsString( 'min="0"', $html );
		$this->assertStringContainsString( 'max="604800"', $html );
		// max > 999 → regular-text branch.
		$this->assertStringContainsString( 'class="regular-text"', $html );
	}

	// ---- memcache_servers_callback ---------------------------------------

	public function test_memcache_servers_callback_renders_textarea_with_placeholder(): void {
		// No saved option — textarea is empty, placeholder reflects the configured defaults
		// loaded from the installed config file (env-specific: dev container uses
		// memcache1:11211, vanilla install would use 127.0.0.1:11211). Don't pin the
		// exact host — pin the shape and the source-of-truth (Config::load_config_defaults).
		$admin = new Admin();

		\ob_start();
		$admin->memcache_servers_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( '<textarea', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_memcache_servers"', $html );
		$this->assertStringContainsString( 'id="memcache_servers"', $html );
		$this->assertStringContainsString( 'class="regular-text code"', $html );

		// Placeholder must match what Config returns as default.
		$defaults = \Newspack_Nodes\Config::load_config_defaults();
		$expected = (string) ( $defaults['memcache_servers'][0] ?? '127.0.0.1:11211' );
		$this->assertStringContainsString( 'placeholder="' . $expected . '"', $html );

		$this->assertStringContainsString( 'one per line', $html );
		// Empty textarea body.
		$this->assertMatchesRegularExpression( '/<textarea[^>]*><\/textarea>/', $html );
		// Per-field reset toggle.
		$this->assertStringContainsString( 'data-nn-reset="newspack_nodes_reset[newspack_nodes_memcache_servers]"', $html );
		$this->assertStringContainsString( 'data-nn-reset-toggle', $html );
	}

	public function test_memcache_servers_callback_renders_saved_value(): void {
		// Stored as the typed array shape; the textarea joins entries with newlines.
		\update_option( 'newspack_nodes_memcache_servers', [ '10.0.0.1:11211', '10.0.0.2:11211' ] );
		$admin = new Admin();

		\ob_start();
		$admin->memcache_servers_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( "10.0.0.1:11211\n10.0.0.2:11211", $html );
	}

	// ---- topologies_callback ---------------------------------------------

	/**
	 * Register a 4-topology fixture: a stock dir of .tsl files drives the
	 * available checkbox list, and the `newspack_nodes/topologies` filter
	 * publishes the full catalog. The config-file `topologies` default is a
	 * 2-entry SUBSET — what the admin must treat as "the default".
	 *
	 * @return array{0:string[],1:string[]} [ all available names, config default subset ]
	 */
	private function seed_topology_fixture(): array {
		$all    = [ 'aggregator', 'digest', 'firehose-workers-and-jobs', 'request-workers' ];
		$subset = [ 'digest', 'request-workers' ];

		// Config-file default `topologies` = the curated subset.
		$this->use_base_dir( $this->base_dir, [ 'topologies' => $subset ] );

		// Stock dir of .tsl files → Topology_Registry::list() (the checkboxes).
		$stock = $this->make_temp_dir( 'admin-topo-stock-' );
		foreach ( $all as $name ) {
			\file_put_contents( "{$stock}/{$name}.tsl", "# {$name}\n" );
		}
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $stock );

		// Catalog filter publishes ALL of them (the OLD, buggy default source).
		\add_filter(
			'newspack_nodes/topologies',
			static function () use ( $all ): array {
				return \array_fill_keys( $all, [ 'num_partitions' => 1 ] );
			}
		);

		return [ $all, $subset ];
	}

	public function test_topologies_callback_renders_per_field_reset_toggle(): void {
		$this->seed_topology_fixture();
		$admin = new Admin();

		\ob_start();
		$admin->topologies_callback();
		$html = \ob_get_clean();

		// The selection field has the SAME per-field reset toggle as every other
		// field — resetting deletes the option so the config-file default subset
		// takes over (the subset itself is asserted by the unset-render test).
		$this->assertStringContainsString( 'data-nn-reset="newspack_nodes_reset[newspack_nodes_topologies]"', $html );
		$this->assertStringContainsString( 'data-nn-reset-toggle', $html );
		$this->assertStringNotContainsString( 'data-newspack-nodes-load-defaults', $html );
	}

	public function test_topologies_callback_checks_config_default_when_option_unset(): void {
		$this->seed_topology_fixture();
		// No saved option → render reflects the config-file default (the subset).
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		$admin = new Admin();

		\ob_start();
		$admin->topologies_callback();
		$html = \ob_get_clean();

		// Subset entries are checked; non-default catalog entries are not.
		$this->assertMatchesRegularExpression( '/value="digest" checked/', $html );
		$this->assertMatchesRegularExpression( '/value="request-workers" checked/', $html );
		$this->assertDoesNotMatchRegularExpression( '/value="aggregator" checked/', $html );
		$this->assertDoesNotMatchRegularExpression( '/value="firehose-workers-and-jobs" checked/', $html );
	}

	// ---- total_storage_callback ------------------------------------------

	public function test_total_storage_callback_renders_storage_display(): void {
		// No options saved — uses defaults from config.
		$admin = new Admin();

		\ob_start();
		$admin->total_storage_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'id="total_storage_display"', $html );
		$this->assertStringContainsString( 'MB', $html );
		// Calculated-as caption.
		$this->assertStringContainsString( 'Calculated as', $html );
		// Description references the segment-MB and partitions/segments breakdown.
		$this->assertStringContainsString( 'segment ', $html );
		$this->assertStringContainsString( 'partitions', $html );
		$this->assertStringContainsString( 'logs', $html );
	}

	public function test_total_storage_callback_counts_logs_from_disk(): void {
		// `num_logs` factor now reads from `Log_Discovery::on_disk()`. Seed
		// five log directories so the calculation breakdown shows `× 5 logs`.
		foreach ( [ 'a', 'b', 'c', 'd', 'e' ] as $name ) {
			\mkdir( "{$this->base_dir}/logs/{$name}.log", 0755, true );
		}
		\Newspack_Nodes\Log_Discovery::reset();

		$admin = new Admin();

		\ob_start();
		$admin->total_storage_callback();
		$html = \ob_get_clean();

		$this->assertMatchesRegularExpression( '/×\s*5\s*logs/u', $html );
	}

	public function test_total_storage_callback_shows_gb_when_total_over_one_gigabyte(): void {
		// Force a large enough total: 64MB segment × 4 segments × 4 partitions × 2 logs ≈ 2 GB.
		\update_option( 'newspack_nodes_segment_size', 64 * 1024 * 1024 );
		\update_option( 'newspack_nodes_num_segments', 4 );
		\update_option( 'newspack_nodes_num_partitions', 4 );
		\mkdir( "{$this->base_dir}/logs/one.log", 0755, true );
		\mkdir( "{$this->base_dir}/logs/two.log", 0755, true );
		\Newspack_Nodes\Log_Discovery::reset();

		$admin = new Admin();

		\ob_start();
		$admin->total_storage_callback();
		$html = \ob_get_clean();

		// "X MB (Y GB)" form when ≥ 1 GB.
		$this->assertMatchesRegularExpression( '/\(\s*\d[\d,.]*\s*GB\s*\)/u', $html );
	}

	public function test_total_storage_callback_treats_absent_options_as_defaults(): void {
		// ABSENT options fall back to config defaults (presence-based override:
		// only a deleted/never-stored row uses the file default).
		\delete_option( 'newspack_nodes_segment_size' );
		\delete_option( 'newspack_nodes_num_segments' );
		\delete_option( 'newspack_nodes_num_partitions' );

		$admin = new Admin();

		\ob_start();
		$admin->total_storage_callback();
		$html = \ob_get_clean();

		// Should render without error and contain a numeric MB value.
		$this->assertMatchesRegularExpression( '/[\d,]+\s*MB/u', $html );
	}

	// ---- blank text-like saves delete the row (presence-based config) --------

	public function test_blank_text_like_option_save_deletes_row_instead_of_storing_empty(): void {
		// A blank submission for a text-like key means "use the file default",
		// which under presence-based Config means DELETE the row — not store ''
		// (which would override the default and, for base_directory, fatal).
		$admin = new Admin();
		$admin->register_settings();
		$GLOBALS['_wp_options']['newspack_nodes_base_directory'] = '/old/path';

		$result = \apply_filters(
			'pre_update_option_newspack_nodes_base_directory',
			'',
			'/old/path',
			'newspack_nodes_base_directory'
		);

		$this->assertArrayNotHasKey(
			'newspack_nodes_base_directory',
			$GLOBALS['_wp_options'],
			'blank save must delete the row so the file default resurfaces'
		);
		$this->assertSame( '/old/path', $result, 'returns old value so update_option skips the write' );
	}

	public function test_blank_memcache_textarea_save_deletes_row(): void {
		// The exact recurrence guard for this incident: a blank memcache textarea
		// must delete the row (file default wins), NOT store [] (which nulls the
		// shared handle).
		$admin = new Admin();
		$admin->register_settings();
		$GLOBALS['_wp_options']['newspack_nodes_memcache_servers'] = [ 'host:11211' ];

		$result = \apply_filters(
			'pre_update_option_newspack_nodes_memcache_servers',
			[],
			[ 'host:11211' ],
			'newspack_nodes_memcache_servers'
		);

		$this->assertArrayNotHasKey( 'newspack_nodes_memcache_servers', $GLOBALS['_wp_options'] );
		$this->assertSame( [ 'host:11211' ], $result );
	}

	public function test_nonblank_text_like_option_save_passes_through(): void {
		$admin = new Admin();
		$admin->register_settings();
		$GLOBALS['_wp_options']['newspack_nodes_segment_size'] = '999';

		$result = \apply_filters(
			'pre_update_option_newspack_nodes_segment_size',
			'12345',
			'999',
			'newspack_nodes_segment_size'
		);

		$this->assertSame( '12345', $result, 'a real value must persist' );
	}

	public function test_empty_topologies_save_is_written_not_deleted(): void {
		// Selection field with NO reset mark: zero topologies is a deliberate
		// override and must persist as [] (blank-delete does not apply to it).
		$admin = new Admin();
		$admin->register_settings();
		unset( $_POST[ Admin::RESET_MARK_FIELD ] );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'combined' ];

		$result = \apply_filters(
			'pre_update_option_newspack_nodes_topologies',
			[],
			[ 'combined' ],
			'newspack_nodes_topologies'
		);

		$this->assertSame( [], $result, 'empty topologies is an override, not a reset' );
		$this->assertArrayHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'] );
	}

	public function test_reset_marked_selection_field_is_deleted(): void {
		// A per-field reset toggle marks the option; on save it must delete the
		// row even for selection keys (excluded from delete-on-blank).
		$admin = new Admin();
		$admin->register_settings();
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'combined' ];
		$_POST[ Admin::RESET_MARK_FIELD ]                    = [ 'newspack_nodes_topologies' => '1' ];

		try {
			$result = \apply_filters(
				'pre_update_option_newspack_nodes_topologies',
				[ 'combined' ],
				[ 'combined' ],
				'newspack_nodes_topologies'
			);
			$this->assertArrayNotHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'], 'reset-marked field must be deleted' );
			$this->assertSame( [ 'combined' ], $result, 'short-circuit returns old value' );
		} finally {
			unset( $_POST[ Admin::RESET_MARK_FIELD ] );
		}
	}

	public function test_reset_marked_text_field_is_deleted_even_when_value_nonblank(): void {
		// Reset wins over a non-blank submitted value (toggle marked, field not
		// yet cleared on the server side).
		$admin = new Admin();
		$admin->register_settings();
		$GLOBALS['_wp_options']['newspack_nodes_base_directory'] = '/old';
		$_POST[ Admin::RESET_MARK_FIELD ]                       = [ 'newspack_nodes_base_directory' => '1' ];

		try {
			$result = \apply_filters(
				'pre_update_option_newspack_nodes_base_directory',
				'/some/typed/value',
				'/old',
				'newspack_nodes_base_directory'
			);
			$this->assertArrayNotHasKey( 'newspack_nodes_base_directory', $GLOBALS['_wp_options'] );
			$this->assertSame( '/old', $result );
		} finally {
			unset( $_POST[ Admin::RESET_MARK_FIELD ] );
		}
	}

	// ---- maybe_request_worker_restart (configuration-error path) --------

	public function test_maybe_request_worker_restart_swallows_throwable_when_locks_dir_unconfigurable(): void {
		// Force Config::get_locks_directory() to throw by writing a config file
		// whose `base_directory` contains a null byte — Config::ensure_path()
		// rejects these immediately. The Admin must catch and silently return.
		$conf = $this->base_dir . '/bad-base-dir.php';
		\file_put_contents( $conf, "<?php\nreturn [ 'base_directory' => \"/tmp/has\\0null\" ];\n" );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
		Config::reset();

		$admin = new Admin();
		// Must not throw; must be a no-op.
		$admin->maybe_request_worker_restart( 'newspack_nodes_base_directory' );
		$this->assertTrue( true );
	}

	// ---- topologies setting + sanitizer + UI ------------------------------

	public function test_register_settings_registers_topologies_option(): void {
		$admin = new Admin();
		$admin->register_settings();
		$this->assertArrayHasKey( 'newspack_nodes_topologies', $GLOBALS['_registered_settings'] );
		$cb = $GLOBALS['_registered_settings']['newspack_nodes_topologies']['args']['sanitize_callback'];
		$this->assertIsArray( $cb );
		$this->assertSame( 'sanitize_topologies', $cb[1] );
	}

	public function test_sanitize_topologies_drops_unknown_names(): void {
		$tmp = sys_get_temp_dir() . '/tsl-admin-' . uniqid();
		mkdir( $tmp, 0755, true );
		file_put_contents( "{$tmp}/known.tsl", '' );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $tmp );

		$admin = new Admin();
		$result = $admin->sanitize_topologies( [ 'known', 'bogus', 'known' ] );
		// `bogus` dropped (not in registry); duplicates collapsed.
		$this->assertSame( [ 'known' ], $result );

		\unlink( "{$tmp}/known.tsl" );
		\rmdir( $tmp );
		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_sanitize_topologies_handles_non_array_input(): void {
		$admin = new Admin();
		$this->assertSame( [], $admin->sanitize_topologies( null ) );
		$this->assertSame( [], $admin->sanitize_topologies( 'not-an-array' ) );
	}

	public function test_topologies_callback_renders_checkbox_per_known_topology(): void {
		$tmp = sys_get_temp_dir() . '/tsl-admin-ui-' . uniqid();
		mkdir( $tmp, 0755, true );
		file_put_contents( "{$tmp}/firehose-workers-only.tsl", '' );
		file_put_contents( "{$tmp}/request-workers.tsl", '' );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $tmp );

		\update_option( 'newspack_nodes_topologies', [ 'request-workers' ] );
		$admin = new Admin();
		\ob_start();
		$admin->topologies_callback();
		$out = \ob_get_clean();

		$this->assertStringContainsString( 'firehose-workers-only', $out );
		$this->assertStringContainsString( 'request-workers', $out );
		// request-workers must render checked; firehose-workers-only must not.
		$this->assertMatchesRegularExpression( '/request-workers"[^>]*checked/', $out );
		$this->assertDoesNotMatchRegularExpression( '/firehose-workers-only"[^>]*checked/', $out );

		\unlink( "{$tmp}/firehose-workers-only.tsl" );
		\unlink( "{$tmp}/request-workers.tsl" );
		\rmdir( $tmp );
		\delete_option( 'newspack_nodes_topologies' );
		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_topologies_callback_empty_state_when_registry_empty(): void {
		\Newspack_Nodes\Topology_Registry::reset();
		$admin = new Admin();
		\ob_start();
		$admin->topologies_callback();
		$out = \ob_get_clean();
		$this->assertStringContainsString( 'No topologies registered', $out );
	}

	public function test_topologies_callback_advertises_the_config_default_set_per_box(): void {
		// Each checkbox carries data-nn-reset-default ('1' for the shipped default
		// set, '0' otherwise) so a ↺ reset restores that set rather than clearing
		// every box. The config-file default subset here is [ digest, request-workers ].
		[ , $subset ] = $this->seed_topology_fixture();
		\update_option( 'newspack_nodes_topologies', [ 'aggregator' ] ); // operator override ≠ defaults

		$admin = new Admin();
		\ob_start();
		$admin->topologies_callback();
		$out = \ob_get_clean();

		foreach ( $subset as $name ) {
			$this->assertMatchesRegularExpression(
				'/value="' . \preg_quote( $name, '/' ) . '"[^>]*data-nn-reset-default="1"/',
				$out,
				"$name is in the config default set → data-nn-reset-default=1"
			);
		}
		// A catalog entry NOT in the config default set advertises 0.
		$this->assertMatchesRegularExpression(
			'/value="aggregator"[^>]*data-nn-reset-default="0"/',
			$out
		);

		\delete_option( 'newspack_nodes_topologies' );
		\Newspack_Nodes\Topology_Registry::reset();
	}

	// ---- __construct ------------------------------------------------------

	public function test_constructor_registers_all_admin_hooks(): void {
		// Fresh action table so we observe only this construction's registrations.
		$GLOBALS['_wp_actions'] = [];
		new Admin();
		$this->assertArrayHasKey( 'admin_menu', $GLOBALS['_wp_actions'] );
		$this->assertArrayHasKey( 'admin_init', $GLOBALS['_wp_actions'] );
		$this->assertArrayHasKey( 'admin_post_' . Admin::RESET_ACTION, $GLOBALS['_wp_actions'] );
		$this->assertArrayHasKey( 'admin_enqueue_scripts', $GLOBALS['_wp_actions'] );
		$this->assertArrayHasKey( 'updated_option', $GLOBALS['_wp_actions'] );
		$this->assertArrayHasKey( 'added_option', $GLOBALS['_wp_actions'] );

		// admin_menu fires three hooks: `add_admin_menu`,
		// `register_topology_admin_page`, and `register_event_dashboard_pages`.
		$this->assertCount( 3, $GLOBALS['_wp_actions']['admin_menu'] );
	}

	public function test_constructor_admin_init_hook_invokes_register_settings(): void {
		// Drive register_settings via the registered admin_init callback to
		// verify the constructor wires the right method.
		new Admin();
		$this->assertEmpty( $GLOBALS['_registered_settings'] );
		// The bootstrap's add_action stub stores callables under _wp_actions[$hook][].
		foreach ( $GLOBALS['_wp_actions']['admin_init'] as $cb ) {
			$cb();
		}
		$this->assertArrayHasKey( 'newspack_nodes_base_directory', $GLOBALS['_registered_settings'] );
	}

	// ---- register_topology_admin_page ------------------------------------

	public function test_register_topology_admin_page_registers_top_level_menu(): void {
		$admin = new Admin();
		$admin->register_topology_admin_page();

		$this->assertArrayHasKey( Admin::TOPOLOGY_MENU_SLUG, $GLOBALS['_admin_menu_pages'] );
		$entry = $GLOBALS['_admin_menu_pages'][ Admin::TOPOLOGY_MENU_SLUG ];
		$this->assertSame( 'manage_options', $entry['capability'] );
		$this->assertSame( 'dashicons-networking', $entry['icon'] );
		$this->assertSame( 81, $entry['position'] );
		// Callback must point at render_topology_page.
		$this->assertIsArray( $entry['callback'] );
		$this->assertInstanceOf( Admin::class, $entry['callback'][0] );
		$this->assertSame( 'render_topology_page', $entry['callback'][1] );
	}

	public function test_register_topology_admin_page_skips_unauthorized_user(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = false;
		$admin                                                  = new Admin();
		$admin->register_topology_admin_page();
		$this->assertArrayNotHasKey( Admin::TOPOLOGY_MENU_SLUG, $GLOBALS['_admin_menu_pages'] );
	}

	// ---- render_topology_page --------------------------------------------

	public function test_render_topology_page_outputs_mount_element(): void {
		$admin = new Admin();

		\ob_start();
		$admin->render_topology_page();
		$html = \ob_get_clean();

		// React tree mounts on this id; production class hook lives in admin CSS.
		$this->assertStringContainsString( 'id="newspack-nodes-topology-console"', $html );
		$this->assertStringContainsString( 'class="newspack-nodes-topology-console-page"', $html );
	}

	public function test_render_topology_page_blocks_unauthorized_user(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = false;
		$admin                                                  = new Admin();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'You do not have permission' );
		$admin->render_topology_page();
	}

	// ---- enqueue_topology_console_assets ---------------------------------

	public function test_enqueue_topology_console_assets_skips_when_page_unset(): void {
		$_GET = [];
		$admin = new Admin();
		$admin->enqueue_topology_console_assets();
		$this->assertEmpty( $GLOBALS['_enqueued_scripts'] );
		$this->assertEmpty( $GLOBALS['_localized_scripts'] );
	}

	public function test_enqueue_topology_console_assets_skips_on_wrong_page(): void {
		$_GET = [ 'page' => 'some-other-admin-page' ];
		$admin = new Admin();
		$admin->enqueue_topology_console_assets();
		$this->assertEmpty( $GLOBALS['_enqueued_scripts'] );
		$this->assertEmpty( $GLOBALS['_localized_scripts'] );
	}

	public function test_enqueue_topology_console_assets_enqueues_script_and_localizes_data(): void {
		// Plugin ships build/topology-console/index.js + index.css; tests run
		// against the live plugin tree so these files exist by construction.
		// If they're missing the deploy is broken — fail loudly, not silently.
		$asset_path = \NEWSPACK_NODES_DIR . 'build/topology-console/index.js';
		$this->assertFileExists( $asset_path, 'topology-console build asset missing — run `npm run build` before tests' );

		$_GET = [ 'page' => Admin::TOPOLOGY_MENU_SLUG ];

		// Make Topology_Registry::list() return at least one entry so the
		// topologyPartitions data is non-trivial.
		$tmp = \sys_get_temp_dir() . '/tsl-enqueue-' . \uniqid();
		\mkdir( $tmp, 0755, true );
		\file_put_contents( "{$tmp}/synthetic.tsl", "var num_partitions = 3\n" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $tmp );

		// Application catalog seed — Admin reads via
		// Bootstrap::get_topology_catalog() which applies the
		// `newspack_nodes/topologies` filter. Returning an entry here
		// exercises the "catalog wins" branch.
		\add_filter(
			'newspack_nodes/topologies',
			function () {
				return [
					'catalog-only' => [
						'topology'       => 'catalog-only',
						'num_partitions' => 7,
					],
				];
			}
		);
		// activeTopologies is the operator overlay, not catalog membership.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'catalog-only' ];
		\Newspack_Nodes\Config::reset();

		$admin = new Admin();
		$admin->enqueue_topology_console_assets();

		$handle = 'newspack-nodes-topology-console';
		$this->assertArrayHasKey( $handle, $GLOBALS['_enqueued_scripts'] );
		$enq = $GLOBALS['_enqueued_scripts'][ $handle ];
		$this->assertStringEndsWith( 'build/topology-console/index.js', (string) $enq['src'] );
		$this->assertSame( [ 'wp-element', 'wp-components', 'wp-api-fetch', 'wp-i18n' ], $enq['deps'] );
		$this->assertTrue( $enq['in_footer'] );
		// Version is filemtime() of the asset (truthy).
		$this->assertNotEmpty( $enq['version'] );

		$this->assertArrayHasKey( $handle, $GLOBALS['_localized_scripts'] );
		$payload = $GLOBALS['_localized_scripts'][ $handle ];
		$this->assertSame( 'NewspackNodesData', $payload['object_name'] );
		$data = $payload['data'];
		$this->assertArrayHasKey( 'restUrl', $data );
		$this->assertArrayHasKey( 'nonce', $data );
		// The body-borne save_nonce / layout_nonce keys are gone — the
		// topology-console reaches the substrate via CommandClient now
		// (X-WP-Nonce on apiFetch), so the wp_rest cookie nonce in
		// `nonce` is the only nonce surface.
		$this->assertArrayNotHasKey( 'saveTopologyNonce', $data );
		$this->assertArrayNotHasKey( 'saveLayoutNonce', $data );
		$this->assertSame( 'topology-console', $data['tree'] );
		$this->assertSame( \NEWSPACK_NODES_VERSION, $data['version'] );

		// Synthesized entry (from frontmatter) appears with its declared partition count.
		$this->assertArrayHasKey( 'topologyPartitions', $data );
		$this->assertSame( 3, $data['topologyPartitions']['synthetic'] );

		// Catalog-driven entry appears (the catalog branch in the loop).
		// Topology_Registry::list() only scans TSL files on disk, so the
		// catalog-only entry won't appear in topologyPartitions UNLESS a
		// matching TSL file exists. Active-topologies, on the other hand,
		// surfaces it because get_topologies() reads the catalog directly.
		$this->assertArrayHasKey( 'activeTopologies', $data );
		$this->assertContains( 'catalog-only', $data['activeTopologies'] );

		// CSS sidecar exists in the plugin tree, so wp_enqueue_style must fire too.
		if ( \file_exists( \NEWSPACK_NODES_DIR . 'build/topology-console/index.css' ) ) {
			$this->assertArrayHasKey( $handle, $GLOBALS['_enqueued_styles'] );
			$css = $GLOBALS['_enqueued_styles'][ $handle ];
			$this->assertStringEndsWith( 'build/topology-console/index.css', (string) $css['src'] );
			$this->assertSame( [ 'wp-components' ], $css['deps'] );
		}

		// Cleanup.
		\unlink( "{$tmp}/synthetic.tsl" );
		\rmdir( $tmp );
		\Newspack_Nodes\Topology_Registry::reset();
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
	}

	public function test_enqueue_topology_console_assets_uses_catalog_partition_count_when_available(): void {
		$asset_path = \NEWSPACK_NODES_DIR . 'build/topology-console/index.js';
		$this->assertFileExists( $asset_path, 'topology-console build asset missing — run `npm run build` before tests' );

		$_GET = [ 'page' => Admin::TOPOLOGY_MENU_SLUG ];

		// Stage: TSL on disk so Topology_Registry::list() sees the name,
		// catalog entry that disagrees with the frontmatter on partition
		// count. Admin must prefer the catalog value.
		$tmp = \sys_get_temp_dir() . '/tsl-enqueue-cat-' . \uniqid();
		\mkdir( $tmp, 0755, true );
		\file_put_contents( "{$tmp}/known.tsl", "var num_partitions = 99\n" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $tmp );

		\add_filter(
			'newspack_nodes/topologies',
			function () {
				return [
					'known' => [
						'topology'       => 'known',
						'num_partitions' => 2,
					],
				];
			}
		);

		$admin = new Admin();
		$admin->enqueue_topology_console_assets();

		$handle = 'newspack-nodes-topology-console';
		$data   = $GLOBALS['_localized_scripts'][ $handle ]['data'];
		// Catalog wins (2), NOT the frontmatter value (99).
		$this->assertSame( 2, $data['topologyPartitions']['known'] );

		\unlink( "{$tmp}/known.tsl" );
		\rmdir( $tmp );
		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_enqueue_topology_console_assets_drops_unresolved_topology_names(): void {
		$asset_path = \NEWSPACK_NODES_DIR . 'build/topology-console/index.js';
		$this->assertFileExists( $asset_path, 'topology-console build asset missing — run `npm run build` before tests' );

		$_GET = [ 'page' => Admin::TOPOLOGY_MENU_SLUG ];

		\Newspack_Nodes\Topology_Registry::reset();

		$admin = new Admin();
		$admin->enqueue_topology_console_assets();

		$handle = 'newspack-nodes-topology-console';
		$data   = $GLOBALS['_localized_scripts'][ $handle ]['data'];
		// No TSL files registered → empty list. Sanitization through ksort
		// + array_keys yields [] for both maps.
		$this->assertSame( [], $data['topologyPartitions'] );
		$this->assertSame( [], $data['activeTopologies'] );
	}

	// ---- topologies_section_callback -------------------------------------

	public function test_topologies_section_callback_outputs_paragraph(): void {
		$admin = new Admin();

		\ob_start();
		$admin->topologies_section_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( '<p>', $html );
		// Description references the supervisor + fleet behavior.
		$this->assertStringContainsString( 'supervisor', $html );
		$this->assertStringContainsString( 'worker fleet', $html );
	}

	// ---- per-field reset toggle wiring -----------------------------------

	public function test_settings_page_enqueues_field_reset_toggle_and_highlight(): void {
		$GLOBALS['_enqueued_scripts'] = [];
		$admin                        = new Admin();

		\ob_start();
		$admin->render_settings_page();
		$html = \ob_get_clean();

		// The built DOM-only toggle module is enqueued (replaces the old inline
		// script), and the marked-state highlight style is present.
		$this->assertArrayHasKey( 'newspack-nodes-field-reset', $GLOBALS['_enqueued_scripts'] );
		$this->assertStringContainsString( '.is-marked [data-nn-reset-toggle]', $html );
	}

	// ---- additional handle_reset_settings + filter coverage --------------

	public function test_handle_reset_settings_filter_returning_non_array_is_ignored(): void {
		// When the reset_options filter returns a non-array (a misuse),
		// Admin must keep its built-in option list rather than crashing on
		// foreach.
		\add_filter(
			'newspack_nodes/reset_options',
			static function () {
				return 'not-an-array';
			}
		);
		$_POST = [ Admin::RESET_NONCE => $this->valid_nonce() ];
		\update_option( 'newspack_nodes_num_partitions', 9 );

		$admin = new Admin();
		try {
			$admin->handle_reset_settings();
			$this->fail( 'expected RedirectException' );
		} catch ( RedirectException $e ) {
			// Built-in option list was used; substrate option cleared.
		}
		$this->assertFalse( \get_option( 'newspack_nodes_num_partitions' ) );
	}

	// ---- maybe_request_worker_restart filter-returns-non-array ------------

	public function test_maybe_request_worker_restart_filter_returning_non_array_keeps_defaults(): void {
		$this->prepare_lock_dir( 'request-workers', 0 );
		$this->prepare_lock_dir( 'job-workers', 0 );

		\add_filter(
			'newspack_nodes/worker_restart_groups',
			static function () {
				return 'not-an-array';
			}
		);

		$admin = new Admin();
		$admin->maybe_request_worker_restart( 'newspack_nodes_base_directory' );

		// Non-array filter return discarded; built-in `all_workers_options`
		// group list still applies.
		$this->assertFileExists( $this->base_dir . '/locks/request-workers.p0.lock.d/restart' );
		$this->assertFileExists( $this->base_dir . '/locks/job-workers.p0.lock.d/restart' );
	}

	public function test_maybe_request_worker_restart_filter_collapses_duplicates_and_drops_non_strings(): void {
		$this->prepare_lock_dir( 'request-workers', 0 );
		$this->prepare_lock_dir( 'custom-workers', 0 );

		\add_filter(
			'newspack_nodes/worker_restart_groups',
			static function ( $groups ) {
				// Inject duplicates and a non-string sentinel. Admin filters
				// to strings + dedupes via array_unique.
				return [ ...$groups, 'custom-workers', 'custom-workers', 42, null ];
			}
		);

		$admin = new Admin();
		$admin->maybe_request_worker_restart( 'newspack_nodes_memcache_servers' );

		$this->assertFileExists( $this->base_dir . '/locks/request-workers.p0.lock.d/restart' );
		$this->assertFileExists( $this->base_dir . '/locks/custom-workers.p0.lock.d/restart' );
		// No spurious lock dirs created for the non-string sentinels.
		$this->assertFalse( \is_dir( $this->base_dir . '/locks/42.p0.lock.d' ) );
	}

	public function test_maybe_request_worker_restart_filter_emptying_groups_is_noop(): void {
		// If a filter clobbers the groups list to [], Admin's `if ( empty(
		// $worker_groups ) ) return;` guard prevents any flag-file write.
		$this->prepare_lock_dir( 'request-workers', 0 );
		$this->prepare_lock_dir( 'job-workers', 0 );

		\add_filter(
			'newspack_nodes/worker_restart_groups',
			static function () {
				return [];
			}
		);

		$admin = new Admin();
		$admin->maybe_request_worker_restart( 'newspack_nodes_base_directory' );

		$this->assertFalse( \file_exists( $this->base_dir . '/locks/request-workers.p0.lock.d/restart' ) );
		$this->assertFalse( \file_exists( $this->base_dir . '/locks/job-workers.p0.lock.d/restart' ) );
	}

	// ---- topologies_callback (additional branches) -----------------------

	public function test_topologies_callback_defaults_to_config_file_topologies_not_catalog_when_option_unset(): void {
		// option=false (never saved) → admin renders the config-file `topologies`
		// default as checked — NOT the full catalog. Both .tsl are available and the
		// catalog publishes BOTH, but only `blessed` is in the config default, so
		// only it is checked (proving the source is config, not catalog).
		\Newspack_Nodes\Topology_Registry::reset();
		$tmp = $this->make_temp_dir( 'tsl-default-' );
		\file_put_contents( "{$tmp}/blessed.tsl", '' );
		\file_put_contents( "{$tmp}/unblessed.tsl", '' );
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $tmp );

		// Catalog publishes BOTH (the old, buggy default source).
		\add_filter(
			'newspack_nodes/topologies',
			static function () {
				return [
					'blessed'   => [ 'topology' => 'blessed', 'num_partitions' => 1 ],
					'unblessed' => [ 'topology' => 'unblessed', 'num_partitions' => 1 ],
				];
			}
		);
		// Config-file default declares only `blessed` active.
		$this->use_base_dir( $this->base_dir, [ 'topologies' => [ 'blessed' ] ] );

		// Ensure no operator override.
		\delete_option( 'newspack_nodes_topologies' );

		$admin = new Admin();
		\ob_start();
		$admin->topologies_callback();
		$out = \ob_get_clean();

		// blessed is the config default → checked. unblessed is in the catalog but
		// NOT the config default → unchecked.
		$this->assertMatchesRegularExpression( '/blessed"[^>]*checked/', $out );
		$this->assertDoesNotMatchRegularExpression( '/unblessed"[^>]*checked/', $out );
		// Reset is the uniform per-field toggle (delete → file default), not a
		// catalog-payload chip.
		$this->assertStringContainsString( 'data-nn-reset-toggle', $out );

		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_topologies_callback_empty_array_option_renders_all_unchecked(): void {
		// option=[] (operator unchecked everything) is distinct from option=false.
		\Newspack_Nodes\Topology_Registry::reset();
		$tmp = \sys_get_temp_dir() . '/tsl-empty-' . \uniqid();
		\mkdir( $tmp, 0755, true );
		\file_put_contents( "{$tmp}/one.tsl", '' );
		\file_put_contents( "{$tmp}/two.tsl", '' );
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $tmp );

		\update_option( 'newspack_nodes_topologies', [] );

		$admin = new Admin();
		\ob_start();
		$admin->topologies_callback();
		$out = \ob_get_clean();

		$this->assertDoesNotMatchRegularExpression( '/one"[^>]*checked/', $out );
		$this->assertDoesNotMatchRegularExpression( '/two"[^>]*checked/', $out );

		\unlink( "{$tmp}/one.tsl" );
		\unlink( "{$tmp}/two.tsl" );
		\rmdir( $tmp );
		\delete_option( 'newspack_nodes_topologies' );
		\Newspack_Nodes\Topology_Registry::reset();
	}

	// ---- register_event_dashboard_pages ----------------------------------

	public function test_register_event_dashboard_pages_registers_workers_and_rawlogs_submenus(): void {
		$admin = new Admin();
		$admin->register_event_dashboard_pages();

		$this->assertArrayHasKey( Admin::WORKERS_MENU_SLUG, $GLOBALS['_admin_submenu_pages'] );
		$this->assertArrayHasKey( Admin::RAWLOGS_MENU_SLUG, $GLOBALS['_admin_submenu_pages'] );

		$workers = $GLOBALS['_admin_submenu_pages'][ Admin::WORKERS_MENU_SLUG ];
		$this->assertSame( Admin::TOPOLOGY_MENU_SLUG, $workers['parent_slug'] );
		$this->assertSame( 'manage_options', $workers['capability'] );

		$rawlogs = $GLOBALS['_admin_submenu_pages'][ Admin::RAWLOGS_MENU_SLUG ];
		$this->assertSame( Admin::TOPOLOGY_MENU_SLUG, $rawlogs['parent_slug'] );
		$this->assertSame( 'manage_options', $rawlogs['capability'] );
	}

	public function test_register_event_dashboard_page_callbacks_print_mount_divs(): void {
		// The callback closures print the React mount points the
		// event-dashboards bundle attaches to. Without these, the page is
		// blank — drive each callback and assert the mount div renders.
		$admin = new Admin();
		$admin->register_event_dashboard_pages();

		$workers_cb = $GLOBALS['_admin_submenu_pages'][ Admin::WORKERS_MENU_SLUG ]['callback'];
		\ob_start();
		$workers_cb();
		$this->assertSame( '<div id="newspack-nodes-workers" class="newspack-nodes-workers-page"></div>', \ob_get_clean() );

		$rawlogs_cb = $GLOBALS['_admin_submenu_pages'][ Admin::RAWLOGS_MENU_SLUG ]['callback'];
		\ob_start();
		$rawlogs_cb();
		$this->assertSame( '<div id="newspack-nodes-rawlogs" class="newspack-nodes-rawlogs-page"></div>', \ob_get_clean() );
	}

	public function test_register_event_dashboard_pages_skips_unauthorized_user(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = false;
		$admin                                                  = new Admin();
		$admin->register_event_dashboard_pages();

		$this->assertArrayNotHasKey( Admin::WORKERS_MENU_SLUG, $GLOBALS['_admin_submenu_pages'] );
		$this->assertArrayNotHasKey( Admin::RAWLOGS_MENU_SLUG, $GLOBALS['_admin_submenu_pages'] );
	}

	// ---- enqueue_event_dashboards_assets ----------------------------------

	public function test_enqueue_event_dashboards_assets_skips_on_wrong_page(): void {
		$_GET = [ 'page' => 'some-other-admin-page' ];
		( new Admin() )->enqueue_event_dashboards_assets();
		$this->assertEmpty( $GLOBALS['_enqueued_scripts'] );
		$this->assertEmpty( $GLOBALS['_localized_scripts'] );
	}

	public function test_enqueue_event_dashboards_assets_enqueues_for_workers_page(): void {
		$asset_path = \NEWSPACK_NODES_DIR . 'build/event-dashboards/index.js';
		$this->assertFileExists( $asset_path, 'event-dashboards build asset missing — run `npm run build` before tests' );

		$_GET = [ 'page' => Admin::WORKERS_MENU_SLUG ];

		$admin = new Admin();
		$admin->enqueue_event_dashboards_assets();

		$handle = 'newspack-nodes-event-dashboards';
		$this->assertArrayHasKey( $handle, $GLOBALS['_enqueued_scripts'] );
		$enq = $GLOBALS['_enqueued_scripts'][ $handle ];
		$this->assertStringEndsWith( 'build/event-dashboards/index.js', (string) $enq['src'] );
		$this->assertSame( [ 'wp-element', 'wp-components', 'wp-api-fetch', 'wp-i18n' ], $enq['deps'] );
		$this->assertTrue( $enq['in_footer'] );

		$this->assertArrayHasKey( $handle, $GLOBALS['_localized_scripts'] );
		$payload = $GLOBALS['_localized_scripts'][ $handle ];
		$this->assertSame( 'NewspackNodesData', $payload['object_name'] );
		// `tree` discriminates which React mount logic kicks in inside the
		// shared event-dashboards bundle. Locking it pins the contract with
		// the JS bundle's entry point.
		$this->assertSame( 'event-dashboards', $payload['data']['tree'] );
		$this->assertSame( \NEWSPACK_NODES_VERSION, $payload['data']['version'] );
		$this->assertArrayHasKey( 'restUrl', $payload['data'] );
		$this->assertArrayHasKey( 'nonce',   $payload['data'] );
	}

	public function test_enqueue_event_dashboards_assets_enqueues_for_rawlogs_page(): void {
		// Same bundle, different page — both pages share one React bundle.
		// Without this, a regression that ties the bundle to only the
		// workers page would silently leave rawlogs blank.
		$_GET = [ 'page' => Admin::RAWLOGS_MENU_SLUG ];

		( new Admin() )->enqueue_event_dashboards_assets();

		$this->assertArrayHasKey( 'newspack-nodes-event-dashboards', $GLOBALS['_enqueued_scripts'] );
	}

	// ---- helpers ----------------------------------------------------------

	private function prepare_lock_dir( string $group, int $partition ): string {
		$dir = "{$this->base_dir}/locks/{$group}.p{$partition}.lock.d";
		\mkdir( $dir, 0755, true );
		return $dir;
	}
}

} // close namespace Newspack_Nodes\Tests\Unit\Admin
