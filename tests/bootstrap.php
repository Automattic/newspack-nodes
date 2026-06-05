<?php
/**
 * PHPUnit bootstrap for Newspack Nodes A1 tests.
 *
 * No WordPress; just enough function stubs that the plugin file loads.
 *
 * @package Newspack_Nodes
 */

// Redirect PHP's error_log() to /dev/null so negative-path tests don't spew
// into test output. (Matches newspack-event-logger-plugins/tests/bootstrap.php:35.)
\ini_set( 'error_log', '/dev/null' );

// Point Config at the baseline test config so the substrate's `base_directory`
// lands in `/tmp/newspack-nodes-test` for any test that doesn't override it.
// Tests that need a per-test base_dir use `TestCase::use_base_dir()` which
// writes a tmp config file and re-points this env var.
\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . __DIR__ . '/newspack-nodes-test-config.php' );

\define( 'ABSPATH', '/' );
// Production WP always defines NONCE_SALT; mirror it so command signing doesn't
// emit the forgeable-fallback warning into every /command response body.
// (CommandAuthTest's no-salt case self-skips when this is set.)
\define( 'NONCE_SALT', 'newspack-nodes-test-nonce-salt' );

// Minimal WP stubs needed for the plugin file.
function plugin_dir_path( string $file ): string {
	return \dirname( $file ) . '/';
}

