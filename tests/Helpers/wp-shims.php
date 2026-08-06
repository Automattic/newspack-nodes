<?php
/**
 * Canonical WordPress test shims for the Newspack Nodes substrate.
 *
 * Every definition is wrapped in a function_exists()/class_exists() guard so
 * first-definition wins: sibling plugins (event-logger-nodes, intelligence,
 * cache-cozy) require this file from their own tests/bootstrap.php AFTER any
 * deliberately-divergent local shim, making this the ONE shared shim set.
 *
 * @package Newspack_Nodes
 */

// Minimal WP stubs needed for the plugin file.
if ( ! function_exists( 'plugin_dir_path' ) ) {
	function plugin_dir_path( string $file ): string {
		return \dirname( $file ) . '/';
	}
}

if ( ! function_exists( 'do_action' ) ) {
	$GLOBALS['_wp_actions']              = [];
	$GLOBALS['_wp_action_registrations'] = [];
	// Tests drive these via $GLOBALS['_wp_test_is_multisite'] / '_wp_test_is_main_site'.
	function is_multisite(): bool {
		return (bool) ( $GLOBALS['_wp_test_is_multisite'] ?? false );
	}
	function is_main_site(): bool {
		return (bool) ( $GLOBALS['_wp_test_is_main_site'] ?? true );
	}

	function do_action( string $hook, ...$args ): void {
		foreach ( $GLOBALS['_wp_actions'][ $hook ] ?? [] as $cb ) {
			$cb( ...$args );
		}
	}
	function add_action( string $hook, callable $cb, int $priority = 10, int $accepted_args = 1 ): void {
		$GLOBALS['_wp_actions'][ $hook ][] = $cb;
		// Registration metadata is only recorded during plugin load (the
		// snapshot below); per-test registrations skip the bookkeeping.
		if ( ! empty( $GLOBALS['_wp_record_registrations'] ) ) {
			$GLOBALS['_wp_action_registrations'][ $hook ][] = [
				'callback'      => $cb,
				'priority'      => $priority,
				'accepted_args' => $accepted_args,
			];
		}
	}
	function apply_filters( string $hook, mixed $value, ...$args ): mixed {
		foreach ( $GLOBALS['_wp_actions'][ $hook ] ?? [] as $cb ) {
			$value = $cb( $value, ...$args );
		}
		return $value;
	}
	function add_filter( string $hook, callable $cb, int $priority = 10, int $accepted_args = 1 ): void {
		add_action( $hook, $cb, $priority, $accepted_args );
	}
	function remove_action( string $hook, callable $cb, int $priority = 10 ): bool {
		$list  = $GLOBALS['_wp_actions'][ $hook ] ?? [];
		$keep  = [];
		$found = false;
		foreach ( $list as $registered ) {
			if ( $registered === $cb ) {
				$found = true;
				continue;
			}
			$keep[] = $registered;
		}
		$GLOBALS['_wp_actions'][ $hook ] = $keep;
		return $found;
	}
}

if ( ! function_exists( 'current_filter' ) ) {
	// Tests drive this via $GLOBALS['_wp_test_current_filter'].
	function current_filter(): string {
		return (string) ( $GLOBALS['_wp_test_current_filter'] ?? '' );
	}
}

// ── WordPress REST API Stubs ────────────────────────────────────────────────────

$GLOBALS['_wp_test_registered_routes'] = [];

if ( ! function_exists( 'register_rest_route' ) ) {
	function register_rest_route( $namespace, $route, $args = [] ) {
		$GLOBALS['_wp_test_registered_routes'][] = [
			'namespace' => $namespace,
			'route'     => $route,
			'args'      => $args,
		];
		return true;
	}
}

if ( ! function_exists( 'rest_url' ) ) {
	function rest_url( $path = '' ) {
		return 'http://localhost/wp-json/' . ltrim( $path, '/' );
	}
}

