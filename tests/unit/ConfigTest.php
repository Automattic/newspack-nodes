<?php
/**
 * Tests for the substrate Config (file overlay + WP options + path validation).
 * Mirrors the application-side ConfigTest, scoped to substrate
 * keys (base_directory, num_partitions, max_segments, segment_size,
 * max_lifetime, memcache_servers).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CLI;
use Newspack_Nodes\Config;
use Newspack_Nodes\Config_Utils;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\TestCase;

#[\PHPUnit\Framework\Attributes\CoversClass( Config::class )]
class ConfigTest extends TestCase {

	private string $temp_dir;

	/** Saved snapshot of `Config::$registered_keys` (a process-wide static). */
	private array $saved_registered_keys = [];

	/** Stand-in consumer plugin's DECLARE_ACTION callback; removed in tearDown. */
	private \Closure $consumer_declaration;

	protected function setUp(): void {
		parent::setUp();
		Config::reset();
		$this->temp_dir = (string) \realpath( \sys_get_temp_dir() ) . '/newspack-nodes-test-config-' . \uniqid();
		@\mkdir( $this->temp_dir, 0755, true );
		// Clear WP option store between tests.
		$GLOBALS['_wp_options'] = [];
		// Clear any LOCAL_NEWSPACK_NODES_CONF leftover.
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' );
		// Snapshot the declared-key registry; simulate_unwired_request() empties it.
		$keys                        = new \ReflectionProperty( Config::class, 'registered_keys' );
		$this->saved_registered_keys = $keys->getValue();
		$this->consumer_declaration  = static fn () => Config::register_keys( [ 'acme_consumer_key' ] );
	}

	protected function tearDown(): void {
		CLI::$uid_provider = null; // process-global seam; must not leak
		$this->rmdir_recursive( $this->temp_dir );
		Config::reset();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' );
		$GLOBALS['_wp_options'] = [];
		\remove_action( Config::DECLARE_ACTION, $this->consumer_declaration );
		// Restore the declared-key registry (emptied by simulate_unwired_request).
		$keys = new \ReflectionProperty( Config::class, 'registered_keys' );
		$keys->setValue( null, $this->saved_registered_keys );
		parent::tearDown();
	}

	public function test_completed_migration_surface_is_absent(): void {
		$this->assertFalse( \method_exists( Config::class, 'correct_option_autoload' ) );
		$this->assertFalse( \class_exists( '\\Newspack_Nodes\\Remote_Settings_Migration' ) );
		$this->assertFalse( \class_exists( '\\Newspack_Nodes\\Retention_Settings_Migration' ) );
		$this->assertFalse( \class_exists( '\\Newspack_Nodes\\Vault_Migration' ) );
	}

	public function test_activation_hooks_exclude_completed_migrations(): void {
		$callbacks = \array_column( $GLOBALS['_wp_test_activation_hooks'] ?? [], 'callback' );
		$this->assertContains( [ '\\Newspack_Nodes\\Bootstrap', 'activate' ], $callbacks );

		foreach (
			[
				[ '\\Newspack_Nodes\\Config', 'correct_option_autoload' ],
				[ '\\Newspack_Nodes\\Remote_Settings_Migration', 'maybe_migrate' ],
				[ '\\Newspack_Nodes\\Retention_Settings_Migration', 'migrate' ],
				[ '\\Newspack_Nodes\\Vault_Migration', 'maybe_migrate' ],
			] as $completed_migration
		) {
			$this->assertNotContains( $completed_migration, $callbacks );
		}
	}

	// ── load_config: shape + caching ───────────────────────────────────────

	public function test_load_config_returns_array(): void {
		$config = Config::load_config();
		$this->assertIsArray( $config );
	}

	public function test_load_config_has_base_directory(): void {
		// `base_directory` comes from the config file (or the hardcoded
		// `/tmp/newspack-nodes` fallback when no file exists).
		$config = Config::load_config();
		$this->assertArrayHasKey( 'base_directory', $config );
		$this->assertNotEmpty( $config['base_directory'] );
	}

	public function test_load_config_caches_result(): void {
		$config1 = Config::load_config();
		$config2 = Config::load_config();
		$this->assertSame( $config1, $config2 );
	}

	public function test_load_config_includes_memcache_servers(): void {
		$config = Config::load_config();
		$this->assertArrayHasKey( 'memcache_servers', $config );
	}

	public function test_memcache_servers_wp_option_override_applies(): void {
		// The admin sanitizer now stores the typed (array) shape, so the raw
		// overlay yields an array and no read-time coercion is needed.
		\update_option( 'newspack_nodes_memcache_servers', [ 'test-host:11211' ] );
		Config::reset();
		$this->assertSame( [ 'test-host:11211' ], Config::load_config()['memcache_servers'] );
	}

	public function test_load_config_caches_repeated_calls(): void {
		$a = Config::load_config();
		$b = Config::load_config();
		$this->assertSame( $a, $b );
	}

	public function test_reset_clears_cache(): void {
		$config1 = Config::load_config();
		Config::reset();
		$config2 = Config::load_config();
		$this->assertEquals( $config1, $config2 );
	}

	public function test_load_config_defaults_cached(): void {
		Config::reset();
		$d1 = Config::load_config_defaults();
		$d2 = Config::load_config_defaults();
		$this->assertSame( $d1, $d2 );
	}

	// ── value(): fail-loud declared-key accessor ───────────────────────────

	public function test_value_returns_configured_value_for_declared_key(): void {
		// A declared key with a stored option returns the override, distinct
		// from every hardcoded fallback (1/0) a silently-ignored read would give.
		\update_option( 'newspack_nodes_num_partitions', '13' );
		Config::reset();
		$this->assertSame( '13', Config::value( 'num_partitions' ) );
	}

	public function test_value_throws_for_undeclared_key(): void {
		// A renamed/typo'd key is not in the registered set → fail loud instead
		// of limping on a default.
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/unknown config key/' );
		Config::value( 'definitely_not_a_real_config_key_zzz' );
	}

	public function test_value_returns_schema_default_when_option_unset(): void {
		// Declared-but-unset (no WP option) resolves the declared file default,
		// distinct from the old `?? 1` fallback the migration drops.
		$conf = $this->temp_dir . '/np-default.php';
		\file_put_contents( $conf, "<?php return [ 'num_partitions' => 9 ];\n" );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
		\delete_option( 'newspack_nodes_num_partitions' );
		Config::reset();
		$this->assertSame( 9, Config::value( 'num_partitions' ) );
	}

	public function test_value_resolves_config_file_only_key(): void {
		// vault_verify_ssl is a config-file default, NOT a Settings_Schema key.
		// The file IS a declaration, so value() must resolve it — returning the
		// declared value, distinct from the old `?? true` silent fallback.
		$conf = $this->temp_dir . '/vault-ssl.php';
		\file_put_contents( $conf, "<?php return [ 'vault_verify_ssl' => false ];\n" );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
		Config::reset();
		$this->assertFalse( Config::value( 'vault_verify_ssl' ) );
	}

	public function test_register_keys_extends_the_valid_set(): void {
		// A consumer plugin registers its own key; value() stops throwing for it.
		Config::register_keys( [ 'my_plugin_key' ] );
		$this->assertNull( Config::value( 'my_plugin_key' ) );
	}

	public function test_is_declared_true_for_registered_key(): void {
		// A consumer accessor calls this to validate before reading its own config.
		Config::register_keys( [ 'is_declared_probe_key' ] );
		$this->assertTrue( Config::is_declared( 'is_declared_probe_key' ) );
	}

	public function test_is_declared_false_for_unregistered_key(): void {
		$this->assertFalse( Config::is_declared( 'is_declared_never_registered_key' ) );
	}

	public function test_is_declared_self_declares_own_keys_without_runtime_wiring(): void {
		// A frontend page view never runs Bootstrap::ensure_runtime_wired(), so
		// declaration cannot hang off it: Config derives its own key set on first
		// read. Both halves — Settings_Schema overlay keys (num_partitions) AND
		// config-file-only keys (vault_verify_ssl) — must be declared.
		$this->simulate_unwired_request();
		$this->assertTrue( Config::is_declared( 'num_partitions' ) );
		$this->assertTrue( Config::is_declared( 'vault_verify_ssl' ) );
	}

	public function test_value_reads_own_key_without_runtime_wiring(): void {
		// The staging fatal: Log_Manager's firehose init reads num_partitions on a
		// frontend request and value() threw "unknown config key". 7 is distinct
		// from the shipped default (1), so a config that silently ignores the
		// option overlay fails this too.
		$conf = $this->temp_dir . '/unwired.php';
		\file_put_contents( $conf, "<?php return [ 'num_partitions' => 7 ];\n" );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
		$this->simulate_unwired_request();
		$this->assertSame( 7, Config::value( 'num_partitions' ) );
	}

	public function test_declare_config_keys_action_pulls_consumer_declarations(): void {
		// A consumer plugin can only declare its keys once the substrate class is
		// loadable — which for a plugin sorting before newspack-nodes is AFTER its
		// own file scope. So declaration is PULLED: whenever the substrate derives
		// its declared set it fires DECLARE_ACTION, and consumers declare there.
		// Without the pull, a consumer key read before the consumer's own boot hook
		// throws "unknown config key" — the staging fatal, one layer up.
		\add_action( Config::DECLARE_ACTION, $this->consumer_declaration );
		$this->simulate_unwired_request();
		$this->assertTrue( Config::is_declared( 'acme_consumer_key' ) );
	}

	public function test_declare_action_pulls_a_consumer_that_hooks_after_the_first_read(): void {
		// Load order: newspack-nodes' own file scope reads a key on an admin request
		// (is_admin → ensure_diagnostics_wired → init_memcached → value('memcache_servers')),
		// which happens BEFORE a consumer sorting after it (pyrobase) has hooked
		// DECLARE_ACTION. A one-shot pull would lock that consumer's keys out for the
		// whole request, so a miss must re-pull before it becomes a throw.
		$this->simulate_unwired_request();
		Config::is_declared( 'memcache_servers' );
		\add_action( Config::DECLARE_ACTION, $this->consumer_declaration );
		$this->assertTrue( Config::is_declared( 'acme_consumer_key' ) );
	}

	public function test_a_declaring_consumer_that_reads_an_unknown_key_cannot_recurse(): void {
		// DECLARE_ACTION runs third-party callbacks from inside a config read, and a
		// miss re-pulls — so a callback that itself reads an unknown key would re-enter
		// the derive, re-fire the action, and recurse without bound (stack overflow
		// instead of the clean "unknown config key" throw). Declaration is re-entrant-
		// safe: at most the initial pull plus one re-pull, however deep the callback goes.
		$calls    = 0;
		$reentrant = function () use ( &$calls ): void {
			++$calls;
			if ( $calls > 5 ) {
				return; // Bail so an unbounded regression fails the assert, not the runner.
			}
			Config::is_declared( 'key_the_callback_asks_about' );
		};
		\add_action( Config::DECLARE_ACTION, $reentrant );
		$this->simulate_unwired_request();

		$this->assertFalse( Config::is_declared( 'a_key_nobody_declares' ) );
		$this->assertSame( 2, $calls, 'initial pull + one re-pull on the miss' );

		\remove_action( Config::DECLARE_ACTION, $reentrant );
	}

	public function test_reset_keeps_declarations_when_the_consumer_hook_is_gone(): void {
		// Declarations are MONOTONE: reset() re-derives additively and never empties
		// the registry. Pruning it would make the whole declared set hostage to the
		// DECLARE_ACTION callbacks still being registered at re-derive time — a
		// consumer whose hook was dropped (test isolation wipes $wp_actions; prod
		// code can remove_action) would have every one of its keys throw, i.e. a
		// 500 on every request, to buy the pruning of a key nobody reads.
		\add_action( Config::DECLARE_ACTION, $this->consumer_declaration );
		$this->assertTrue( Config::is_declared( 'acme_consumer_key' ) );
		\remove_action( Config::DECLARE_ACTION, $this->consumer_declaration );
		Config::reset();
		$this->assertTrue( Config::is_declared( 'acme_consumer_key' ) );
	}

	/** Empty the declared-key registry: a fresh frontend process, nothing wired. */
	private function simulate_unwired_request(): void {
		$ref = new \ReflectionProperty( Config::class, 'registered_keys' );
		$ref->setValue( null, [] );
		Config::reset();
	}

	// ── File-overlay env override ──────────────────────────────────────────

	public function test_local_env_override_loads_external_file(): void {
		$override_path = $this->temp_dir . '/override.php';
		\file_put_contents(
			$override_path,
			"<?php return [ 'operator_override_sentinel' => 'nodes-external-8317' ];\n"
		);

		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $override_path );
		Config::reset();
		$config = Config::load_config_defaults();
		$this->assertSame( 'nodes-external-8317', $config['operator_override_sentinel'] );
	}

	public function test_invalid_explicit_local_env_override_throws(): void {
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=/definitely/missing/nodes-override-8317.php' );
		Config::reset();

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'LOCAL_NEWSPACK_NODES_CONF' );

		Config::load_config_defaults();
	}

	// ── WP option overrides ────────────────────────────────────────────────

	public function test_wp_option_override_takes_effect(): void {
		Config::reset();
		\update_option( 'newspack_nodes_num_partitions', '8' );
		$config = Config::load_config();
		// Options are read raw now (no read-time coercion); the stored numeric
		// string passes through unchanged.
		$this->assertSame( '8', $config['num_partitions'] );
	}

	public function test_present_empty_wp_option_overrides_file_default(): void {
		// Presence decides override, not emptiness: a stored '' is a deliberate
		// value and wins over the file default. To get the default back, the
		// option must be deleted (see the absence test below), which is what the
		// admin "reset to defaults" does.
		Config::reset();
		\update_option( 'newspack_nodes_num_partitions', '' );
		$config = Config::load_config();
		$this->assertSame( '', $config['num_partitions'] );
	}

	public function test_absent_wp_option_uses_file_default(): void {
		// Only true absence (no stored row) falls back to the file default.
		Config::reset();
		\delete_option( 'newspack_nodes_num_partitions' );
		$config = Config::load_config();
		$this->assertSame( 1, $config['num_partitions'] );
	}

	public function test_allowed_users_wp_option_override_applies(): void {
		Config::reset();
		\update_option( 'newspack_nodes_allowed_users', [ 'alice', 'bob' ] );
		$config = Config::load_config();
		$this->assertSame( [ 'alice', 'bob' ], $config['allowed_users'] );
	}

	public function test_wp_option_uses_substrate_prefix(): void {
		// Substrate Config reads `newspack_nodes_*` options. The application
		// `newspack_event_logger_nodes_*` namespace MUST be ignored here.
		Config::reset();
		\update_option( 'newspack_event_logger_nodes_num_partitions', '99' );
		$config = Config::load_config();
		// Should NOT have picked up the application-namespaced option.
		$this->assertNotSame( 99, $config['num_partitions'] );
	}

	// ── invalidate_options_cache: per-key purge ────────────────────────────

	#[\PHPUnit\Framework\Attributes\RunInSeparateProcess]
	public function test_invalidate_options_cache_purges_each_schema_keys_own_cache_entry(): void {
		// The aggregate `alloptions`/`notoptions` groups are only two of the cache
		// entries a long-running process can hold stale — WP core also caches each
		// option under its own key. A supervisor process that read `topologies`
		// once and never saw invalidate_options_cache() purge THAT key would keep
		// serving the stale value forever, no matter how often reset() runs.
		$GLOBALS['_wp_cache_delete_calls'] = [];
		require_once __DIR__ . '/../Helpers/wp-cache-delete-stub.php';

		Config::invalidate_options_cache();

		$deleted = \array_column( $GLOBALS['_wp_cache_delete_calls'], 0 );
		$this->assertContains( 'alloptions', $deleted );
		$this->assertContains( 'notoptions', $deleted );
		$this->assertContains( 'newspack_nodes_topologies', $deleted, 'the per-key cache entry for a schema key must be purged too' );
	}

	// ── Path/directory accessors ───────────────────────────────────────────

	public function test_get_base_directory_creates_dir(): void {
		\update_option( 'newspack_nodes_base_directory', $this->temp_dir . '/base' );
		Config::reset();
		$base = Config::get_base_directory();
		$this->assertSame( $this->temp_dir . '/base', $base );
		$this->assertDirectoryExists( $base );
	}

	public function test_get_logs_locks_offsets_dirs(): void {
		\update_option( 'newspack_nodes_base_directory', $this->temp_dir . '/base2' );
		Config::reset();
		$logs    = Config::get_logs_directory();
		$locks   = Config::get_locks_directory();
		$offsets = Config::get_offsets_directory();
		$this->assertSame( $this->temp_dir . '/base2/logs', $logs );
		$this->assertSame( $this->temp_dir . '/base2/locks', $locks );
		$this->assertSame( $this->temp_dir . '/base2/offsets', $offsets );
		$this->assertDirectoryExists( $logs );
		$this->assertDirectoryExists( $locks );
		$this->assertDirectoryExists( $offsets );
	}

	public function test_directories_are_cached(): void {
		\update_option( 'newspack_nodes_base_directory', $this->temp_dir . '/base3' );
		Config::reset();
		$logs1 = Config::get_logs_directory();
		$logs2 = Config::get_logs_directory();
		$this->assertSame( $logs1, $logs2 );
	}

	public function test_ensure_path_creates_nested(): void {
		$path   = $this->temp_dir . '/sub/deep/dir';
		$result = Config::ensure_path( $path );
		$this->assertDirectoryExists( $path );
		$this->assertSame( $path, $result );
	}

	public function test_ensure_path_strips_trailing_slash(): void {
		$path = $this->temp_dir . '/trailing';
		@\mkdir( $path, 0755, true );
		$result = Config::ensure_path( $path . '/' );
		$this->assertSame( $path, $result );
	}

	public function test_ensure_path_rejects_null_byte(): void {
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'null byte' );
		Config::ensure_path( "/tmp/evil\0path" );
	}

	/**
	 * The runtime tree is adopted, not just created: ensure_path() skipped mkdir
	 * for a pre-existing directory and never looked at who owned it. Anyone who
	 * won the race to `mkdir -m 0777 /tmp/newspack-nodes` owned every log, lock,
	 * offset and topology under it. `wp nodes doctor` already computed this
	 * comparison advisorily; it is a runtime gate now.
	 */
	public function test_ensure_path_refuses_a_directory_owned_by_another_uid(): void {
		$path = $this->temp_dir . '/foreign';
		@\mkdir( $path, 0700, true );
		// A uid that is not this directory's owner, whoever the runner is.
		CLI::$uid_provider = static fn (): int => ( (int) \fileowner( $path ) ) + 1;

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'owned by uid' );
		Config::ensure_path( $path );
	}

	/**
	 * Root is not the threat the ownership gate exists for — an adopter racing
	 * a predictable path is, and root already owns the box. What root DOES risk
	 * is writing root-owned files the workers (a lower uid) then cannot write,
	 * so it warns and proceeds rather than refusing to boot.
	 */
	public function test_ensure_path_lets_root_adopt_a_foreign_directory_with_a_warning(): void {
		$path = $this->temp_dir . '/roots-visit';
		@\mkdir( $path, 0700, true );
		@\chown( $path, \fileowner( $this->temp_dir ) );
		CLI::$uid_provider = static fn (): int => 0;

		$lines = [];
		Core::set_stderr_handler( static function ( string $line ) use ( &$lines ): void {
			$lines[] = $line;
		} );

		$this->assertSame( $path, Config::ensure_path( $path ) );
		$this->assertNotEmpty(
			\array_filter( $lines, static fn ( $l ) => \str_contains( $l, 'running as root' ) ),
			'root gets a warning, not a fatal'
		);
	}

	/** A non-root mismatch still refuses: that is the adoption attack. */
	public function test_ensure_path_still_refuses_a_foreign_directory_for_a_non_root_uid(): void {
		$path = $this->temp_dir . '/foreign-nonroot';
		@\mkdir( $path, 0700, true );
		CLI::$uid_provider = static fn (): int => ( (int) \fileowner( $path ) ) + 1;

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'owned by uid' );
		Config::ensure_path( $path );
	}

	/** Root creating a FRESH tree is the same hazard, and warns the same way. */
	public function test_ensure_path_warns_when_root_creates_the_runtime_directory(): void {
		$path = $this->temp_dir . '/root-made';
		CLI::$uid_provider = static fn (): int => 0;

		$lines = [];
		Core::set_stderr_handler( static function ( string $line ) use ( &$lines ): void {
			$lines[] = $line;
		} );

		Config::ensure_path( $path );
		$this->assertNotEmpty(
			\array_filter( $lines, static fn ( $l ) => \str_contains( $l, 'running as root' ) )
		);
	}

	/**
	 * Root may read and administer, but must never CREATE a file here: the
	 * workers run as the web user and cannot write what root owns. Denial is
	 * non-fatal — the caller skips the write and carries on.
	 */
	public function test_write_denied_is_true_for_root_and_warns_once(): void {
		CLI::$uid_provider = static fn (): int => 0;
		$lines             = [];
		Core::set_stderr_handler( static function ( string $line ) use ( &$lines ): void {
			$lines[] = $line;
		} );

		$this->assertTrue( Config::write_denied( 'restart flag' ) );
		$this->assertTrue( Config::write_denied( 'restart flag' ) );

		$hits = \array_filter( $lines, static fn ( $l ) => \str_contains( $l, 'running as root' ) );
		$this->assertCount( 1, $hits, 'rate-limited: one line, not one per write' );
	}

	public function test_write_denied_is_false_for_any_non_root_uid(): void {
		CLI::$uid_provider = static fn (): int => 1000;
		$this->assertFalse( Config::write_denied( 'anything' ) );
	}

	/** No posix means no uid to judge; do not block writes on a guess. */
	public function test_write_denied_is_false_without_a_uid(): void {
		CLI::$uid_provider = static fn (): int => -1;
		$this->assertFalse( Config::write_denied( 'anything' ) );
	}

	/** The root carve-out covers the uid mismatch ONLY; loose modes still refuse. */
	public function test_ensure_path_refuses_a_world_writable_directory_even_for_root(): void {
		$path = $this->temp_dir . '/root-loose';
		@\mkdir( $path, 0777, true );
		@\chmod( $path, 0777 );
		CLI::$uid_provider = static fn (): int => 0;

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'writable by group or other' );
		Config::ensure_path( $path );
	}

	public function test_ensure_path_refuses_a_group_or_world_writable_directory(): void {
		$path = $this->temp_dir . '/loose';
		@\mkdir( $path, 0777, true );
		@\chmod( $path, 0777 );
		CLI::$uid_provider = static fn (): int => (int) \fileowner( $path );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'writable by group or other' );
		Config::ensure_path( $path );
	}

	public function test_ensure_path_accepts_a_private_directory_we_own(): void {
		$path = $this->temp_dir . '/ours';
		@\mkdir( $path, 0700, true );
		CLI::$uid_provider = static fn (): int => (int) \fileowner( $path );

		$this->assertSame( $path, Config::ensure_path( $path ) );
	}

	/** No posix extension: nothing to compare, so the other checks still stand alone. */
	public function test_ensure_path_skips_the_ownership_gate_without_a_uid(): void {
		$path = $this->temp_dir . '/no-posix';
		@\mkdir( $path, 0700, true );
		CLI::$uid_provider = static fn (): int => -1;

		$this->assertSame( $path, Config::ensure_path( $path ) );
	}

	public function test_ensure_path_creates_private_directories(): void {
		$path = $this->temp_dir . '/fresh';

		Config::ensure_path( $path );

		$this->assertSame( '0700', \substr( \sprintf( '%o', \fileperms( $path ) ), -4 ) );
	}

	/**
	 * `/command` is full graph construction at manage_options, so on a stock
	 * install an arbitrary partition path crosses no boundary — the same actor
	 * already has the plugin editor. Where administrator file writes are
	 * deliberately disabled (DISALLOW_FILE_MODS, VIP-style installs) it restores
	 * an arbitrary write, which is the population this guards.
	 */
	public function test_assert_within_base_refuses_a_path_outside_the_tree(): void {
		$this->use_base_dir( $this->temp_dir );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'outside the runtime base directory' );
		Config::assert_within_base( '/var/www/html/wp-content/uploads/evil' );
	}

	public function test_assert_within_base_refuses_a_traversal_out(): void {
		$this->use_base_dir( $this->temp_dir );

		$this->expectException( \RuntimeException::class );
		Config::assert_within_base( $this->temp_dir . '/logs/../../escaped' );
	}

	public function test_assert_within_base_allows_a_path_inside_the_tree(): void {
		$this->use_base_dir( $this->temp_dir );

		Config::assert_within_base( $this->temp_dir . '/logs/firehose.p0' );
		$this->assertTrue( true, 'no throw is the assertion' );
	}

	/** Unconfigured, not an escape — the writer guards an empty dir already. */
	public function test_assert_within_base_allows_an_empty_path(): void {
		$this->use_base_dir( $this->temp_dir );

		Config::assert_within_base( '' );
		$this->assertTrue( true, 'no throw is the assertion' );
	}

	// ── validate_config_values ────────────────────────────────────────────

	public function test_validate_config_values_rejects_objects(): void {
		$ref = new \ReflectionMethod( Config_Utils::class, 'validate_config_values' );
		$this->assertFalse( $ref->invoke( null, new \stdClass() ) );
	}

	public function test_validate_config_values_rejects_deep_nesting(): void {
		$ref = new \ReflectionMethod( Config_Utils::class, 'validate_config_values' );
		$value = 'leaf';
		for ( $i = 0; $i < 12; $i++ ) {
			$value = [ $value ];
		}
		$this->assertFalse( $ref->invoke( null, $value ) );
	}

	public function test_validate_config_values_allows_scalars(): void {
		$ref = new \ReflectionMethod( Config_Utils::class, 'validate_config_values' );
		$this->assertTrue( $ref->invoke( null, 'string' ) );
		$this->assertTrue( $ref->invoke( null, 42 ) );
		$this->assertTrue( $ref->invoke( null, 3.14 ) );
		$this->assertTrue( $ref->invoke( null, true ) );
		$this->assertTrue( $ref->invoke( null, null ) );
	}

	public function test_validate_config_values_allows_arrays(): void {
		$ref = new \ReflectionMethod( Config_Utils::class, 'validate_config_values' );
		$this->assertTrue( $ref->invoke( null, [ 'a', 'b' ] ) );
		$this->assertTrue( $ref->invoke( null, [ 'nested' => [ 'k' => 'v' ] ] ) );
	}

	// ── ensure_path: symlink rejection ─────────────────────────────────────

	public function test_ensure_path_rejects_symlinks_outside_canonical(): void {
		// Create a real target dir + a symlink pointing at it. ensure_path must
		// reject the symlink because realpath() != input path.
		$real_dir = "{$this->temp_dir}/real";
		\mkdir( $real_dir, 0755, true );
		$link = "{$this->temp_dir}/link";
		// Skip on systems where symlink isn't available (e.g., restricted CI).
		if ( ! @\symlink( $real_dir, $link ) ) {
			$this->markTestSkipped( 'symlink() unavailable in this environment' );
		}

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/symlink or path traversal detected/' );
		Config::ensure_path( $link );
	}

	public function test_ensure_path_accepts_a_symlinked_ancestor(): void {
		// macOS's /tmp and /var are OS symlinks (/private/...): only the LEAF
		// being a symlink is the plantable attack; symlinked ancestors must
		// pass, with the canonical path returned.
		$target = "{$this->temp_dir}/target";
		\mkdir( $target, 0755, true );
		$link = "{$this->temp_dir}/oslink";
		if ( ! @\symlink( $target, $link ) ) {
			$this->markTestSkipped( 'symlink() unavailable in this environment' );
		}

		$validated = Config::ensure_path( "{$link}/base" );

		$this->assertSame( \realpath( $target ) . '/base', $validated, 'ancestor symlink resolves; the canonical path comes back' );
		$this->assertDirectoryExists( "{$target}/base" );
	}

	public function test_ensure_path_throws_when_path_unwritable_and_missing(): void {
		// /proc/sys is read-only on Linux; mkdir must fail there. realpath returns
		// false → throws RuntimeException.
		$this->expectException( \RuntimeException::class );
		Config::ensure_path( '/proc/sys/newspack-nodes-test-cant-create' );
	}

	// ── load_config_file rejects bogus return shape ────────────────────────

	public function test_explicit_local_env_override_returning_non_array_throws(): void {
		$bad_config = "{$this->temp_dir}/bad-config.php";
		\file_put_contents( $bad_config, "<?php return 'nodes-invalid-shape-8317';\n" );
		\putenv( "LOCAL_NEWSPACK_NODES_CONF={$bad_config}" );
		Config::reset();

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'config must return array of scalar/array values only' );

		Config::load_config_defaults();
	}

	public function test_explicit_local_env_override_with_object_throws(): void {
		$bad_config = "{$this->temp_dir}/object-config.php";
		\file_put_contents(
			$bad_config,
			"<?php return [ 'malicious' => new \\stdClass() ];\n"
		);
		\putenv( "LOCAL_NEWSPACK_NODES_CONF={$bad_config}" );
		Config::reset();

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'config must return array of scalar/array values only' );

		Config::load_config_defaults();
	}

	// ── get_base_directory throws when not configured ──────────────────────

	public function test_get_base_directory_throws_when_unconfigured(): void {
		// Force config to a state where base_directory is empty: point at a
		// per-test config file that explicitly sets it to empty string. WP
		// option also empty so neither overlay populates it.
		$conf = $this->temp_dir . '/empty-base.php';
		\file_put_contents( $conf, "<?php\nreturn [ 'base_directory' => '' ];\n" );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
		\update_option( 'newspack_nodes_base_directory', '' );
		Config::reset();

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/base_directory not configured/' );
		Config::get_base_directory();
	}

	// ── get_offsets_directory caches result ────────────────────────────────

	public function test_get_offsets_directory_caches_after_first_call(): void {
		\update_option( 'newspack_nodes_base_directory', $this->temp_dir . '/cached-offsets' );
		Config::reset();

		$first  = Config::get_offsets_directory();
		// Second call must return the same string from cache (no second mkdir).
		$second = Config::get_offsets_directory();
		$this->assertSame( $first, $second );
	}

}