if ( ! function_exists( 'do_action' ) ) {
	$GLOBALS['_wp_actions'] = [];
	function do_action( string $hook, ...$args ): void {
		foreach ( $GLOBALS['_wp_actions'][ $hook ] ?? [] as $cb ) {
			$cb( ...$args );
		}
	}
	function add_action( string $hook, callable $cb, int $priority = 10, int $accepted_args = 1 ): void {
		$GLOBALS['_wp_actions'][ $hook ][] = $cb;
	}
	function apply_filters( string $hook, mixed $value, ...$args ): mixed {
		foreach ( $GLOBALS['_wp_actions'][ $hook ] ?? [] as $cb ) {
			$value = $cb( $value, ...$args );
		}
		return $value;
	}
	function add_filter( string $hook, callable $cb, int $priority = 10, int $accepted_args = 1 ): void {
		$GLOBALS['_wp_actions'][ $hook ][] = $cb;
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

if ( ! function_exists( 'wp_next_scheduled' ) ) {
	function wp_next_scheduled( $hook, $args = [] ) {
		return $GLOBALS['_wp_test_next_scheduled'] ?? false;
	}
}

if ( ! function_exists( 'wp_schedule_event' ) ) {
	function wp_schedule_event( $timestamp, $recurrence, $hook, $args = [] ) {
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
// SupervisorBase falls back to set_transient/get_transient when the object
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
	function sanitize_text_field( $str ) {
		return is_string( $str ) ? trim( strip_tags( $str ) ) : '';
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
	// Records the autoload arg per option so tests can assert autoload
	// hygiene. Mirrors WP's 3-arg signature; `null` = caller unspecified.
	$GLOBALS['_wp_option_autoload'] = [];
	function update_option( string $key, mixed $value, $autoload = null ): bool {
		$GLOBALS['_wp_options'][ $key ]         = $value;
		$GLOBALS['_wp_option_autoload'][ $key ] = $autoload;
		return true;
	}
	function delete_option( string $key ): bool {
		unset( $GLOBALS['_wp_options'][ $key ] );
		return true;
	}
	// WP 6.6+ autoload setter. Records the requested flag so the one-time
	// autoload-correction sweep can be asserted; also mirrors it into the
	// general autoload-capture map.
	$GLOBALS['_wp_set_option_autoload'] = [];
	function wp_set_option_autoload( string $option, $autoload ): bool {
		$GLOBALS['_wp_set_option_autoload'][ $option ] = $autoload;
		$GLOBALS['_wp_option_autoload'][ $option ]     = $autoload;
		return true;
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

if ( ! function_exists( 'wp_unslash' ) ) {
	function wp_unslash( mixed $value ): mixed {
		if ( \is_string( $value ) ) {
			return \stripslashes( $value );
		}
		return $value;
	}
}

if ( ! function_exists( 'wp_json_encode' ) ) {
	function wp_json_encode( $data, $options = 0, $depth = 512 ) {
		return \json_encode( $data, $options, $depth );
	}
}

// Load the plugin (which require_once's the class files and calls
// register_namespace('Newspack_Nodes\\')).
require_once \dirname( __DIR__ ) . '/newspack-nodes.php';

// Register the test namespace so `make_node('Capture_Sink')` resolves
// `Newspack_Nodes\Tests\Capture_Sink_Node` (require'd below; class_exists true).
\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\' );

// Register the substrate `config` token namespace so `<config:…>` resolves in tests.
\Newspack_Nodes\Config::register_token_namespace();

// Load test helpers. (CaptureSink.php defines Capture_Sink_Node.)
require_once __DIR__ . '/Helpers/TestCase.php';
require_once __DIR__ . '/Helpers/CaptureSink.php';
require_once __DIR__ . '/Helpers/BoundedTicks.php';
require_once __DIR__ . '/Helpers/VerbHarness.php';
require_once __DIR__ . '/Helpers/FakeMemcached.php';
require_once __DIR__ . '/Helpers/InMemoryMemcached.php';

// Capture Supervisor fire-and-forget POSTs without actually hitting
// libcurl. `$curl_exec` is a narrow seam — the rest of
// `fire_and_forget_post` (curl_init, curl_setopt_array, errno
// classification) still runs so the tests exercise it. URL comes off
// the handle via curl_getinfo; body comes in as the 2nd arg because PHP
// curl doesn't expose POSTFIELDS through getinfo. Honors the same
// `$_wp_test_remote_post_response` override the wp_remote_post mock
// above honors so test side-effects (e.g. "drop a restart flag when
// this spawn fires") fire in both transports.
// Block real libreadline from firing during tests — even when phpunit is
// invoked interactively (stdin/stdout ARE a tty, so `posix_isatty`-style
// gating is useless). The real call would write the prompt to fd 1 and
// put the terminal into callback mode; `read_char` would then block on
// stdin. Both seams default to the real libcurl/readline calls in
// production and are no-op'd here for the test process.
\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_handler_install = static function ( string $prompt, callable $cb ): void {};
\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_read_char       = static function (): void {};
// Tab-completion registration would call readline_completion_function (needs a
// real TTY); no-op it for the test process.
\Newspack_Nodes\CLI_Stdin_Reader_Node::$readline_completion_register = static function ( callable $cb ): void {};

\Newspack_Nodes\Supervisor::$curl_exec = static function ( $ch, array $body ) {
	$url  = (string) \curl_getinfo( $ch, \CURLINFO_EFFECTIVE_URL );
	$args = [
		'method'    => 'POST',
		'timeout'   => 0.01,
		'blocking'  => false,
		'sslverify' => false,
		'body'      => $body,
	];
	$GLOBALS['_test_outbound_posts'][] = [ 'url' => $url, 'args' => $args ];
	if ( isset( $GLOBALS['_wp_test_remote_post_response'] ) ) {
		$resp = $GLOBALS['_wp_test_remote_post_response'];
		if ( \is_callable( $resp ) ) {
			$resp( $url, $args );
		}
	}
	return false; // simulate "no response received" — we'd hang up anyway.
};

// Pull in each bundled example's test bootstrap so example test suites run as
// part of the main suite. Each example bootstrap require_once's THIS file (a
// no-op mid-include) and registers its namespace for make_node resolution.
foreach ( \glob( __DIR__ . '/../examples/*/tests/bootstrap.php' ) ?: [] as $example_bootstrap ) {
	require_once $example_bootstrap;
}
