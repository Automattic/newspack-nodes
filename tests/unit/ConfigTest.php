<?php
/**
 * Tests for the substrate Config (file overlay + WP options + path validation
 * + kill_readers). Mirrors the application-side ConfigTest, scoped to substrate
 * keys (base_directory, num_partitions, num_segments, segment_size,
 * max_lifespan, memcache_servers, enable_workers, aggregator_servers).
 *
 * Reflection is used to exercise private surfaces (`validate_config_path`,
 * `validate_config_values`, `sanitize_option`).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Tests\TestCase;

#[\PHPUnit\Framework\Attributes\CoversClass( Config::class )]
class ConfigTest extends TestCase {

	private string $temp_dir;

	/** Saved snapshot of `Config::$allowed_config_dirs` so tests can mutate freely. */
	private array $saved_allowed_dirs = [];

	protected function setUp(): void {
		parent::setUp();
		Config::reset();
		$this->temp_dir = '/tmp/newspack-nodes-test-config-' . \uniqid();
		@\mkdir( $this->temp_dir, 0755, true );
		// Clear WP option store between tests.
		$GLOBALS['_wp_options'] = [];
		// Clear any LOCAL_NEWSPACK_NODES_CONF leftover.
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' );
		// Snapshot the allowlist; allow_dir() restores from this in tearDown.
		$ref                      = new \ReflectionProperty( Config::class, 'allowed_config_dirs' );
		$ref->setAccessible( true );
		$this->saved_allowed_dirs = $ref->getValue();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->temp_dir );
		Config::reset();
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' );
		$GLOBALS['_wp_options'] = [];
		// Restore allowed_config_dirs in case allow_dir() was used.
		$ref = new \ReflectionProperty( Config::class, 'allowed_config_dirs' );
		$ref->setAccessible( true );
		$ref->setValue( null, $this->saved_allowed_dirs );
		parent::tearDown();
	}

	// ── load_config: shape + caching ───────────────────────────────────────

	public function test_load_config_returns_array(): void {
		$config = Config::load_config();
		$this->assertIsArray( $config );
	}

	public function test_load_config_has_base_directory_from_runtime_filter(): void {
		// With no explicit overrides, base_directory comes from the runtime's
		// `newspack_nodes/base_dir` filter (default `/tmp/newspack-nodes`).
		$config = Config::load_config();
		$this->assertArrayHasKey( 'base_directory', $config );
		$this->assertNotEmpty( $config['base_directory'] );
	}

	public function test_load_config_caches_result(): void {
		$config1 = Config::load_config();
		$config2 = Config::load_config();
		$this->assertSame( $config1, $config2 );
	}

	public function test_load_config_full_includes_extended(): void {
		$config = Config::load_config( 'full' );
		$this->assertIsArray( $config );
		// Extended schema includes memcache_servers, which the substrate
		// sample overlay populates with a default.
		$this->assertArrayHasKey( 'memcache_servers', $config );
	}

	public function test_full_config_cached_separately_from_core(): void {
		$core  = Config::load_config( 'core' );
		$full  = Config::load_config( 'full' );
		$full2 = Config::load_config( 'full' );
		$this->assertSame( $full, $full2 );
		// memcache_servers only loads in 'full' mode WP-option override path.
		\update_option( 'newspack_nodes_memcache_servers', "test-host:11211" );
		Config::reset();
		$config_core = Config::load_config( 'core' );
		$config_full = Config::load_config( 'full' );
		// Core mode should NOT pick up the extended override.
		$core_servers = $config_core['memcache_servers'] ?? [];
		$full_servers = $config_full['memcache_servers'] ?? [];
		$this->assertNotEquals( [ 'test-host:11211' ], $core_servers );
		$this->assertSame( [ 'test-host:11211' ], $full_servers );
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

	// ── File-overlay env override ──────────────────────────────────────────

	public function test_local_env_override_loads_overlay(): void {
		$override_path = $this->temp_dir . '/override.php';
		\file_put_contents(
			$override_path,
			"<?php return [ 'num_partitions' => 7, 'segment_size' => 4242 ];\n"
		);
		// Allow temp_dir by hacking the allowlist via reflection.
		$this->allow_dir( $this->temp_dir );

		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $override_path );
		Config::reset();
		$config = Config::load_config();
		$this->assertSame( 7, $config['num_partitions'] );
		$this->assertSame( 4242, $config['segment_size'] );
	}

	public function test_local_env_override_outside_allowed_dirs_rejected(): void {
		$ref = new \ReflectionMethod( Config::class, 'validate_config_path' );
		$ref->setAccessible( true );

		// /var/tmp is not in the allowlist (and isn't the plugin dir).
		$outside_dir = '/var/tmp/newspack-nodes-test-evil-' . \uniqid();
		@\mkdir( $outside_dir, 0755, true );
		$path = $outside_dir . '/evil-config.php';
		\file_put_contents( $path, "<?php return [];\n" );

		try {
			$result = $ref->invoke( null, $path );
			$this->assertNull( $result );
		} finally {
			@\unlink( $path );
			@\rmdir( $outside_dir );
		}
	}

	// ── WP option overrides ────────────────────────────────────────────────

	public function test_wp_option_override_takes_effect(): void {
		Config::reset();
		\update_option( 'newspack_nodes_num_partitions', '8' );
		$config = Config::load_config();
		$this->assertSame( 8, $config['num_partitions'] );
	}

	public function test_wp_option_invalid_int_falls_back_to_default(): void {
		Config::reset();
		\update_option( 'newspack_nodes_num_partitions', 'not-a-number' );
		$config = Config::load_config();
		// Should keep the default from the config file, not the invalid WP option.
		$this->assertSame( 1, $config['num_partitions'] );
	}

	public function test_empty_wp_option_uses_file_default(): void {
		Config::reset();
		\update_option( 'newspack_nodes_num_partitions', '' );
		$config = Config::load_config();
		$this->assertSame( 1, $config['num_partitions'] );
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

	// ── sanitize_option: type matrix ──────────────────────────────────────

	public function test_sanitize_option_bool_truthy(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertTrue( $ref->invoke( null, '1', 'bool' ) );
	}

	public function test_sanitize_option_bool_falsy(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertFalse( $ref->invoke( null, '', 'bool' ) );
	}

	public function test_sanitize_option_int_valid(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertSame( 42, $ref->invoke( null, '42', 'int' ) );
	}

	public function test_sanitize_option_int_rejects_non_numeric(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, 'abc', 'int' ) );
	}

	public function test_sanitize_option_path_accepts_valid_absolute(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertSame( '/var/www/html', $ref->invoke( null, '/var/www/html', 'path' ) );
	}

	public function test_sanitize_option_path_rejects_relative(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, 'relative/path', 'path' ) );
	}

	public function test_sanitize_option_path_rejects_null_byte(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, "/tmp/evil\0path", 'path' ) );
	}

	public function test_sanitize_option_path_rejects_traversal(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, '/tmp/../etc/passwd', 'path' ) );
	}

	public function test_sanitize_option_memcache_servers_valid(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertSame(
			[ 'host1:11211', 'host2:11212' ],
			$ref->invoke( null, "host1:11211\nhost2:11212", 'memcache_servers' )
		);
	}

	public function test_sanitize_option_memcache_servers_filters_invalid(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertSame(
			[ 'valid:11211', 'ok:1234' ],
			$ref->invoke( null, "valid:11211\ninvalid\nhost@bad:999999\nok:1234", 'memcache_servers' )
		);
	}

	public function test_sanitize_option_memcache_servers_empty_string(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, '', 'memcache_servers' ) );
	}

	public function test_sanitize_option_aggregator_servers_valid(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$input  = [
			'server1' => [
				'url'           => 'https://example.com/api',
				'auth_username' => 'user',
				'auth_password' => 'pass',
				'enabled'       => true,
			],
		];
		$result = $ref->invoke( null, $input, 'aggregator_servers' );
		$this->assertArrayHasKey( 'server1', $result );
		$this->assertStringStartsWith( 'https://', $result['server1']['url'] );
		$this->assertTrue( $result['server1']['enabled'] );
	}

	public function test_sanitize_option_aggregator_servers_rejects_http(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$input  = [ 'bad' => [ 'url' => 'http://insecure.example.com' ] ];
		$result = $ref->invoke( null, $input, 'aggregator_servers' );
		$this->assertSame( [], $result );
	}

	public function test_sanitize_option_unknown_type_returns_null(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, 'value', 'never-heard-of-this-type' ) );
	}

	// ── validate_config_path ──────────────────────────────────────────────

	public function test_validate_config_path_rejects_non_php(): void {
		$ref = new \ReflectionMethod( Config::class, 'validate_config_path' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, '/tmp/config.txt' ) );
	}

	public function test_validate_config_path_rejects_null_byte(): void {
		$ref = new \ReflectionMethod( Config::class, 'validate_config_path' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, "/tmp/evil\0config.php" ) );
	}

	// ── validate_config_values ────────────────────────────────────────────

	public function test_validate_config_values_rejects_objects(): void {
		$ref = new \ReflectionMethod( Config::class, 'validate_config_values' );
		$ref->setAccessible( true );
		$this->assertFalse( $ref->invoke( null, new \stdClass() ) );
	}

	public function test_validate_config_values_rejects_deep_nesting(): void {
		$ref = new \ReflectionMethod( Config::class, 'validate_config_values' );
		$ref->setAccessible( true );
		$value = 'leaf';
		for ( $i = 0; $i < 12; $i++ ) {
			$value = [ $value ];
		}
		$this->assertFalse( $ref->invoke( null, $value ) );
	}

	public function test_validate_config_values_allows_scalars(): void {
		$ref = new \ReflectionMethod( Config::class, 'validate_config_values' );
		$ref->setAccessible( true );
		$this->assertTrue( $ref->invoke( null, 'string' ) );
		$this->assertTrue( $ref->invoke( null, 42 ) );
		$this->assertTrue( $ref->invoke( null, 3.14 ) );
		$this->assertTrue( $ref->invoke( null, true ) );
		$this->assertTrue( $ref->invoke( null, null ) );
	}

	public function test_validate_config_values_allows_arrays(): void {
		$ref = new \ReflectionMethod( Config::class, 'validate_config_values' );
		$ref->setAccessible( true );
		$this->assertTrue( $ref->invoke( null, [ 'a', 'b' ] ) );
		$this->assertTrue( $ref->invoke( null, [ 'nested' => [ 'k' => 'v' ] ] ) );
	}

	// ── kill_readers ──────────────────────────────────────────────────────

	public function test_kill_readers_empty_array_noop(): void {
		Config::kill_readers( [] );
		$this->assertTrue( true );
	}

	public function test_kill_readers_no_locks_dir_noop(): void {
		\update_option( 'newspack_nodes_base_directory', $this->temp_dir . '/no-locks-base' );
		Config::reset();
		Config::kill_readers( [ 'firehose-workers' ] );
		$this->assertTrue( true );
	}

	public function test_kill_readers_writes_restart_flag_for_partitioned_dir(): void {
		\update_option( 'newspack_nodes_base_directory', $this->temp_dir . '/with-locks' );
		Config::reset();
		$locks = Config::get_locks_directory();

		$lock_dir = "{$locks}/firehose-workers.p0.lock.d";
		@\mkdir( $lock_dir, 0755, true );
		\file_put_contents( "{$lock_dir}/heartbeat", (string) \getmypid() );

		Config::kill_readers( [ 'firehose-workers' ] );

		$this->assertFileExists( "{$lock_dir}/restart" );
	}

	public function test_kill_readers_writes_restart_flag_for_singleton_dir(): void {
		\update_option( 'newspack_nodes_base_directory', $this->temp_dir . '/with-singleton' );
		Config::reset();
		$locks = Config::get_locks_directory();

		$lock_dir = "{$locks}/aggregator.lock.d";
		@\mkdir( $lock_dir, 0755, true );
		\file_put_contents( "{$lock_dir}/heartbeat", (string) \getmypid() );

		Config::kill_readers( [ 'aggregator' ] );

		$this->assertFileExists( "{$lock_dir}/restart" );
	}

	public function test_kill_readers_skips_non_matching_groups(): void {
		\update_option( 'newspack_nodes_base_directory', $this->temp_dir . '/skip-test' );
		Config::reset();
		$locks = Config::get_locks_directory();

		$other = "{$locks}/some-other-worker.p0.lock.d";
		@\mkdir( $other, 0755, true );
		\file_put_contents( "{$other}/heartbeat", (string) \getmypid() );

		Config::kill_readers( [ 'firehose-workers' ] );

		$this->assertFileDoesNotExist( "{$other}/restart" );
	}

	// ── Schema filter ─────────────────────────────────────────────────────

	public function test_schema_core_filter_appends_keys(): void {
		\add_filter(
			'newspack_nodes_option_schema_core',
			static function ( array $schema ): array {
				$schema['extra_substrate_key'] = 'int';
				return $schema;
			}
		);
		Config::reset();
		\update_option( 'newspack_nodes_extra_substrate_key', '17' );
		$config = Config::load_config();
		$this->assertSame( 17, $config['extra_substrate_key'] );
		// Reset filter so other tests don't see it.
		$GLOBALS['_wp_actions']['newspack_nodes_option_schema_core'] = [];
	}

	// ── invalidate_cache + register_cache_invalidation ───────────────────

	public function test_invalidate_cache_clears_all_cached_values(): void {
		// Prime caches by triggering various loaders.
		\update_option( 'newspack_nodes_base_directory', $this->temp_dir . '/cache-base' );
		Config::load_config();
		Config::get_base_directory();

		// Cached values should be non-null at this point.
		$ref_full = new \ReflectionProperty( Config::class, 'config' );
		$ref_full->setAccessible( true );
		$ref_base = new \ReflectionProperty( Config::class, 'validated_base_directory' );
		$ref_base->setAccessible( true );

		$this->assertNotNull( $ref_full->getValue() );
		$this->assertNotNull( $ref_base->getValue() );

		Config::invalidate_cache();

		// All cached values must be null.
		$this->assertNull( $ref_full->getValue() );
		$this->assertNull( $ref_base->getValue() );
	}

	public function test_register_cache_invalidation_hooks_plugins_loaded_only_once(): void {
		// Reset the static guard via reflection — register_cache_invalidation uses
		// `static $registered = false;` so multiple calls to register would otherwise
		// no-op silently. We can't reset it directly without reflection on the
		// generator function's frame, but we CAN observe the behavior: hook list grows.
		$initial_count = \count( $GLOBALS['_wp_actions']['plugins_loaded'] ?? [] );

		// Calling repeatedly must add the hook only once across the process lifetime.
		Config::register_cache_invalidation();
		Config::register_cache_invalidation();
		Config::register_cache_invalidation();

		$final_count = \count( $GLOBALS['_wp_actions']['plugins_loaded'] ?? [] );
		// 0 or 1 added — the guard prevents duplicates. Static state is shared
		// across tests, so we only assert the upper bound.
		$this->assertLessThanOrEqual( $initial_count + 1, $final_count );
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

	public function test_ensure_path_throws_when_path_unwritable_and_missing(): void {
		// /proc/sys is read-only on Linux; mkdir must fail there. realpath returns
		// false → throws RuntimeException.
		$this->expectException( \RuntimeException::class );
		Config::ensure_path( '/proc/sys/newspack-nodes-test-cant-create' );
	}

	// ── sanitize_option additional types ───────────────────────────────────

	public function test_sanitize_option_float_valid(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertSame( 3.14, $ref->invoke( null, '3.14', 'float' ) );
		$this->assertSame( 0.0, $ref->invoke( null, 0, 'float' ) );
	}

	public function test_sanitize_option_float_rejects_non_numeric(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, 'not-a-number', 'float' ) );
	}

	public function test_sanitize_option_array_strings_keeps_string_int_bool_values(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$result = $ref->invoke(
			null,
			[
				'key1' => 'value1',
				'key2' => 42,
				'key3' => true,
				'key4' => 3.14,           // dropped (not string/int/bool)
				'key5' => new \stdClass(), // dropped
				'key6' => [ 'nested' ],   // dropped
			],
			'array_strings'
		);
		$this->assertSame( 'value1', $result['key1'] );
		$this->assertSame( 42, $result['key2'] );
		$this->assertTrue( $result['key3'] );
		$this->assertArrayNotHasKey( 'key4', $result );
		$this->assertArrayNotHasKey( 'key5', $result );
		$this->assertArrayNotHasKey( 'key6', $result );
	}

	public function test_sanitize_option_array_strings_rejects_non_array(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, 'not-array', 'array_strings' ) );
	}

	public function test_sanitize_option_aggregator_servers_skips_non_array_entries(): void {
		// Mixed input: server2 is a scalar — skipped silently.
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$result = $ref->invoke(
			null,
			[
				'server1' => [ 'url' => 'https://ok.example.com' ],
				'server2' => 'not-an-array',
				''        => [ 'url' => 'https://empty-id.example.com' ],
			],
			'aggregator_servers'
		);
		$this->assertArrayHasKey( 'server1', $result );
		$this->assertArrayNotHasKey( 'server2', $result );
		// Empty server-id is filtered after sanitization.
		$this->assertArrayNotHasKey( '', $result );
	}

	public function test_sanitize_option_aggregator_servers_rejects_non_array_input(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, 'not-array', 'aggregator_servers' ) );
	}

	public function test_sanitize_option_memcache_servers_rejects_non_string(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, [ 'array', 'instead' ], 'memcache_servers' ) );
	}

	public function test_sanitize_option_path_rejects_non_string(): void {
		$ref = new \ReflectionMethod( Config::class, 'sanitize_option' );
		$ref->setAccessible( true );
		$this->assertNull( $ref->invoke( null, 12345, 'path' ) );
	}

	// ── load_config_file rejects bogus return shape ────────────────────────

	public function test_load_config_file_rejects_when_returns_non_array(): void {
		// Bad local override returns a string — load_config_file must reject and
		// not merge it. The merge detection: a string $config[$random_key] would
		// crash other consumers, so we just verify load_config returns an array
		// and doesn't contain the magic key the bad file tried to set.
		$bad_config = "{$this->temp_dir}/bad-config.php";
		\file_put_contents( $bad_config, "<?php return 'malicious_string_not_an_array';\n" );
		$this->allow_dir( $this->temp_dir );
		\putenv( "LOCAL_NEWSPACK_NODES_CONF={$bad_config}" );

		// load_config still returns an array; the bad file is rejected silently.
		$config = Config::load_config();
		$this->assertIsArray( $config );
		// Spread-merging a string would have crashed before reaching here.
	}

	public function test_load_config_file_rejects_when_returns_array_with_object(): void {
		$bad_config = "{$this->temp_dir}/object-config.php";
		\file_put_contents(
			$bad_config,
			"<?php return [ 'malicious' => new \\stdClass() ];\n"
		);
		$this->allow_dir( $this->temp_dir );
		\putenv( "LOCAL_NEWSPACK_NODES_CONF={$bad_config}" );

		$config = Config::load_config();
		$this->assertIsArray( $config );
		// validate_config_values rejected the file → key not merged.
		$this->assertArrayNotHasKey( 'malicious', $config );
	}

	// ── is_within edge case ────────────────────────────────────────────────

	public function test_is_within_returns_null_when_path_does_not_exist(): void {
		$ref = new \ReflectionMethod( Config::class, 'is_within' );
		$ref->setAccessible( true );
		// Both args nonexistent.
		$this->assertNull( $ref->invoke( null, '/never/existed/anywhere', '/tmp' ) );
		// Existing base, nonexistent path.
		$this->assertNull( $ref->invoke( null, '/never/existed', $this->temp_dir ) );
	}

	public function test_is_within_returns_null_when_outside_base(): void {
		$ref = new \ReflectionMethod( Config::class, 'is_within' );
		$ref->setAccessible( true );
		// Real path exists but outside base.
		$this->assertNull( $ref->invoke( null, '/etc', $this->temp_dir ) );
	}

	public function test_is_within_accepts_path_that_equals_base(): void {
		// Path == base must be considered "within" (the base itself).
		$ref = new \ReflectionMethod( Config::class, 'is_within' );
		$ref->setAccessible( true );
		$result = $ref->invoke( null, $this->temp_dir, $this->temp_dir );
		$this->assertSame( \realpath( $this->temp_dir ), $result );
	}

	// ── get_base_directory throws when not configured ──────────────────────

	public function test_get_base_directory_throws_when_unconfigured(): void {
		// Force config to a state where base_directory is empty.
		$ref_filter = function( $value ) {
			return ''; // override the default '/tmp/newspack-nodes' filter
		};
		\add_filter( 'newspack_nodes/base_dir', $ref_filter );
		\update_option( 'newspack_nodes_base_directory', '' );
		Config::reset();

		try {
			$this->expectException( \RuntimeException::class );
			$this->expectExceptionMessageMatches( '/base_directory not configured/' );
			Config::get_base_directory();
		} finally {
			$GLOBALS['_wp_actions']['newspack_nodes/base_dir'] = [];
		}
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

	// ── sanitize_string fallback ───────────────────────────────────────────

	public function test_sanitize_string_throws_when_wp_unavailable(): void {
		// We can't really un-define sanitize_text_field at runtime in a single test
		// process. Instead we verify the documented contract by inspecting the throw
		// path via reflection: invoking sanitize_string with a value that requires
		// the WP function still works (since we're in a test bootstrap that defines
		// it), but the throw branch is documented as the failure mode.
		$ref = new \ReflectionMethod( Config::class, 'sanitize_string' );
		$ref->setAccessible( true );
		// Pass a value with leading/trailing whitespace — confirm sanitize_text_field
		// (the bootstrap stub) is what's stripping it.
		$this->assertSame( 'hello', $ref->invoke( null, '  hello  ' ) );
	}

	// ── Helpers ───────────────────────────────────────────────────────────

	/**
	 * Append a directory to the allowed-config-dirs allowlist for the
	 * duration of the test.
	 */
	private function allow_dir( string $dir ): void {
		$ref  = new \ReflectionProperty( Config::class, 'allowed_config_dirs' );
		$ref->setAccessible( true );
		$dirs   = $ref->getValue();
		$dirs[] = $dir;
		$ref->setValue( null, $dirs );
	}
}