if ( ! function_exists( 'wp_remote_post' ) ) {
	function wp_remote_post( $url, $args = [] ) {
		// Capture for tests; the final positional arg permits inspection.
		$GLOBALS['_test_outbound_posts'][] = [ 'url' => $url, 'args' => $args ];
		// Tests can short-circuit the response by setting this global.
		// Useful for exercising is_wp_error() branches in callers.
		if ( isset( $GLOBALS['_wp_test_remote_post_response'] ) ) {
			$resp = $GLOBALS['_wp_test_remote_post_response'];
			return is_callable( $resp ) ? $resp( $url, $args ) : $resp;
		}
		return [ 'response' => [ 'code' => 200 ] ];
	}
}

if ( ! function_exists( 'wp_remote_retrieve_response_code' ) ) {
	function wp_remote_retrieve_response_code( $response ) {
		return is_array( $response ) ? ( $response['response']['code'] ?? 0 ) : 0;
	}
}

if ( ! function_exists( 'wp_remote_retrieve_body' ) ) {
	function wp_remote_retrieve_body( $response ) {
		return is_array( $response ) ? ( $response['body'] ?? '' ) : '';
	}
}

if ( ! function_exists( 'wp_next_scheduled' ) ) {
	function wp_next_scheduled( $hook, $args = [] ) {
		return $GLOBALS['_wp_test_next_scheduled'] ?? false;
	}
}

if ( ! function_exists( 'wp_schedule_event' ) ) {
	function wp_schedule_event( $timestamp, $recurrence, $hook, $args = [], $wp_error = false ) {
		if ( isset( $GLOBALS['_wp_test_schedule_event_response'] ) ) {
			$resp = $GLOBALS['_wp_test_schedule_event_response'];
			return is_callable( $resp ) ? $resp( $timestamp, $recurrence, $hook, $args, $wp_error ) : $resp;
		}
		$GLOBALS['_wp_test_scheduled_events'][] = [
			'timestamp'  => $timestamp,
			'recurrence' => $recurrence,
			'hook'       => $hook,
			'args'       => $args,
		];
		return true;
	}
}

if ( ! function_exists( 'wp_clear_scheduled_hook' ) ) {
	function wp_clear_scheduled_hook( $hook, $args = [] ) {
		return true;
	}
}

if ( ! function_exists( 'wp_unschedule_event' ) ) {
	function wp_unschedule_event( $timestamp, $hook, $args = [] ) {
		$GLOBALS['_wp_test_unscheduled_events'][] = [
			'timestamp' => $timestamp,
			'hook'      => $hook,
			'args'      => $args,
		];
		return true;
	}
}

// ── Auth / capability stubs ───────────────────────────────────────────────────

if ( ! function_exists( 'current_user_can' ) ) {
	function current_user_can( $cap ) {
		return $GLOBALS['_wp_test_current_user_can'][ $cap ] ?? false;
	}
}

if ( ! function_exists( 'wp_verify_nonce' ) ) {
	function wp_verify_nonce( $nonce, $action ) {
		return ( $GLOBALS['_wp_test_valid_nonces'][ $action ] ?? null ) === $nonce ? 1 : false;
	}
}

if ( ! function_exists( 'get_current_user_id' ) ) {
	function get_current_user_id() {
		return $GLOBALS['_wp_test_current_user_id'] ?? 0;
	}
}

if ( ! function_exists( 'wp_get_current_user' ) ) {
	function wp_get_current_user() {
		return (object) [ 'user_login' => $GLOBALS['_wp_test_current_user_login'] ?? '' ];
	}
}

if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $thing ) {
		return $thing instanceof \WP_Error;
	}
}

// ── Transient + cache stubs ───────────────────────────────────────────────────

if ( ! function_exists( 'get_transient' ) ) {
	function get_transient( $key ) {
		$store = $GLOBALS['_wp_test_transients'] ?? [];
		if ( ! isset( $store[ $key ] ) ) {
			return false;
		}
		[ $value, $expires_at ] = $store[ $key ];
		if ( 0 !== $expires_at && time() >= $expires_at ) {
			unset( $GLOBALS['_wp_test_transients'][ $key ] );
			return false;
		}
		return $value;
	}
}

if ( ! function_exists( 'set_transient' ) ) {
	function set_transient( $key, $value, $expiration = 0 ) {
		$expires_at                              = $expiration > 0 ? time() + $expiration : 0;
		$GLOBALS['_wp_test_transients'][ $key ]  = [ $value, $expires_at ];
		return true;
	}
}

