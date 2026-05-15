<?php
/**
 * Smoke tests for `wp nodes types`, `wp nodes restart`, `wp nodes status`, and
 * `wp nodes run` — covering registration shape, capability/nonce surface, and
 * happy-path behaviour. Tests do NOT spawn real workers (run command is gated
 * out by missing topology files in the temp dir).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Cli;
use Newspack_Nodes\Lock;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\WorkerCliCommand;
use PHPUnit\Framework\Attributes\CoversClass;

require_once \dirname( __DIR__, 2 ) . '/includes/cli/class-worker-cli-command.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( WorkerCliCommand::class )]
class CliWorkerCommandTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		// /tmp/... directly so realpath() matches input on hosts where
		// sys_get_temp_dir() resolves through a symlink (macOS /tmp → /private/tmp).
		$staging = '/tmp/newspack-nodes-worker-cli-test-' . \uniqid();
		\mkdir( $staging, 0755, true );
		$this->tmp = \realpath( $staging ) ?: $staging;

		$GLOBALS['_wp_actions']                = [];
		$GLOBALS['_test_outbound_posts']      = [];
		$GLOBALS['_test_wp_cli_logs']          = [];
		$GLOBALS['_test_wp_cli_warns']         = [];
		$GLOBALS['_test_wp_cli_errors']        = [];
		$GLOBALS['_test_wp_cli_success']       = [];

		$this->use_base_dir( $this->tmp );
		Topology_Registry::reset();
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function register_topology( string $type, int $num_partitions, ?string $topology_path = null ): void {
		\add_filter(
			'newspack_nodes/topologies',
			function ( array $topologies ) use ( $type, $num_partitions, $topology_path ): array {
				$topologies[ $type ] = [
					'topology'       => $topology_path ?? '/nonexistent/path.php',
					'num_partitions' => $num_partitions,
					'stale_timeout'  => 60,
				];
				return $topologies;
			}
		);
	}

	// -------------------------------------------------------------------------
	// types
	// -------------------------------------------------------------------------

	public function test_types_warns_when_no_topologies(): void {
		( new WorkerCliCommand() )->types( [], [] );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_warns'] );
		$this->assertStringContainsString( 'No active topologies', $GLOBALS['_test_wp_cli_warns'][0] );
	}

	public function test_types_lists_registered_groups(): void {
		$this->register_topology( 'firehose-workers', 4 );
		$this->register_topology( 'aggregator', 1 );

		( new WorkerCliCommand() )->types( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'firehose-workers', $haystack );
		$this->assertStringContainsString( '4 partitions', $haystack );
		$this->assertStringContainsString( 'aggregator', $haystack );
		$this->assertStringContainsString( '1 partition', $haystack );
	}

	// -------------------------------------------------------------------------
	// restart
	// -------------------------------------------------------------------------

	public function test_restart_requires_type_arg(): void {
		$this->expectException( \RuntimeException::class );
		( new WorkerCliCommand() )->restart( [], [] );
	}

	public function test_restart_rejects_invalid_type(): void {
		$this->register_topology( 'firehose-workers', 2 );
		$this->expectException( \RuntimeException::class );
		( new WorkerCliCommand() )->restart( [ 'no-such-type' ], [ 'partition' => 0 ] );
	}

	public function test_restart_requires_partition_or_all_partitions(): void {
		$this->register_topology( 'firehose-workers', 2 );
		$this->expectException( \RuntimeException::class );
		// No --partition, no --all-partitions => error.
		( new WorkerCliCommand() )->restart( [ 'firehose-workers' ], [] );
	}

	public function test_restart_writes_flag_for_specific_partition(): void {
		$this->register_topology( 'firehose-workers', 2 );

		$lock_dir_p0 = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		$lock_dir_p1 = "{$this->tmp}/locks/firehose-workers.p1.lock.d";
		\mkdir( $lock_dir_p0, 0755, true );
		\mkdir( $lock_dir_p1, 0755, true );

		( new WorkerCliCommand() )->restart(
			[ 'firehose-workers' ],
			[ 'partition' => 1 ]
		);

		$this->assertTrue( Lock::is_restart_pending( $lock_dir_p1 ), 'p1 flag should be written' );
		$this->assertFalse( Lock::is_restart_pending( $lock_dir_p0 ), 'p0 flag should not be written' );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
	}

	public function test_restart_all_partitions_writes_every_lock(): void {
		$this->register_topology( 'firehose-workers', 3 );
		for ( $p = 0; $p < 3; $p++ ) {
			\mkdir( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d", 0755, true );
		}

		( new WorkerCliCommand() )->restart(
			[ 'firehose-workers' ],
			[ 'all-partitions' => true ]
		);

		for ( $p = 0; $p < 3; $p++ ) {
			$lock_dir = "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d";
			$this->assertTrue( Lock::is_restart_pending( $lock_dir ), "p{$p} flag should be set" );
		}
	}

	public function test_restart_all_wildcard_matches_every_type(): void {
		$this->register_topology( 'firehose-workers', 1 );
		$this->register_topology( 'aggregator', 1 );
		\mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		\mkdir( "{$this->tmp}/locks/aggregator.p0.lock.d", 0755, true );

		( new WorkerCliCommand() )->restart( [ 'all' ], [ 'all-partitions' => true ] );

		$this->assertTrue( Lock::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p0.lock.d" ) );
		$this->assertTrue( Lock::is_restart_pending( "{$this->tmp}/locks/aggregator.p0.lock.d" ) );
	}

	// -------------------------------------------------------------------------
	// status
	// -------------------------------------------------------------------------

	public function test_status_warns_when_no_workers_registered(): void {
		( new WorkerCliCommand() )->status( [], [] );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_warns'] );
	}

	public function test_status_renders_rows_for_each_partition(): void {
		$this->register_topology( 'firehose-workers', 2 );

		// Simulate one running, one dead.
		$lock_p0 = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		\mkdir( $lock_p0, 0755, true );
		\file_put_contents( "{$lock_p0}/heartbeat", (string) \getmypid() );
		\file_put_contents( "{$lock_p0}/started", (string) ( \time() - 30 ) );
		// p1 has no lock dir at all => 'dead' with '-' uptime.

		( new WorkerCliCommand() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'firehose-workers', $haystack );
		$this->assertStringContainsString( 'running', $haystack );
		$this->assertStringContainsString( 'dead', $haystack );
	}

	public function test_status_shows_restart_pending(): void {
		$this->register_topology( 'aggregator', 1 );
		$lock = "{$this->tmp}/locks/aggregator.p0.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", (string) \getmypid() );
		Lock::request_restart_at( $lock );

		( new WorkerCliCommand() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'restart=yes', $haystack );
	}

	// -------------------------------------------------------------------------
	// run
	// -------------------------------------------------------------------------

	public function test_run_requires_type(): void {
		$this->expectException( \RuntimeException::class );
		( new WorkerCliCommand() )->run( [], [] );
	}

	public function test_run_rejects_unknown_type(): void {
		$this->register_topology( 'firehose-workers', 1 );
		$this->expectException( \RuntimeException::class );
		( new WorkerCliCommand() )->run( [ 'unknown' ], [] );
	}

	public function test_run_errors_on_missing_topology_file(): void {
		// Topology registered but the path doesn't exist.
		$this->register_topology( 'firehose-workers', 1, '/nonexistent/topology.php' );
		$this->expectException( \RuntimeException::class );
		( new WorkerCliCommand() )->run( [ 'firehose-workers' ], [] );
	}

	public function test_run_errors_when_topology_name_not_in_registry(): void {
		// Descriptor names a topology no plugin has registered with
		// Topology_Registry — the registry returns null on resolve()
		// and WorkerCliCommand bails with a clear message.
		$this->register_topology( 'bogus-topology', 1, 'bogus-topology' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/Topology not found in registry/' );
		( new WorkerCliCommand() )->run( [ 'bogus-topology' ], [] );
	}

	// Integration coverage of "WorkerCliCommand runs a TSL topology to
	// completion" sat here pre-A3 but no longer fits cleanly:
	//
	//  - The old shape returned a PHP closure that could set the
	//    restart flag inline; TSL loads can't.
	//  - Pre-arming the marker before run() doesn't work — Lock's
	//    orphan-grace + force_release_at delete the dir contents
	//    (including the marker) before the worker acquires.
	//
	// The narrower pieces are covered separately:
	//  - Topology_Loader::load — TopologyLoaderTest
	//  - Topology_Registry::resolve — TopologyRegistryTest
	//  - WorkerBase::execute / should_continue — WorkerBaseTest
	//
	// WorkerCliCommand's responsibility is descriptor lookup +
	// closure construction, both covered by the not-found-in-registry
	// test above.

	// -------------------------------------------------------------------------
	// restart_fleet_by_name (static action handler)
	// -------------------------------------------------------------------------

	public function test_restart_fleet_by_name_writes_restart_flag_for_every_partition(): void {
		// Action handler wired to `newspack_nodes/restart_fleet`. Operator
		// triggers via REST → WorkerCliCommand::restart_fleet_by_name fires.
		$this->register_topology( 'firehose-workers', 3 );
		for ( $p = 0; $p < 3; $p++ ) {
			\mkdir( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d", 0755, true );
		}

		WorkerCliCommand::restart_fleet_by_name( 'firehose-workers' );

		for ( $p = 0; $p < 3; $p++ ) {
			$this->assertTrue(
				Lock::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d" ),
				"partition p{$p} must have restart flag written"
			);
		}
	}

	public function test_restart_fleet_by_name_noop_for_unknown_fleet(): void {
		// "Best-effort: unknown name or no live workers → no-op."
		// No matching workers in expand_workers → array_filter strips all
		// entries → no work to do. Must not throw, must not touch disk.
		\mkdir( "{$this->tmp}/locks", 0755, true );

		WorkerCliCommand::restart_fleet_by_name( 'never-registered' );

		// No restart flag files were written.
		$entries = \scandir( "{$this->tmp}/locks" );
		$entries = false === $entries ? [] : \array_values( \array_diff( $entries, [ '.', '..' ] ) );
		$this->assertSame( [], $entries, 'no lock dirs should be created for unknown fleets' );
	}

	public function test_restart_fleet_by_name_filters_to_named_fleet_only(): void {
		// Other fleets must not be touched — the action handler is named:
		// restart only the fleet keyed by $name.
		$this->register_topology( 'firehose-workers', 1 );
		$this->register_topology( 'aggregator', 1 );
		\mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		\mkdir( "{$this->tmp}/locks/aggregator.p0.lock.d", 0755, true );

		WorkerCliCommand::restart_fleet_by_name( 'firehose-workers' );

		$this->assertTrue( Lock::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p0.lock.d" ) );
		$this->assertFalse(
			Lock::is_restart_pending( "{$this->tmp}/locks/aggregator.p0.lock.d" ),
			'aggregator must not be restarted when the named fleet is firehose-workers'
		);
	}

	// -------------------------------------------------------------------------
	// run command (error paths only — full run() requires a live worker)
	// -------------------------------------------------------------------------

	public function test_run_errors_on_unknown_partition_for_known_type(): void {
		// Known type + nonexistent partition → "No worker registered for
		// {type} partition {N}" error. Distinct from unknown-type which is
		// caught earlier by the in_array check.
		$this->register_topology( 'firehose-workers', 1 );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/No worker registered for firehose-workers partition 5/' );
		( new WorkerCliCommand() )->run(
			[ 'firehose-workers' ],
			[ 'partition' => 5 ]
		);
	}

	// -------------------------------------------------------------------------
	// types command — partition pluralization branches
	// -------------------------------------------------------------------------

	public function test_types_renders_singular_partition_form(): void {
		// 1 partition → "1 partition" (singular); multi-partition path already
		// covered by test_types_lists_registered_groups.
		$this->register_topology( 'aggregator', 1 );

		( new WorkerCliCommand() )->types( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( '1 partition', $haystack );
		// Make sure the plural form did NOT also leak in.
		$this->assertStringNotContainsString( '1 partitions', $haystack );
	}

	public function test_types_includes_topology_path_when_provided(): void {
		// Each entry's `topology` field is logged on a separate "topology:"
		// line when set; verifies the secondary log statement.
		$this->register_topology( 'firehose-workers', 2, '/some/explicit/path.tsl' );

		( new WorkerCliCommand() )->types( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( '/some/explicit/path.tsl', $haystack );
	}

	// -------------------------------------------------------------------------
	// status command — saved_position + Behind + cache filter branches
	// -------------------------------------------------------------------------

	public function test_status_renders_uptime_when_started_file_present(): void {
		// `Uptime` reads Lock::get_started_time(); produce a real `started`
		// file via the substrate convention so the format_duration path runs.
		$this->register_topology( 'firehose-workers', 1 );
		$lock = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", (string) \getmypid() );
		\file_put_contents( "{$lock}/started", (string) ( \time() - 120 ) );

		( new WorkerCliCommand() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		// 120 seconds → format_duration emits "2m" or similar minute-grain.
		// Allow some clock slop in case the test machine is busy.
		$this->assertMatchesRegularExpression( '/\d+(m|s)/', $haystack );
	}

	public function test_status_renders_behind_when_partition_dir_present(): void {
		// `Behind` reads partition file sizes via saved_position fallback.
		// Without an offsetlog/cache, the column stays '-'; drop a
		// saved-position file so the Behind column gets populated.
		$this->register_topology( 'firehose-workers', 1 );
		$lock = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", (string) \getmypid() );

		// Substrate convention: offsetlog under offsets/{type}.p{partition}/p0/.
		$offset_dir = "{$this->tmp}/offsets/firehose-workers.p0/p0";
		\mkdir( $offset_dir, 0755, true );
		\file_put_contents(
			"{$offset_dir}/0.log",
			\json_encode( [ 'seg' => 0, 'off' => 100, 'ts' => \time() ] ) . "\n"
		);

		// And a firehose.log partition dir under logs/firehose.log/p0 with
		// content larger than the cursor offset so the "Behind" calculation
		// has something to report.
		$partition_dir = "{$this->tmp}/logs/firehose.log/p0";
		\mkdir( $partition_dir, 0755, true );
		// 300 bytes total → 200 bytes behind (300 - 100).
		\file_put_contents( "{$partition_dir}/0.log", \str_repeat( 'a', 300 ) );

		( new WorkerCliCommand() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		// 200B → format_bytes → "200B". At minimum verify the column
		// changed shape from '-' (no offsetlog path) to a byte literal.
		$this->assertStringContainsString( '200B', $haystack );
	}

	public function test_status_uses_filtered_cache_when_provided(): void {
		// Live-position memcache is hooked via newspack_nodes/worker_cli_cache.
		// Apps providing a Cache_Interface-compatible object see their cached
		// positions in the Behind column.
		$this->register_topology( 'firehose-workers', 1 );
		$lock = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", (string) \getmypid() );

		$partition_dir = "{$this->tmp}/logs/firehose.log/p0";
		\mkdir( $partition_dir, 0755, true );
		\file_put_contents( "{$partition_dir}/0.log", \str_repeat( 'b', 500 ) );

		$cache = new class {
			public array $hits = [];
			public function get( string $key ) {
				$this->hits[] = $key;
				return [ 'seg' => 0, 'off' => 50, 'ts' => \time() ];
			}
		};

		\add_filter( 'newspack_nodes/worker_cli_cache', function () use ( $cache ) {
			return $cache;
		} );

		( new WorkerCliCommand() )->status( [], [] );

		$this->assertNotEmpty( $cache->hits, 'cache must be consulted via live_position' );
		$this->assertStringContainsString( 'newspack_nodes:cursor:firehose-workers.p0', $cache->hits[0] );
	}

	public function test_status_ignores_filter_value_that_is_not_object(): void {
		// `cache()` returns null when the filter delivers a non-object;
		// status() then falls back to saved_position. Validates the
		// `is_object()` guard branch.
		$this->register_topology( 'firehose-workers', 1 );
		$lock = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", (string) \getmypid() );

		\add_filter( 'newspack_nodes/worker_cli_cache', function () {
			// Junk value — must be filtered out by the is_object check.
			return 'not-an-object';
		} );

		( new WorkerCliCommand() )->status( [], [] );

		// No exception, output produced.
		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'firehose-workers', $haystack );
	}

	public function test_status_exits_cleanly_with_fallback_renderer(): void {
		// `WP_CLI\Utils\format_items` is not stubbed in this test harness, so
		// status() emits via the printf-style fallback. Pin the contract so a
		// future regression removing the fallback fails this test.
		$this->register_topology( 'firehose-workers', 1 );
		$lock = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", (string) \getmypid() );

		( new WorkerCliCommand() )->status( [], [] );

		// Plain-text fallback emits one log line per row.
		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'firehose-workers', $haystack );
		$this->assertStringContainsString( 'p0', $haystack );
		$this->assertStringContainsString( 'restart=no', $haystack );
	}

	// -------------------------------------------------------------------------
	// status — Behind column edge: position present but partition_dir missing
	// -------------------------------------------------------------------------

	public function test_status_leaves_behind_as_dash_when_no_partition_dir(): void {
		// `saved_position` returns a non-null cursor (offsetlog has data), but
		// the conventional firehose.log partition dir doesn't exist on disk —
		// the `is_dir($partition_dir)` guard around `calculate_behind` should
		// skip the byte computation and `Behind` stays '-'. Exercises the
		// non-null-position, no-partition-dir branch.
		$this->register_topology( 'firehose-workers', 1 );
		$lock = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", (string) \getmypid() );

		// Offsetlog with a checkpoint — Cli::saved_position returns non-null.
		$offset_dir = "{$this->tmp}/offsets/firehose-workers.p0/p0";
		\mkdir( $offset_dir, 0755, true );
		\file_put_contents(
			"{$offset_dir}/0.log",
			\json_encode( [ 'seg' => 0, 'off' => 0, 'ts' => \time() ] ) . "\n"
		);
		// Deliberately DO NOT create logs/firehose.log/p0 — that's the branch.

		( new WorkerCliCommand() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'firehose-workers', $haystack );
		// Behind column must NOT have a byte literal rendered — calculate_behind
		// never ran. format_bytes would emit one of B/KB/MB/GB; assert none of
		// those rendered, which proves the is_dir guard short-circuited.
		$this->assertDoesNotMatchRegularExpression(
			'/\d+(B|KB|MB|GB)\s/',
			$haystack,
			'Behind column must stay as the dash fallback when no partition dir exists'
		);
	}

	// -------------------------------------------------------------------------
	// run — full path: descriptor lookup → topology resolution → execute()
	// -------------------------------------------------------------------------

	public function test_run_returns_skipped_status_when_lock_already_held(): void {
		// Full run() path. We arrange a fresh-held lock so WorkerBase::execute()
		// returns ['status' => 'skipped', 'reason' => 'lock_held'] immediately
		// — no drain loop, no shutdown handler, no respawn. The post-execute
		// WP_CLI::success log line is what we assert on.
		//
		// Register a real stock TSL so Topology_Registry::resolve() returns a
		// non-null path; content is irrelevant because the closure is never
		// invoked (we exit before run_topology()).
		$stock_dir = "{$this->tmp}/stock";
		\mkdir( $stock_dir, 0755, true );
		\file_put_contents( "{$stock_dir}/run-test-topology.tsl", "# noop\n" );
		Topology_Registry::register_stock_dir( $stock_dir );

		$this->register_topology( 'run-test-topology', 1, 'run-test-topology' );

		// Pre-create the lock dir with a fresh heartbeat naming another PID —
		// Lock::try_steal_orphan_or_stale sees fresh mtime → returns false →
		// WorkerBase::acquire() returns false → execute() returns 'skipped'.
		$lock_dir = "{$this->tmp}/locks/run-test-topology.p0.lock.d";
		\mkdir( $lock_dir, 0755, true );
		\file_put_contents( "{$lock_dir}/heartbeat", (string) ( \getmypid() + 99999 ) );

		( new WorkerCliCommand() )->run( [ 'run-test-topology' ], [ 'partition' => 0 ] );

		// Non-quiet: a 'Starting…' log line and a 'Worker exited with status:'
		// success line both fire. The success line carries the skipped status.
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString(
			'Starting run-test-topology.p0',
			\implode( "\n", $GLOBALS['_test_wp_cli_logs'] )
		);
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
		$this->assertStringContainsString( 'skipped', $GLOBALS['_test_wp_cli_success'][0] );
	}

	public function test_run_quiet_suppresses_logs_and_success(): void {
		// `--quiet` short-circuits the non-essential WP_CLI::log + ::success
		// calls. The command still drives execute() to completion (skipped),
		// but the stream stays empty.
		$stock_dir = "{$this->tmp}/stock";
		\mkdir( $stock_dir, 0755, true );
		\file_put_contents( "{$stock_dir}/run-quiet-test.tsl", "# noop\n" );
		Topology_Registry::register_stock_dir( $stock_dir );

		$this->register_topology( 'run-quiet-test', 1, 'run-quiet-test' );

		$lock_dir = "{$this->tmp}/locks/run-quiet-test.p0.lock.d";
		\mkdir( $lock_dir, 0755, true );
		\file_put_contents( "{$lock_dir}/heartbeat", (string) ( \getmypid() + 99999 ) );

		( new WorkerCliCommand() )->run(
			[ 'run-quiet-test' ],
			[ 'partition' => 0, 'quiet' => true ]
		);

		// Quiet mode: neither 'Starting…' nor the success line are emitted.
		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringNotContainsString( 'Starting run-quiet-test', $haystack );
		$this->assertEmpty(
			$GLOBALS['_test_wp_cli_success'],
			'quiet mode must suppress WP_CLI::success after execute()'
		);
	}
}
