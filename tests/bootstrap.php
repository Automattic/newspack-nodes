<?php
/**
 * PHPUnit bootstrap for Newspack Nodes A1 tests.
 *
 * No WordPress; just enough function stubs that the plugin file loads.
 *
 * @package Newspack_Nodes
 */

if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
	error_log("ERROR: refusing to test as root.");
	exit( 1 );
}

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
// Cache_Backend::site() scopes keys by database + table prefix.
\define( 'DB_NAME', 'newspack_nodes_test' );
$GLOBALS['wpdb'] = new class() {
	public string $prefix      = 'wp_';
	public string $base_prefix = 'wp_';
};
// The plugin file (loaded below) defines NEWSPACK_NODES_URL only when
// plugin_dir_url() exists, which the suite doesn't stub — so define it here so
// asset-enqueue paths model real WP (DIR + URL both present).
\define( 'NEWSPACK_NODES_URL', 'http://example.test/wp-content/plugins/newspack-nodes/' );

// Shared WP function/class shims (guarded; consumers require this file too).
require_once __DIR__ . '/Helpers/wp-shims.php';

// Load the plugin (which require_once's the class files and calls
// register_namespace('Newspack_Nodes\\')) with registration recording on, then
// freeze the load-time snapshot and stop recording.
$GLOBALS['_wp_record_registrations'] = true;
require_once \dirname( __DIR__ ) . '/newspack-nodes.php';
$GLOBALS['_wp_initial_action_registrations'] = $GLOBALS['_wp_action_registrations'] ?? [];
unset( $GLOBALS['_wp_record_registrations'] );

// Wire the substrate runtime (node-class namespaces, the `<config:…>` token
// namespace, the stock-topology dir, Core::$memd). Production wires this lazily
// via Bootstrap::ensure_runtime_wired() at its REST/admin/CLI/cron entry points
// (no longer at plugin-file scope); tests boot it explicitly here.
\Newspack_Nodes\Bootstrap::ensure_runtime_wired();

// Register the test namespace so `make_node('Capture_Sink')` resolves
// `Newspack_Nodes\Tests\Capture_Sink_Node` (require'd below; class_exists true).
\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Tests\\' );

// Load test helpers. (CaptureSink.php defines Capture_Sink_Node.)
require_once __DIR__ . '/Helpers/TestCase.php';
require_once __DIR__ . '/Helpers/RedirectException.php';
require_once __DIR__ . '/Helpers/CaptureSink.php';
require_once __DIR__ . '/Helpers/BoundedTicks.php';
require_once __DIR__ . '/Helpers/VerbHarness.php';
require_once __DIR__ . '/Helpers/FakeMemcached.php';
require_once __DIR__ . '/Helpers/InMemoryMemcached.php';
require_once __DIR__ . '/Helpers/TopologyDurability.php';

// Capture the shared fire-and-forget POSTs (spawn fan-out AND
// Worker_Base self-respawn) without actually hitting libcurl. `Core::$curl_exec`
// is a narrow seam — the rest of `Core::fire_and_forget_post` (curl_init,
// curl_setopt_array, errno classification) still runs so the tests exercise it.
// URL comes off the handle via curl_getinfo; body comes in as the 2nd arg
// because PHP curl doesn't expose POSTFIELDS through getinfo. Honors the same
// `$_wp_test_remote_post_response` override the wp_remote_post mock above
// honors so test side-effects (e.g. "drop a restart flag when this spawn
// fires") fire in both transports.
// Block real libreadline from firing during tests — even when phpunit is
// invoked interactively (stdin/stdout ARE a tty, so `posix_isatty`-style
// gating is useless). The real call would write the prompt to fd 1 and
// put the terminal into callback mode; `read_char` would then block on
// stdin. Both seams default to the real libcurl/readline calls in
// production and are no-op'd here for the test process.
\Newspack_Nodes\TTY_In_Node::$readline_handler_install = static function ( string $prompt, callable $cb ): void {};
\Newspack_Nodes\TTY_In_Node::$readline_read_char       = static function (): void {};
// Tab-completion registration would call readline_completion_function (needs a
// real TTY); no-op it for the test process.
\Newspack_Nodes\TTY_In_Node::$readline_completion_register = static function ( callable $cb ): void {};

\Newspack_Nodes\Core::$curl_exec = static function ( $ch, array $body ) {
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