// Note: wp_cache_set / wp_cache_get are intentionally NOT stubbed here.
// Spawn_Coordinator falls back to set_transient/get_transient when the object
// cache API is unavailable, and the cross-process persistence test exercises
// that fallback path. Tests can opt into object-cache simulation by defining
// these in their own setUp via runkit (not currently used).

// ── REST helpers ──────────────────────────────────────────────────────────────

if ( ! function_exists( 'rest_authorization_required_code' ) ) {
	function rest_authorization_required_code() {
		return 401;
	}
}

if ( ! function_exists( 'sanitize_text_field' ) ) {
	// Body kept in lockstep with ELN's stub (its tests/bootstrap.php).
	function sanitize_text_field( mixed $v ): string {
		if ( ! is_string( $v ) ) {
			return '';
		}
		$v = \strip_tags( $v );
		$v = \preg_replace( '/[\x00-\x1F\x7F]/', '', $v ) ?? $v;
		$v = \preg_replace( '/\s+/', ' ', $v ) ?? $v;
		return \trim( $v );
	}
}

if ( ! function_exists( 'ignore_user_abort' ) && ! function_exists( '\\ignore_user_abort' ) ) {
	// Built-in PHP function — no need to stub. Kept for symmetry.
}

if ( ! function_exists( 'register_activation_hook' ) ) {
	function register_activation_hook( $file, $callback ) {
		$GLOBALS['_wp_test_activation_hooks'][] = [ 'file' => $file, 'callback' => $callback ];
	}
}

if ( ! function_exists( 'register_deactivation_hook' ) ) {
	function register_deactivation_hook( $file, $callback ) {
		$GLOBALS['_wp_test_deactivation_hooks'][] = [ 'file' => $file, 'callback' => $callback ];
	}
}

if ( ! class_exists( 'WP_REST_Server' ) ) {
	class WP_REST_Server {
		const READABLE   = 'GET';
		const CREATABLE  = 'POST';
		const EDITABLE   = 'PUT, PATCH';
		const DELETABLE  = 'DELETE';
		const ALLMETHODS = 'GET, POST, PUT, PATCH, DELETE';
	}
}

if ( ! class_exists( 'WP_HTTP_Response' ) ) {
	class WP_HTTP_Response {
		public $data;
		public $status;
		public $headers = [];
		public function __construct( $data = null, $status = 200, $headers = [] ) {
			$this->data    = $data;
			$this->status  = $status;
			$this->headers = $headers;
		}
		public function get_data() {
			return $this->data;
		}
		public function get_status() {
			return $this->status;
		}
		public function get_headers() {
			return $this->headers;
		}
	}
}

if ( ! class_exists( 'WP_REST_Response' ) ) {
	class WP_REST_Response extends WP_HTTP_Response {
		public function set_status( $code ) {
			$this->status = $code;
		}
		public function set_data( $data ) {
			$this->data = $data;
		}
	}
}

if ( ! class_exists( 'WP_REST_Request' ) ) {
	class WP_REST_Request {
		private $params     = [];
		private $url_params = [];
		private $headers    = [];
		private $body       = '';
		private $method     = 'GET';
		public function __construct( $method = 'GET', $route = '' ) {
			$this->method = $method;
		}
		public function get_param( $key ) {
			return $this->params[ $key ] ?? $this->url_params[ $key ] ?? null;
		}
		public function set_param( $key, $value ) {
			$this->params[ $key ] = $value;
		}
		public function get_params() {
			return $this->params;
		}
		public function get_method() {
			return $this->method;
		}
		public function set_url_params( array $params ): void {
			$this->url_params = $params;
		}
		public function set_body( string $body ): void {
			$this->body = $body;
		}
		public function get_body(): string {
			return $this->body;
		}
		public function set_header( string $name, string $value ): void {
			// Real WP_REST_Request normalizes header keys to underscored
			// lowercase for get_header() lookup ('X-WP-Nonce' → 'x_wp_nonce').
			$this->headers[ \strtolower( \str_replace( '-', '_', $name ) ) ] = $value;
		}
		public function get_header( string $name ): ?string {
			return $this->headers[ \strtolower( \str_replace( '-', '_', $name ) ) ] ?? null;
		}
	}
}

