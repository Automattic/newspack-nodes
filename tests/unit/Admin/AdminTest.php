<?php
/**
 * AdminTest: unit tests for the substrate WP-Settings-API admin surface.
 *
 * The WP-Settings-API / escaping / i18n stubs it drives are shared from
 * tests/bootstrap.php (function_exists-guarded, single source): the recorder
 * stubs record their arguments into globals — assertions read those globals to
 * verify the admin registered the right keys with the right callbacks. This
 * file feeds the right shape into `$GLOBALS['_wp_test_current_user_can']` and
 * `$GLOBALS['_wp_test_valid_nonces']`, which the auth/nonce stubs consult.
 */

// WP Settings-API / escaping / i18n stubs live in tests/bootstrap.php (shared,
// function_exists-guarded, single source). Per-file copies are forbidden.

namespace {
	// Substrate Admin class is normally required by the main plugin file's
	// `is_admin()` block; in tests `is_admin()` is undefined / falsey, so
	// require it here so this test can drive the class.
	require_once \dirname( __DIR__, 3 ) . '/includes/admin/class-admin.php';
}

// -- Test class -------------------------------------------------------------

namespace Newspack_Nodes\Tests\Unit\Admin {

use Newspack_Nodes\Admin\Admin;
use Newspack_Nodes\Config;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Tests\Helpers\RedirectException;
use PHPUnit\Framework\Attributes\CoversClass;

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
		// Sanitize $_GET so the page-gated enqueue methods aren't influenced by
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
		\delete_option( 'newspack_nodes_topologies' );
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
			'newspack_nodes_min_segments',
			'newspack_nodes_max_segments',
			'newspack_nodes_segment_size',
			'newspack_nodes_min_lifetime',
			'newspack_nodes_max_lifetime',
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
			'newspack_nodes_min_segments',
			'newspack_nodes_max_segments',
			'newspack_nodes_segment_size',
			'newspack_nodes_min_lifetime',
			'newspack_nodes_max_lifetime',
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
		foreach ( [ 'num_partitions', 'min_segments', 'max_segments', 'segment_size', 'min_lifetime', 'max_lifetime', 'total_storage', 'base_directory', 'memcache_servers' ] as $field ) {
			$this->assertArrayHasKey( $field, $GLOBALS['_registered_fields'], "field $field not registered" );
			$this->assertSame( Admin::SETTINGS_PAGE, $GLOBALS['_registered_fields'][ $field ]['page'] );
		}
	}

	public function test_register_settings_registers_remote_settings_options(): void {
		$admin = new Admin();
		$admin->register_settings();

		foreach ( [
			'newspack_nodes_remote_max_segments',
			'newspack_nodes_remote_segment_size',
			'newspack_nodes_remote_min_lifetime',
		] as $option ) {
			$this->assertArrayHasKey( $option, $GLOBALS['_registered_settings'], "missing option: $option" );
			$this->assertSame( 'string', $GLOBALS['_registered_settings'][ $option ]['args']['type'] );
		}
	}

	public function test_register_settings_registers_remote_settings_section(): void {
		$admin = new Admin();
		$admin->register_settings();

		$this->assertArrayHasKey( 'newspack_nodes_remote_section', $GLOBALS['_registered_sections'] );
		foreach ( [ 'remote_max_segments', 'remote_segment_size', 'remote_min_lifetime' ] as $field ) {
			$this->assertArrayHasKey( $field, $GLOBALS['_registered_fields'], "field $field not registered" );
			$this->assertSame( Admin::SETTINGS_PAGE, $GLOBALS['_registered_fields'][ $field ]['page'] );
		}
	}

	public function test_register_settings_does_not_render_topologies_checkboxes(): void {
		// The Topology Manager's active toggle is the sole activation UI; the
		// settings page no longer renders a topologies field or its section.
		$admin = new Admin();
		$admin->register_settings();

		$this->assertArrayNotHasKey( 'topologies', $GLOBALS['_registered_fields'], 'topologies must not be a settings field' );
		$this->assertArrayNotHasKey( 'newspack_nodes_topologies_section', $GLOBALS['_registered_sections'], 'topologies section must not be registered' );
	}

	public function test_admin_has_no_topologies_render_callbacks(): void {
		// The checkbox renderer and its section header are deleted — the toggle
		// is the only activation UI.
		$this->assertFalse( \method_exists( Admin::class, 'topologies_callback' ) );
		$this->assertFalse( \method_exists( Admin::class, 'topologies_section_callback' ) );
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

	public function test_handle_reset_settings_preserves_topologies(): void {
		// Reset clears the UI-exposed settings, but `topologies` is overlay-only
		// (managed by the Topology Manager / activate verbs), so it is NOT in the
		// reset set: a settings reset must leave the active set intact.
		$_POST = [ Admin::RESET_NONCE => $this->valid_nonce() ];
		\update_option( 'newspack_nodes_topologies', [ 'combined' ] );

		$admin = new Admin();
		try {
			$admin->handle_reset_settings();
			$this->fail( 'expected RedirectException' );
		} catch ( RedirectException $e ) {
			// Expected.
		}

		$this->assertSame( [ 'combined' ], \get_option( 'newspack_nodes_topologies' ), 'reset must NOT touch the active topology set' );
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
		// 'supervisor_only' (num_partitions) restarts NOTHING — even with a live
		// topology present that the classification would otherwise resolve
		// against. The supervisor refreshes config each loop; touching a worker
		// here would be a correctness bug.
		$this->register_fixture_topologies();
		$this->prepare_lock_dir( 'combined', 0 );

		( new Admin() )->maybe_request_worker_restart( 'newspack_nodes_num_partitions' );

		$this->assertFileDoesNotExist( "{$this->base_dir}/locks/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG );
	}

	public function test_maybe_request_worker_restart_memcache_servers_restarts_all_live_topologies(): void {
		// memcache_servers is 'all' → every active topology restarts (the
		// Memcached handle lives in every long-lived worker process).
		$this->register_fixture_topologies();
		$this->prepare_lock_dir( 'combined', 0 );
		$this->prepare_lock_dir( 'aggregator', 0 );

		( new Admin() )->maybe_request_worker_restart( 'newspack_nodes_memcache_servers' );

		$this->assertFileExists( "{$this->base_dir}/locks/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$this->base_dir}/locks/aggregator.p0.lock.d/" . Lock_Node::RESTART_FLAG );
	}

	public function test_maybe_request_worker_restart_iterates_all_partitions(): void {
		// The 'multipart' fixture declares num_partitions=3 → every partition
		// lock dir of a consuming topology is flagged.
		$this->register_fixture_topologies();
		for ( $p = 0; $p < 3; $p++ ) {
			$this->prepare_lock_dir( 'multipart', $p );
		}

		( new Admin() )->maybe_request_worker_restart( 'newspack_nodes_memcache_servers' );

		for ( $p = 0; $p < 3; $p++ ) {
			$this->assertFileExists( "{$this->base_dir}/locks/multipart.p{$p}.lock.d/" . Lock_Node::RESTART_FLAG );
		}
	}

	public function test_saving_max_segments_restarts_live_topologies_not_phantom_groups(): void {
		// Storage geometry classifies for the Partition node type. The fixture
		// 'combined' topology has a Partition; the phantom 'request-workers'
		// worker-group label matches no live topology and must NOT be touched.
		$this->register_fixture_topologies();
		$this->prepare_lock_dir( 'combined', 0 );
		$this->prepare_lock_dir( 'request-workers', 0 );

		( new Admin() )->maybe_request_worker_restart( 'newspack_nodes_max_segments' );

		$this->assertFileExists( "{$this->base_dir}/locks/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileDoesNotExist( "{$this->base_dir}/locks/request-workers.p0.lock.d/" . Lock_Node::RESTART_FLAG );
	}

	public function test_maybe_request_worker_restart_all_restarts_every_live_topology(): void {
		// base_directory is 'all' → every active topology restarts.
		$this->register_fixture_topologies();
		$this->prepare_lock_dir( 'combined', 0 );
		$this->prepare_lock_dir( 'aggregator', 0 );

		( new Admin() )->maybe_request_worker_restart( 'newspack_nodes_base_directory' );

		$this->assertFileExists( "{$this->base_dir}/locks/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG );
		$this->assertFileExists( "{$this->base_dir}/locks/aggregator.p0.lock.d/" . Lock_Node::RESTART_FLAG );
	}

	public function test_maybe_request_worker_restart_no_op_when_no_live_topology_consumes(): void {
		// remote_* fields classify [] → nothing restarts even with a live topology.
		$this->register_fixture_topologies();
		$this->prepare_lock_dir( 'combined', 0 );

		( new Admin() )->maybe_request_worker_restart( 'newspack_nodes_remote_max_segments' );

		$this->assertFileDoesNotExist( "{$this->base_dir}/locks/combined.p0.lock.d/" . Lock_Node::RESTART_FLAG );
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

	// ---- min_segments_callback (max=32 → small-text) ---------------------

	public function test_min_segments_callback_renders_number_input_with_bounds(): void {
		$admin = new Admin();

		\ob_start();
		$admin->min_segments_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'type="number"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_min_segments"', $html );
		$this->assertStringContainsString( 'id="min_segments"', $html );
		$this->assertStringContainsString( 'min="2"', $html );
		$this->assertStringContainsString( 'max="32"', $html );
		// max <= 999.
		$this->assertStringContainsString( 'class="small-text"', $html );
	}

	// ---- max_segments_callback (max=32 → small-text) ---------------------

	public function test_max_segments_callback_renders_number_input_with_bounds(): void {
		$admin = new Admin();

		\ob_start();
		$admin->max_segments_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'type="number"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_max_segments"', $html );
		$this->assertStringContainsString( 'id="max_segments"', $html );
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

	// ---- min_lifetime_callback (max=604800 → regular-text) ---------------

	public function test_min_lifetime_callback_renders_number_input_with_bounds(): void {
		$admin = new Admin();

		\ob_start();
		$admin->min_lifetime_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'type="number"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_min_lifetime"', $html );
		$this->assertStringContainsString( 'min="0"', $html );
		$this->assertStringContainsString( 'max="604800"', $html );
		// max > 999 → regular-text branch.
		$this->assertStringContainsString( 'class="regular-text"', $html );
	}

	// ---- max_lifetime_callback (max=604800 → regular-text) ---------------

	public function test_max_lifetime_callback_renders_number_input_with_bounds(): void {
		$admin = new Admin();

		\ob_start();
		$admin->max_lifetime_callback();
		$html = \ob_get_clean();

		$this->assertStringContainsString( 'type="number"', $html );
		$this->assertStringContainsString( 'name="newspack_nodes_max_lifetime"', $html );
		$this->assertStringContainsString( 'min="0"', $html );
		$this->assertStringContainsString( 'max="604800"', $html );
		// max > 999 → regular-text branch.
		$this->assertStringContainsString( 'class="regular-text"', $html );
	}

	// ---- remote_* sanitizers ---------------------------------------------

	public function test_sanitize_remote_max_segments_returns_empty_for_empty_and_null(): void {
		$this->assertSame( '', Admin::sanitize_remote_max_segments( '' ) );
		$this->assertSame( '', Admin::sanitize_remote_max_segments( null ) );
	}

	public function test_sanitize_remote_max_segments_clamps_to_range(): void {
		$this->assertSame( 2, Admin::sanitize_remote_max_segments( '1' ) );
		$this->assertSame( 16, Admin::sanitize_remote_max_segments( '500' ) );
		$this->assertSame( 8, Admin::sanitize_remote_max_segments( '8' ) );
	}

	public function test_sanitize_remote_segment_size_returns_empty_for_empty_and_null(): void {
		$this->assertSame( '', Admin::sanitize_remote_segment_size( '' ) );
		$this->assertSame( '', Admin::sanitize_remote_segment_size( null ) );
	}

	public function test_sanitize_remote_segment_size_clamps_to_range(): void {
		$this->assertSame( 1024 * 1024, Admin::sanitize_remote_segment_size( '100' ) );
		$this->assertSame( 256 * 1024 * 1024, Admin::sanitize_remote_segment_size( (string) ( 512 * 1024 * 1024 ) ) );
		$this->assertSame( 10 * 1024 * 1024, Admin::sanitize_remote_segment_size( (string) ( 10 * 1024 * 1024 ) ) );
	}

	public function test_sanitize_remote_min_lifetime_returns_empty_for_empty_and_null(): void {
		$this->assertSame( '', Admin::sanitize_remote_min_lifetime( '' ) );
		$this->assertSame( '', Admin::sanitize_remote_min_lifetime( null ) );
	}

	public function test_sanitize_remote_min_lifetime_clamps_to_range(): void {
		// 0 = disabled (pure count-based), matching the hub max_lifetime; no 60s floor.
		$this->assertSame( 0, Admin::sanitize_remote_min_lifetime( '0' ) );
		$this->assertSame( 10, Admin::sanitize_remote_min_lifetime( '10' ) );
		$this->assertSame( 604800, Admin::sanitize_remote_min_lifetime( '999999999' ) );
		$this->assertSame( 3600, Admin::sanitize_remote_min_lifetime( '3600' ) );
	}

	// ---- remote_* section + field callbacks ------------------------------

	public function test_remote_settings_section_callback_describes_geometry(): void {
		\ob_start();
		Admin::remote_settings_section_callback();
		$out = \ob_get_clean();
		$this->assertStringContainsString( '<p>', $out );
		$this->assertStringContainsString( 'remote spokes', $out );
	}

	public function test_remote_max_segments_callback_renders_number_input(): void {
		\ob_start();
		Admin::remote_max_segments_callback();
		$out = \ob_get_clean();
		$this->assertStringContainsString( 'name="newspack_nodes_remote_max_segments"', $out );
		$this->assertStringContainsString( 'type="number"', $out );
		$this->assertStringContainsString( 'min="2"', $out );
		$this->assertStringContainsString( 'max="16"', $out );
		$this->assertStringContainsString( 'data-nn-reset="newspack_nodes_reset[newspack_nodes_remote_max_segments]"', $out );
		$this->assertStringContainsString( 'data-nn-reset-toggle', $out );
	}

	public function test_remote_max_segments_callback_shows_value_when_overridden(): void {
		\update_option( 'newspack_nodes_remote_max_segments', 8 );
		\ob_start();
		Admin::remote_max_segments_callback();
		$out = \ob_get_clean();
		$this->assertStringContainsString( 'value="8"', $out );
	}

	public function test_remote_segment_size_callback_renders_number_input(): void {
		\ob_start();
		Admin::remote_segment_size_callback();
		$out = \ob_get_clean();
		$this->assertStringContainsString( 'name="newspack_nodes_remote_segment_size"', $out );
		$this->assertStringContainsString( 'min="' . ( 1024 * 1024 ) . '"', $out );
		$this->assertStringContainsString( 'max="' . ( 256 * 1024 * 1024 ) . '"', $out );
	}

	public function test_remote_min_lifetime_callback_renders_number_input(): void {
		\ob_start();
		Admin::remote_min_lifetime_callback();
		$out = \ob_get_clean();
		$this->assertStringContainsString( 'name="newspack_nodes_remote_min_lifetime"', $out );
		$this->assertStringContainsString( 'min="0"', $out );
		$this->assertStringContainsString( 'max="604800"', $out );
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
		// Description references the segment-MB and segments/log-partitions breakdown.
		$this->assertStringContainsString( 'segment ', $html );
		$this->assertStringContainsString( 'segments', $html );
		$this->assertStringContainsString( 'log partitions', $html );
	}

	public function test_total_storage_callback_counts_logs_from_disk(): void {
		// The dir-count factor reads from `Log_Discovery::on_disk()`, which now
		// returns concrete per-partition dirs. Seed five so the breakdown shows
		// `× 5 log partitions`.
		foreach ( [ 'a.p0', 'b.p0', 'c.p0', 'd.p0', 'e.p0' ] as $name ) {
			\mkdir( "{$this->base_dir}/logs/{$name}", 0755, true );
		}
		\Newspack_Nodes\Log_Discovery::reset();

		$admin = new Admin();

		\ob_start();
		$admin->total_storage_callback();
		$html = \ob_get_clean();

		$this->assertMatchesRegularExpression( '/×\s*5\s*log partitions/u', $html );
	}

	public function test_total_storage_callback_does_not_double_count_partitions(): void {
		// `Log_Discovery::on_disk()` now returns CONCRETE per-partition dir
		// names, so the partition dimension is already in the dir count. The
		// estimate must be segment_size × max_segments × dir_count — NOT
		// multiplied by num_partitions a second time.
		\update_option( 'newspack_nodes_segment_size', 10 * 1024 * 1024 );
		\update_option( 'newspack_nodes_max_segments', 4 );
		\update_option( 'newspack_nodes_num_partitions', 4 );
		foreach ( [ 'firehose.p0', 'firehose.p1', 'firehose.p2' ] as $name ) {
			\mkdir( "{$this->base_dir}/logs/{$name}", 0755, true );
		}
		\Newspack_Nodes\Log_Discovery::reset();

		$admin = new Admin();

		\ob_start();
		$admin->total_storage_callback();
		$html = \ob_get_clean();

		// 10 MB × 4 segments × 3 dirs = 120 MB. The buggy formula would
		// multiply by num_partitions (4) again => 480 MB.
		$this->assertStringContainsString( '120 MB', $html );
		$this->assertStringNotContainsString( '480 MB', $html );
	}

	public function test_total_storage_callback_shows_gb_when_total_over_one_gigabyte(): void {
		// Force a large enough total: 64MB segment × 4 segments × 4 on-disk dirs = 1 GB.
		\update_option( 'newspack_nodes_segment_size', 64 * 1024 * 1024 );
		\update_option( 'newspack_nodes_max_segments', 4 );
		foreach ( [ 'firehose.p0', 'firehose.p1', 'jobs.p0', 'jobs.p1' ] as $name ) {
			\mkdir( "{$this->base_dir}/logs/{$name}", 0755, true );
		}
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
		\delete_option( 'newspack_nodes_max_segments' );
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

	public function test_topologies_is_outside_the_reset_gate(): void {
		// Overlay-only: topologies has no `pre_update_option_*` reset-gate filter,
		// so neither a blank save nor a per-field reset mark can delete the active
		// set — only the Topology Manager / activate verbs write it.
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
			$this->assertArrayHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'], 'overlay-only field must not be reset-gated' );
			$this->assertSame( [ 'combined' ], $result );
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

	// ---- topologies: overlay-only, never a settings-form option -----------

	public function test_register_settings_does_not_register_topologies_as_a_settings_option(): void {
		// The active-topologies set is managed by the Topology Manager / activate
		// verbs, NOT the Nodes Runtime settings form. Registering it as a settings-group
		// option made Save (which never renders it) wipe the active set: options.php
		// sanitizes every registered option from $_POST, and an absent one sanitized
		// to []. Keep it overlay-only so Save can't touch it.
		$admin = new Admin();
		$admin->register_settings();
		$this->assertArrayNotHasKey( 'newspack_nodes_topologies', $GLOBALS['_registered_settings'] );
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

		$this->assertArrayHasKey( Admin::HUB_MENU_SLUG, $GLOBALS['_admin_menu_pages'] );
		$entry = $GLOBALS['_admin_menu_pages'][ Admin::HUB_MENU_SLUG ];
		$this->assertSame( 'manage_options', $entry['capability'] );
		$this->assertSame( 'dashicons-networking', $entry['icon'] );
		$this->assertSame( 81, $entry['position'] );
		// Callback must point at render_hub_page — the top-level "Nodes" entry is
		// the DevTools hub now (Console + Topologies tabs), not the bare console.
		$this->assertIsArray( $entry['callback'] );
		$this->assertInstanceOf( Admin::class, $entry['callback'][0] );
		$this->assertSame( 'render_hub_page', $entry['callback'][1] );
	}

	public function test_register_topology_admin_page_skips_unauthorized_user(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = false;
		$admin                                                  = new Admin();
		$admin->register_topology_admin_page();
		$this->assertArrayNotHasKey( Admin::HUB_MENU_SLUG, $GLOBALS['_admin_menu_pages'] );
	}

	// ---- render_hub_page --------------------------------------------------

	public function test_render_hub_page_outputs_hub_mount_element(): void {
		$admin = new Admin();

		\ob_start();
		$admin->render_hub_page();
		$html = \ob_get_clean();

		// The top-level "Nodes" page is the DevTools hub now — its React tree
		// mounts on the hub id and carries the Console + Topologies tabs.
		$this->assertStringContainsString( 'id="newspack-nodes-hub"', $html );
		$this->assertStringContainsString( 'class="newspack-nodes-hub-page"', $html );
		// The standalone console mount is gone — the console loads as a hub tab.
		$this->assertStringNotContainsString( 'id="newspack-nodes-topology-console"', $html );
	}

	public function test_render_hub_page_blocks_unauthorized_user(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = false;
		$admin                                                  = new Admin();
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'You do not have permission' );
		$admin->render_hub_page();
	}

	// ---- register_topology_console_tab_bundle ----------------------------

	public function test_register_topology_console_tab_bundle_appends_console_bundle_with_localize(): void {
		// The console now loads as a contributor tab bundle on the hub page; the
		// bundle entry carries the partition snapshot the React dropdown reads.
		$tmp = $this->make_temp_dir( 'tsl-console-bundle-' );
		\file_put_contents( "{$tmp}/synthetic.tsl", "var num_partitions = 3\n" );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $tmp );

		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'synthetic' ];
		\Newspack_Nodes\Config::reset();

		$admin   = new Admin();
		$bundles = $admin->register_topology_console_tab_bundle( [] );

		$match = null;
		foreach ( $bundles as $bundle ) {
			if ( \is_array( $bundle ) && ( $bundle['handle'] ?? '' ) === 'newspack-nodes-topology-console' ) {
				$match = $bundle;
				break;
			}
		}
		$this->assertNotNull( $match, 'topology-console bundle not appended' );
		$this->assertStringEndsWith( 'build/topology-console', (string) $match['dir'] );
		$this->assertStringEndsWith( 'build/topology-console', (string) $match['url'] );

		// Localize carries the moved partition snapshot.
		$localize = $match['localize'];
		$this->assertSame( 'topology-console', $localize['tree'] );
		$this->assertSame( \NEWSPACK_NODES_VERSION, $localize['version'] );
		$this->assertSame( 3, $localize['topologyWorkers']['synthetic'] );
		$this->assertContains( 'synthetic', $localize['activeTopologies'] );
		$this->assertArrayHasKey( 'configNumPartitions', $localize );

		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
		\Newspack_Nodes\Topology_Registry::reset();
	}

	public function test_register_topology_console_tab_bundle_preserves_existing_bundles(): void {
		$admin    = new Admin();
		$existing  = [ 'handle' => 'some-other', 'dir' => '/x', 'url' => '/x' ];
		$bundles   = $admin->register_topology_console_tab_bundle( [ $existing ] );

		$this->assertContains( $existing, $bundles );
		$this->assertCount( 2, $bundles );
	}

	public function test_topology_console_bundle_registered_on_devtools_tab_bundles_filter(): void {
		// Without this hook the Console tab never loads on the hub — the whole
		// point of moving the console into the hub.
		new Admin();
		$bundles = \apply_filters( 'newspack_nodes/devtools_tab_bundles', [] );

		$handles = \array_map(
			static fn ( $b ) => \is_array( $b ) ? ( $b['handle'] ?? '' ) : '',
			\Newspack_Nodes\Core::arr( $bundles )
		);
		$this->assertContains( 'newspack-nodes-topology-console', $handles );
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

	// ---- register_event_dashboard_pages ----------------------------------

	public function test_register_event_dashboard_pages_registers_no_standalone_submenu(): void {
		// Raw Logs was folded into the DevTools hub as a `host:'hub'` tab (like
		// the Worker Status and Topology Manager dashboards before it), so
		// register_event_dashboard_pages now registers no standalone submenu.
		$admin = new Admin();
		$admin->register_event_dashboard_pages();

		$this->assertArrayNotHasKey( 'newspack-nodes-rawlogs', $GLOBALS['_admin_submenu_pages'] );
	}

	public function test_register_event_dashboard_pages_does_not_register_workers_submenu(): void {
		// The standalone Worker Status dashboard is gone — the hub tab is the
		// sole worker-status home now.
		$admin = new Admin();
		$admin->register_event_dashboard_pages();

		$this->assertArrayNotHasKey( 'newspack-nodes-workers', $GLOBALS['_admin_submenu_pages'] );
	}

	public function test_register_event_dashboard_pages_does_not_register_separate_hub_submenu(): void {
		// The hub is the top-level "Nodes" page now (render_hub_page), so there
		// is no standalone Hub submenu under HUB_MENU_SLUG anymore.
		$admin = new Admin();
		$admin->register_event_dashboard_pages();

		$this->assertArrayNotHasKey( 'newspack-nodes-hub', $GLOBALS['_admin_submenu_pages'] );
	}

	// ---- enqueue_event_dashboards_assets ----------------------------------

	public function test_enqueue_event_dashboards_assets_skips_on_wrong_page(): void {
		$_GET = [ 'page' => 'some-other-admin-page' ];
		( new Admin() )->enqueue_event_dashboards_assets();
		$this->assertEmpty( $GLOBALS['_enqueued_scripts'] );
		$this->assertEmpty( $GLOBALS['_localized_scripts'] );
	}

	public function test_enqueue_event_dashboards_assets_enqueues_for_hub_page(): void {
		// Raw Logs is a hub tab now, so the event-dashboards bundle (which
		// registers the Raw Logs + Topology Manager tabs) loads on the top-level
		// "Nodes" hub page — not a standalone Raw Logs page.
		$asset_path = \NEWSPACK_NODES_DIR . 'build/event-dashboards/index.js';
		$this->assertFileExists( $asset_path, 'event-dashboards build asset missing — run `npm run build` before tests' );

		$_GET = [ 'page' => Admin::HUB_MENU_SLUG ];

		$admin = new Admin();
		$admin->enqueue_event_dashboards_assets();

		$handle = 'newspack-nodes-event-dashboards';
		$this->assertArrayHasKey( $handle, $GLOBALS['_enqueued_scripts'] );
		$enq = $GLOBALS['_enqueued_scripts'][ $handle ];
		$this->assertStringEndsWith( 'build/event-dashboards/index.js', (string) $enq['src'] );
		// Deps now come from the wp-scripts manifest (index.asset.php), not the
		// old hardcoded fallback — assert against the shipped manifest.
		$manifest = require \NEWSPACK_NODES_DIR . 'build/event-dashboards/index.asset.php';
		$this->assertSame( \array_values( $manifest['dependencies'] ), $enq['deps'] );
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

	public function test_enqueue_event_dashboards_assets_skips_removed_workers_page(): void {
		// The standalone Worker Status dashboard is gone, so the event-dashboards
		// bundle must NOT enqueue on its old page slug.
		$_GET = [ 'page' => 'newspack-nodes-workers' ];

		( new Admin() )->enqueue_event_dashboards_assets();

		$this->assertEmpty( $GLOBALS['_enqueued_scripts'] );
	}

	// ---- enqueue_devtools_hub_assets --------------------------------------

	public function test_enqueue_devtools_hub_assets_enqueues_for_top_level_hub_page(): void {
		$asset_path = \NEWSPACK_NODES_DIR . 'build/devtools-hub/index.js';
		$this->assertFileExists( $asset_path, 'devtools-hub build asset missing — run `npm run build` before tests' );

		// The hub bundle loads on the top-level "Nodes" page now.
		$_GET = [ 'page' => Admin::HUB_MENU_SLUG ];

		( new Admin() )->enqueue_devtools_hub_assets();

		$handle = 'newspack-nodes-devtools-hub';
		$this->assertArrayHasKey( $handle, $GLOBALS['_enqueued_scripts'] );
		$enq = $GLOBALS['_enqueued_scripts'][ $handle ];
		$this->assertStringEndsWith( 'build/devtools-hub/index.js', (string) $enq['src'] );

		$this->assertArrayHasKey( $handle, $GLOBALS['_localized_scripts'] );
		$this->assertSame( 'devtools-hub', $GLOBALS['_localized_scripts'][ $handle ]['data']['tree'] );
	}

	// ---- register_event_dashboards_tab_bundle -----------------------------

	public function test_register_event_dashboards_tab_bundle_appends_event_dashboards_bundle(): void {
		$admin   = new Admin();
		$bundles = $admin->register_event_dashboards_tab_bundle( [] );

		$match = null;
		foreach ( $bundles as $bundle ) {
			if ( \is_array( $bundle ) && ( $bundle['handle'] ?? '' ) === 'newspack-nodes-event-dashboards' ) {
				$match = $bundle;
				break;
			}
		}
		$this->assertNotNull( $match, 'event-dashboards bundle not appended' );
		$this->assertStringEndsWith( 'build/event-dashboards', (string) $match['dir'] );
		$this->assertStringEndsWith( 'build/event-dashboards', (string) $match['url'] );
	}

	public function test_register_event_dashboards_tab_bundle_preserves_existing_bundles(): void {
		$admin    = new Admin();
		$existing  = [ 'handle' => 'some-other', 'dir' => '/x', 'url' => '/x' ];
		$bundles   = $admin->register_event_dashboards_tab_bundle( [ $existing ] );

		$this->assertContains( $existing, $bundles );
		$this->assertCount( 2, $bundles );
	}

	public function test_event_dashboards_bundle_registered_on_devtools_tab_bundles_filter(): void {
		// The constructor must hook register_event_dashboards_tab_bundle onto the
		// filter so the Hub page enqueues event-dashboards (→ the manager tab).
		new Admin();
		$bundles = \apply_filters( 'newspack_nodes/devtools_tab_bundles', [] );

		$handles = \array_map(
			static fn ( $b ) => \is_array( $b ) ? ( $b['handle'] ?? '' ) : '',
			\Newspack_Nodes\Core::arr( $bundles )
		);
		$this->assertContains( 'newspack-nodes-event-dashboards', $handles );
	}

	// ---- helpers ----------------------------------------------------------

	private function prepare_lock_dir( string $group, int $partition ): string {
		$dir = "{$this->base_dir}/locks/{$group}.p{$partition}.lock.d";
		\mkdir( $dir, 0755, true );
		return $dir;
	}

	/**
	 * Register a small set of active fixture topologies so the resolver has a
	 * live graph to consult: 'combined' (Partition + Tee), 'aggregator' (Topic),
	 * 'multipart' (3 partitions, Echo). Mirrors RestartPlannerTest::setUp.
	 */
	private function register_fixture_topologies(): void {
		$tmp = $this->make_temp_dir( 'admin-restart-topologies-' );
		\Newspack_Nodes\Topology_Registry::reset();
		\Newspack_Nodes\Topology_Registry::register_stock_dir( $tmp );
		\file_put_contents( "{$tmp}/combined.tsl", "make_node Partition requests:partition <config:logs_dir>/requests.p<partition> 1 2 0\nmake_node Tee fanout\n" );
		\file_put_contents( "{$tmp}/aggregator.tsl", "make_node Topic firehose:topic <config:logs_dir>/firehose.p{partition} 1 1 2 0\n" );
		\file_put_contents( "{$tmp}/multipart.tsl", "var num_partitions = 3\nmake_node Echo relay\n" );
		\update_option( 'newspack_nodes_topologies', [ 'combined', 'aggregator', 'multipart' ] );
		Config::reset();
	}
}

} // close namespace Newspack_Nodes\Tests\Unit\Admin