if ( ! class_exists( 'WP_Error' ) ) {
	class WP_Error {
		private $code;
		private $message;
		private $error_data;
		public function __construct( $code = '', $message = '', $data = '' ) {
			$this->code       = $code;
			$this->message    = $message;
			$this->error_data = $data;
		}
		public function get_error_code() {
			return $this->code;
		}
		public function get_error_message() {
			return $this->message;
		}
		public function get_error_data() {
			return $this->error_data;
		}
	}
}

if ( ! function_exists( 'fastcgi_finish_request' ) ) {
	function fastcgi_finish_request() {
		// No-op in test context.
		return true;
	}
}

if ( ! function_exists( 'status_header' ) ) {
	// Track every status_header() emission so tests can assert on the
	// IPC-202 path of HTTP_In's dispatch(), which writes
	// `status_header(202)` directly, NOT through the status-header seam.
	$GLOBALS['_wp_test_status_headers'] = [];
	function status_header( int $code ): void {
		$GLOBALS['_wp_test_status_headers'][] = $code;
	}
}

// ── WP option / esc helpers — Config tests require these. ──────────────────

if ( ! function_exists( 'get_option' ) ) {
	$GLOBALS['_wp_options'] = [];
	function get_option( string $key, mixed $default = false ): mixed {
		return $GLOBALS['_wp_options'][ $key ] ?? $default;
	}
	function update_option( string $key, mixed $value, $autoload = null ): bool {
		$GLOBALS['_wp_options'][ $key ] = $value;
		return true;
	}
	function delete_option( string $key ): bool {
		unset( $GLOBALS['_wp_options'][ $key ] );
		return true;
	}
	// WP 6.4+ bulk option-cache primer. Records the primed option names so tests
	// can assert the overlay batches its reads into one call (a no-op for the
	// array-backed get_option stub above — it just records intent).
	$GLOBALS['_wp_primed_options'] = [];
	function wp_prime_option_caches( array $options ): void {
		$GLOBALS['_wp_primed_options'] = array_merge( $GLOBALS['_wp_primed_options'], $options );
	}
}

if ( ! function_exists( 'home_url' ) ) {
	function home_url( string $path = '' ): string {
		return ( $GLOBALS['_wp_test_home_url'] ?? 'https://test.example' ) . $path;
	}
}

if ( ! function_exists( 'wp_salt' ) ) {
	function wp_salt( string $scheme = 'auth' ): string {
		return 'TEST_SALT_FOR_' . $scheme;
	}
}

if ( ! function_exists( 'esc_url_raw' ) ) {
	function esc_url_raw( string $url ): string {
		return \filter_var( $url, FILTER_SANITIZE_URL ) ?: '';
	}
}

if ( ! function_exists( 'esc_html' ) ) {
	function esc_html( string $value ): string {
		return \htmlspecialchars( $value, ENT_QUOTES, 'UTF-8' );
	}
}

// i18n passthrough — matches production, where `__` is always present when a
// plugin file runs; guards any test code that reaches `__` outside its own stub.
if ( ! function_exists( '__' ) ) {
	function __( string $text, string $domain = 'default' ): string {
		return $text;
	}
}

if ( ! function_exists( 'wp_unslash' ) ) {
	function wp_unslash( mixed $value ): mixed {
		if ( \is_string( $value ) ) {
			return \stripslashes( $value );
		}
		return $value;
	}
}

// The bundled example plugin file gates its admin-hook registration on
// is_admin() at file scope, and its enqueue site builds asset URLs via
// plugins_url(); stub both so the Examples suite can load + drive them.
if ( ! function_exists( 'is_admin' ) ) {
	function is_admin(): bool {
		return true;
	}
}
if ( ! function_exists( 'plugins_url' ) ) {
	function plugins_url( string $path = '', string $plugin = '' ): string {
		return 'http://example.test/wp-content/plugins/' . \basename( \dirname( $plugin ) ) . '/' . \ltrim( $path, '/' );
	}
}

if ( ! function_exists( 'wp_json_encode' ) ) {
	function wp_json_encode( $data, $options = 0, $depth = 512 ) {
		return \json_encode( $data, $options, $depth );
	}
}

// WP Settings-API / admin-form / escaping / i18n stubs shared by every suite.
// The recorder stubs write their arguments into globals; assertions read those
// globals. Per-file stub copies are forbidden going forward — a local copy hides
// a missing-stub failure from sibling suites (a suite run in isolation would
// fatal on a stub that only another file happened to define).
if ( ! function_exists( 'register_setting' ) ) {
	function register_setting( string $group, string $option, array $args = [] ): void {
		$GLOBALS['_registered_settings'][ $option ] = [
			'group' => $group,
			'args'  => $args,
		];
	}
}
if ( ! function_exists( 'add_settings_section' ) ) {
	function add_settings_section( string $id, string $title, callable $cb, string $page ): void {
		$GLOBALS['_registered_sections'][ $id ] = [
			'title'    => $title,
			'callback' => $cb,
			'page'     => $page,
		];
	}
}
if ( ! function_exists( 'add_settings_field' ) ) {
	function add_settings_field( string $id, string $title, callable $cb, string $page, string $section ): void {
		$GLOBALS['_registered_fields'][ $id ] = [
			'title'    => $title,
			'callback' => $cb,
			'page'     => $page,
			'section'  => $section,
		];
	}
}
if ( ! function_exists( 'add_settings_error' ) ) {
	function add_settings_error( string $setting, string $code, string $message, string $type = 'error' ): void {
		$GLOBALS['_settings_errors'][] = [
			'setting' => $setting,
			'code'    => $code,
			'message' => $message,
			'type'    => $type,
		];
	}
}
if ( ! function_exists( 'settings_fields' ) ) {
	function settings_fields( string $group ): void {
		echo '<input type="hidden" name="option_page" value="' . \htmlspecialchars( $group, ENT_QUOTES ) . '" />';
	}
}
if ( ! function_exists( 'do_settings_sections' ) ) {
	function do_settings_sections( string $page ): void {
		echo '<!-- do_settings_sections:' . \htmlspecialchars( $page, ENT_QUOTES ) . ' -->';
	}
}
if ( ! function_exists( 'submit_button' ) ) {
	function submit_button( string $text = 'Save', string $type = 'primary', string $name = 'submit', bool $wrap = true ): void {
		echo '<input type="submit" />';
	}
}
if ( ! function_exists( 'wp_nonce_field' ) ) {
	function wp_nonce_field( string $action, string $name ): void {
		echo '<input type="hidden" name="' . \htmlspecialchars( $name, ENT_QUOTES ) . '" value="' . \htmlspecialchars( ( $GLOBALS['_wp_test_valid_nonces'][ $action ] ?? '' ), ENT_QUOTES ) . '" />';
	}
}
if ( ! function_exists( 'admin_url' ) ) {
	function admin_url( string $path = '' ): string {
		return 'http://localhost/wp-admin/' . \ltrim( $path, '/' );
	}
}
if ( ! function_exists( 'add_query_arg' ) ) {
	function add_query_arg( array $args, string $url ): string {
		$sep = false === \strpos( $url, '?' ) ? '?' : '&';
		$kv  = [];
		foreach ( $args as $k => $v ) {
			$kv[] = \rawurlencode( (string) $k ) . '=' . \rawurlencode( (string) $v );
		}
		return $url . $sep . \implode( '&', $kv );
	}
}
if ( ! function_exists( 'wp_safe_redirect' ) ) {
	// Redirect-then-exit short-circuits the test runner. Throw a sentinel
	// exception instead so each test can catch it explicitly.
	function wp_safe_redirect( string $url ): void {
		$GLOBALS['_last_redirect'] = $url;
		throw new \Newspack_Nodes\Tests\Helpers\RedirectException( $url );
	}
}
if ( ! function_exists( 'wp_die' ) ) {
	function wp_die( string $message ): void {
		throw new \RuntimeException( 'wp_die: ' . $message );
	}
}
if ( ! function_exists( 'add_options_page' ) ) {
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
if ( ! function_exists( 'add_menu_page' ) ) {
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
if ( ! function_exists( 'add_submenu_page' ) ) {
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
if ( ! function_exists( 'wp_enqueue_script' ) ) {
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
if ( ! function_exists( 'wp_enqueue_style' ) ) {
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
if ( ! function_exists( 'wp_register_style' ) ) {
	function wp_register_style(
		string $handle,
		string $src = '',
		array $deps = [],
		$ver = false
	): bool {
		$GLOBALS['_registered_styles'][ $handle ] = [
			'src'     => $src,
			'deps'    => $deps,
			'version' => $ver,
		];
		$GLOBALS['_wp_register_style_calls'][ $handle ] =
			( $GLOBALS['_wp_register_style_calls'][ $handle ] ?? 0 ) + 1;
		return true;
	}
}
if ( ! function_exists( 'wp_style_is' ) ) {
	function wp_style_is( string $handle, string $status = 'enqueued' ): bool {
		if ( 'registered' === $status ) {
			return isset( $GLOBALS['_registered_styles'][ $handle ] );
		}
		return isset( $GLOBALS['_enqueued_styles'][ $handle ] );
	}
}
if ( ! function_exists( 'wp_localize_script' ) ) {
	function wp_localize_script( string $handle, string $object_name, array $data ): bool {
		$GLOBALS['_localized_scripts'][ $handle ] = [
			'object_name' => $object_name,
			'data'        => $data,
		];
		return true;
	}
}
if ( ! function_exists( 'wp_style_add_data' ) ) {
	function wp_style_add_data( string $handle, string $key, $value ): bool {
		$GLOBALS['_style_data'][ $handle ][ $key ] = $value;
		return true;
	}
}
if ( ! function_exists( 'wp_create_nonce' ) ) {
	function wp_create_nonce( string $action ): string {
		return 'nonce_' . \substr( \md5( $action ), 0, 10 );
	}
}
if ( ! function_exists( 'esc_textarea' ) ) {
	function esc_textarea( $v ): string {
		return \htmlspecialchars( (string) $v, ENT_QUOTES, 'UTF-8' );
	}
}
if ( ! function_exists( 'esc_attr' ) ) {
	function esc_attr( $v ): string {
		return \htmlspecialchars( (string) $v, ENT_QUOTES, 'UTF-8' );
	}
}
if ( ! function_exists( 'esc_html__' ) ) {
	function esc_html__( string $v, string $domain = '' ): string {
		return \htmlspecialchars( $v, ENT_QUOTES, 'UTF-8' );
	}
}
if ( ! function_exists( 'esc_html_e' ) ) {
	function esc_html_e( string $v, string $domain = '' ): void {
		echo \htmlspecialchars( $v, ENT_QUOTES, 'UTF-8' );
	}
}
if ( ! function_exists( 'esc_attr__' ) ) {
	function esc_attr__( string $v, string $domain = '' ): string {
		return \htmlspecialchars( $v, ENT_QUOTES, 'UTF-8' );
	}
}
if ( ! function_exists( 'esc_attr_e' ) ) {
	function esc_attr_e( string $v, string $domain = '' ): void {
		echo \htmlspecialchars( $v, ENT_QUOTES, 'UTF-8' );
	}
}
if ( ! function_exists( 'esc_url' ) ) {
	function esc_url( string $v ): string {
		return $v;
	}
}
if ( ! function_exists( 'esc_js' ) ) {
	function esc_js( string $v ): string {
		return \str_replace( [ "'", '"', '<', '>' ], [ "\\'", '\\"', '\\u003c', '\\u003e' ], $v );
	}
}
if ( ! function_exists( 'checked' ) ) {
	function checked( $checked, $current = true ): string {
		$out = (string) $checked === (string) $current ? ' checked="checked"' : '';
		echo $out;
		return $out;
	}
}
if ( ! function_exists( 'absint' ) ) {
	function absint( $v ): int {
		return \abs( (int) $v );
	}
}
