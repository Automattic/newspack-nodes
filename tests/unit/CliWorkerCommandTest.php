<?php
/**
 * Smoke tests for `wp nodes types`, `wp nodes restart`, `wp nodes status`, and
 * `wp nodes run` — covering registration shape, capability/nonce surface, and
 * happy-path behavior. Tests do NOT spawn real workers (run command is gated
 * out by missing topology files in the temp dir).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Record;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_CLI_Command;

require_once \dirname( __DIR__, 2 ) . '/includes/cli/class-worker-cli-command.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( Worker_CLI_Command::class )]
class CliWorkerCommandTest extends TestCase {
	private string $tmp;

	/** The harness installs ONE recording curl seam for the whole run; restore it, never null it. */
	private ?\Closure $curl_exec_before = null;

	protected function setUp(): void {
		parent::setUp();
		// /tmp/... directly so realpath() matches input on hosts where
		// sys_get_temp_dir() resolves through a symlink (macOS /tmp → /private/tmp).
		$staging = (string) \realpath( \sys_get_temp_dir() ) . '/newspack-nodes-worker-cli-test-' . \uniqid();
		\mkdir( $staging, 0755, true );
		$this->tmp = \realpath( $staging ) ?: $staging;

		$GLOBALS['_wp_actions']                = [];
		$GLOBALS['_test_outbound_posts']      = [];
		$GLOBALS['_test_wp_cli_logs']          = [];
		$GLOBALS['_test_wp_cli_warns']         = [];
		$GLOBALS['_test_wp_cli_errors']        = [];
		$GLOBALS['_test_wp_cli_success']       = [];

		$this->curl_exec_before = \Newspack_Nodes\Core::$curl_exec;
		$this->use_base_dir( $this->tmp );
		Topology_Registry::reset();
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		Worker_CLI_Command::$sleep = null;
		\Newspack_Nodes\Core::$curl_exec = $this->curl_exec_before;
		\Newspack_Nodes\Bootstrap::$spawn_coordinator_factory = null;
		\Newspack_Nodes\Spawn_Coordinator::clear_hold();
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\Newspack_Nodes\Config::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** Seed a real packed-Message Consumer checkpoint at offsets/{source_basename}.p{partition}/0.log. */
	private function seed_consumer_checkpoint( string $source_basename, int $partition, array $value ): void {
		// status() enumerates Consumers from the Topic_Probe log; seed a lean
		// positional Probe_Record there.
		$dir = "{$this->tmp}/logs/topicprobe.p0";
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		$record                             = [];
		$record[ Probe_Record::SOURCE ]     = $value['source'] ?? $value['source_log'] ?? "{$source_basename}.p{$partition}";
		$record[ Probe_Record::READER ]     = "{$source_basename}.p{$partition}";
		$record[ Probe_Record::CURSOR_SEGMENT ] = $value['segment'] ?? 0;
		$record[ Probe_Record::CURSOR_OFF ] = $value['offset'] ?? 0;
		$record[ Probe_Record::END_SEGMENT ]    = $value['end_segment'] ?? 0;
		$record[ Probe_Record::END_SIZE ]   = $value['end_size'] ?? 0;
		$record[ Probe_Record::DISTANCE ]   = $value['distance'] ?? $value['bytes_behind'] ?? 0;
		$record[ Probe_Record::MSGS_DELTA ]       = $value['msgs'] ?? 0;
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = $record;
		\file_put_contents( "{$dir}/0.log", Message::packed( $message ) . "\n", FILE_APPEND );
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
		// Catalog registration alone no longer activates a topology; declare it
		// in the operator overlay so get_topologies()/expand_workers() honor it.
		$active                                                = $GLOBALS['_wp_options']['newspack_nodes_topologies'] ?? [];
		$active[]                                              = $type;
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = \array_values( \array_unique( $active ) );
		\Newspack_Nodes\Config::reset();
	}

	// -------------------------------------------------------------------------
	// types
	// -------------------------------------------------------------------------

	public function test_types_warns_when_no_topologies(): void {
		( new Worker_CLI_Command() )->types( [], [] );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_warns'] );
		$this->assertStringContainsString( 'No active topologies', $GLOBALS['_test_wp_cli_warns'][0] );
	}

	public function test_types_lists_registered_groups(): void {
		$this->register_topology( 'firehose-workers', 4 );
		$this->register_topology( 'aggregator', 1 );

		( new Worker_CLI_Command() )->types( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'firehose-workers', $haystack );
		$this->assertStringContainsString( '4 partitions', $haystack );
		$this->assertStringContainsString( 'aggregator', $haystack );
		$this->assertStringContainsString( '1 partition', $haystack );
	}

	// -------------------------------------------------------------------------
	// restart
	// -------------------------------------------------------------------------

	public function test_restart_requires_target_arg(): void {
		$this->expectException( \RuntimeException::class );
		( new Worker_CLI_Command() )->restart( [], [] );
	}

	public function test_restart_rejects_invalid_target(): void {
		$this->register_topology( 'firehose-workers', 2 );
		try {
			( new Worker_CLI_Command() )->restart( [ 'no-such-type' ], [ 'partition' => 0 ] );
			$this->fail( 'Expected invalid restart target to fail.' );
		} catch ( \RuntimeException ) {
			$this->assertSame(
				[ 'Invalid restart target: no-such-type. Available: firehose-workers, all' ],
				$GLOBALS['_test_wp_cli_errors']
			);
		}
	}

	// ── stop / start: the deploy hold ──────────────────────────────────────

	/**
	 * `stop` is `restart` plus a hold: without the persisted refusal, cron, the
	 * peer scan, a partition wake and every self-respawn each bring the fleet
	 * back inside the deploy window.
	 */
	public function test_stop_sets_the_hold_and_flags_every_worker(): void {
		$this->register_topology( 'firehose-workers', 3 );
		for ( $p = 0; $p < 3; $p++ ) {
			\mkdir( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d", 0755, true );
		}
		// Every lock dir vanishes on the first poll: the workers exited.
		Worker_CLI_Command::$sleep = function (): void {
			$this->rmdir_recursive( "{$this->tmp}/locks" );
		};

		( new Worker_CLI_Command() )->stop( [], [] );

		$this->assertGreaterThan( 0, \Newspack_Nodes\Spawn_Coordinator::hold() );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
	}

	/**
	 * A worker that released its lock and POSTed its own respawn just before the
	 * hold landed has NO lock dir while it bootstraps. Reporting the fleet
	 * stopped into that gap lets the deploy swap `includes/` under a successor
	 * that is about to acquire — the exact corruption this command prevents.
	 */
	public function test_stop_does_not_report_success_while_a_spawn_is_in_flight(): void {
		$this->register_topology( 'firehose-workers', 1 );
		// No lock dirs at all: the predecessor is gone, the successor booting.
		// Pin ONE coordinator so the in-flight mark stays instance-local: a
		// persisted record_spawn would outlive the test in a shared cache tier.
		$fleet = new \Newspack_Nodes\Spawn_Coordinator( $this->tmp, 'TEST_SALT' );
		$fleet->record_spawn_local( 'firehose-workers', 0, \Newspack_Nodes\Core::right_now() );
		\Newspack_Nodes\Bootstrap::$spawn_coordinator_factory = static fn () => $fleet;
		Worker_CLI_Command::$sleep = static function (): void {};

		try {
			( new Worker_CLI_Command() )->stop( [], [ 'timeout' => 0 ] );
			$this->fail( 'an in-flight spawn must not read as a stopped fleet' );
		} catch ( \RuntimeException ) {
			$this->assertStringContainsString(
				'spawn in flight',
				\implode( ' ', $GLOBALS['_test_wp_cli_errors'] )
			);
		}
	}

	/**
	 * A worker whose topology was deactivated still holds a real lock and still
	 * runs; deriving the wait set from the ACTIVE fleet would miss it entirely
	 * and report the fleet stopped.
	 */
	public function test_stop_waits_for_a_lock_held_by_a_deactivated_topology(): void {
		$this->register_topology( 'firehose-workers', 1 );
		\mkdir( "{$this->tmp}/locks/retired-workers.p0.lock.d", 0755, true );
		Worker_CLI_Command::$sleep = static function (): void {};

		try {
			( new Worker_CLI_Command() )->stop( [], [ 'timeout' => 0 ] );
			$this->fail( 'a lock held outside the active fleet must still block' );
		} catch ( \RuntimeException ) {
			$this->assertStringContainsString(
				'retired-workers.p0',
				\implode( ' ', $GLOBALS['_test_wp_cli_errors'] )
			);
		}
	}

	/**
	 * A worker that acquires mid-wait must still be told to stop — flagging only
	 * once, before the wait, leaves it running and spins out the full timeout.
	 */
	public function test_stop_flags_a_worker_that_appears_during_the_wait(): void {
		$this->register_topology( 'firehose-workers', 1 );
		$first = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		$late  = "{$this->tmp}/locks/late-workers.p0.lock.d";
		\mkdir( $first, 0755, true );

		$calls        = 0;
		$flagged_late = false;
		Worker_CLI_Command::$sleep = function () use ( &$calls, &$flagged_late, $first, $late ): void {
			++$calls;
			if ( 1 === $calls ) {
				\mkdir( $late, 0755, true );
				return;
			}
			// Observed before teardown: the dirs go, and the flags with them.
			$flagged_late = \is_file( $late . '/' . Lock_Node::STOP_FLAG );
			$this->rmdir_recursive( $first );
			$this->rmdir_recursive( $late );
		};

		( new Worker_CLI_Command() )->stop( [], [ 'timeout' => 30 ] );

		$this->assertTrue( $flagged_late, 'a worker that appeared mid-wait must be flagged' );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
	}

	/**
	 * A deploy script that reads "stopped" while a worker still holds its lock is
	 * how this feature would cause the corruption it exists to prevent — so a
	 * timeout must fail loudly and NAME the stragglers.
	 */
	public function test_stop_fails_and_names_workers_still_up_on_timeout(): void {
		$this->register_topology( 'firehose-workers', 2 );
		\mkdir( "{$this->tmp}/locks/firehose-workers.p1.lock.d", 0755, true );
		Worker_CLI_Command::$sleep = static function (): void {};

		try {
			( new Worker_CLI_Command() )->stop( [], [ 'timeout' => 0 ] );
			$this->fail( 'a fleet still up must exit non-zero' );
		} catch ( \RuntimeException ) {
			$this->assertStringContainsString(
				'firehose-workers.p1',
				\implode( ' ', $GLOBALS['_test_wp_cli_errors'] )
			);
		}
	}

	/**
	 * A held fleet is indistinguishable from a broken one unless the surface
	 * says so — the same reasoning that made an absent on-demand worker read
	 * `idle` rather than `down`.
	 */
	public function test_status_reads_held_not_down_while_the_fleet_is_held(): void {
		$this->register_topology( 'firehose-workers', 1 );
		\Newspack_Nodes\Spawn_Coordinator::set_hold( 1754500000 );

		( new Worker_CLI_Command() )->status( [], [ 'format' => 'json' ] );

		$this->assertStringContainsString( 'held', \implode( ' ', $GLOBALS['_test_wp_cli_logs'] ) );
	}

	/**
	 * `spawn_due_workers()` counts an attempt, not a success. Reporting that
	 * number as "spawned" after releasing the hold is the worst possible lie:
	 * the fleet is down, the hold that explained it is gone, and the operator
	 * has been told it came back.
	 */
	public function test_start_does_not_report_failed_spawns_as_spawned(): void {
		$this->register_topology( 'firehose-workers', 2 );
		\Newspack_Nodes\Core::$curl_exec = static fn () => false;

		( new Worker_CLI_Command() )->start( [], [] );

		$said = \implode( ' ', \array_merge(
			$GLOBALS['_test_wp_cli_success'],
			$GLOBALS['_test_wp_cli_warns']
		) );
		$this->assertStringNotContainsString( 'spawned 2 worker', $said );
	}

	/**
	 * A timed-out `stop` leaves a straggler holding its lock WITH a stop flag.
	 * `start` skips that slot (its lock is present and fresh), so if the flag
	 * survives, the worker reads it whenever its handler finally returns, exits,
	 * and — being a `stop` — does not respawn. The slot empties minutes AFTER
	 * the operator was told the fleet came back.
	 */
	public function test_start_clears_stop_flags_left_by_a_timed_out_stop(): void {
		$this->register_topology( 'firehose-workers', 1 );
		$straggler = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		\mkdir( $straggler, 0755, true );
		Lock_Node::request_stop_at( $straggler );

		( new Worker_CLI_Command() )->start( [], [] );

		$this->assertFileDoesNotExist( $straggler . '/' . Lock_Node::STOP_FLAG );
	}

	/**
	 * A fleet that goes quiet during the FINAL poll interval must not abort the
	 * deploy: the verdict was computed before the last sleep, so it named workers
	 * that were already gone.
	 */
	public function test_stop_rechecks_after_the_last_sleep_before_failing(): void {
		$this->register_topology( 'firehose-workers', 1 );
		\mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		// Exits during the final sleep, after the pre-sleep verdict was taken.
		Worker_CLI_Command::$sleep = function (): void {
			$this->rmdir_recursive( "{$this->tmp}/locks" );
		};

		( new Worker_CLI_Command() )->stop( [], [ 'timeout' => 0 ] );

		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
	}

	/**
	 * A refused flag write (unwritable dir — the documented root-vs-bend
	 * ownership footgun) must say so. Silently flagging nothing spins the full
	 * timeout and blames the workers for not exiting.
	 */
	public function test_stop_reports_flag_writes_it_could_not_make(): void {
		$this->register_topology( 'firehose-workers', 1 );
		$dir = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		\mkdir( $dir, 0755, true );
		\chmod( $dir, 0555 );
		Worker_CLI_Command::$sleep = static function (): void {};

		try {
			( new Worker_CLI_Command() )->stop( [], [ 'timeout' => 0 ] );
		} catch ( \RuntimeException ) {
			// Expected: the worker never exits.
		} finally {
			\chmod( $dir, 0755 );
		}

		$this->assertStringContainsString(
			'could not write',
			\implode( ' ', \array_merge( $GLOBALS['_test_wp_cli_warns'], $GLOBALS['_test_wp_cli_errors'] ) )
		);
	}

	/** The hold stays put until `start` lifts it — that is the whole feature. */
	public function test_start_clears_the_hold(): void {
		$this->register_topology( 'firehose-workers', 1 );
		\Newspack_Nodes\Spawn_Coordinator::set_hold( 1754500000 );

		( new Worker_CLI_Command() )->start( [], [] );

		$this->assertSame( 0, \Newspack_Nodes\Spawn_Coordinator::hold() );
	}

	/**
	 * Restarting every partition is the point — a worker type is a fleet, and
	 * restarting one of six leaves five running the old code. Bare `restart
	 * <type>` therefore means all of them; --partition narrows it.
	 */
	public function test_restart_without_partition_restarts_every_partition(): void {
		$this->register_topology( 'firehose-workers', 3 );
		for ( $p = 0; $p < 3; $p++ ) {
			\mkdir( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d", 0755, true );
		}

		( new Worker_CLI_Command() )->restart( [ 'firehose-workers' ], [] );

		for ( $p = 0; $p < 3; $p++ ) {
			$this->assertTrue(
				Lock_Node::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d" ),
				"p{$p} flag should be set"
			);
		}
	}

	/** --partition still narrows to exactly one, leaving its siblings alone. */
	public function test_restart_with_partition_touches_only_that_one(): void {
		$this->register_topology( 'firehose-workers', 3 );
		for ( $p = 0; $p < 3; $p++ ) {
			\mkdir( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d", 0755, true );
		}

		( new Worker_CLI_Command() )->restart( [ 'firehose-workers' ], [ 'partition' => 1 ] );

		$this->assertFalse( Lock_Node::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p0.lock.d" ) );
		$this->assertTrue( Lock_Node::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p1.lock.d" ) );
		$this->assertFalse( Lock_Node::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p2.lock.d" ) );
	}

	public function test_restart_writes_flag_for_specific_partition(): void {
		$this->register_topology( 'firehose-workers', 2 );

		$lock_dir_p0 = "{$this->tmp}/locks/firehose-workers.p0.lock.d";
		$lock_dir_p1 = "{$this->tmp}/locks/firehose-workers.p1.lock.d";
		\mkdir( $lock_dir_p0, 0755, true );
		\mkdir( $lock_dir_p1, 0755, true );

		( new Worker_CLI_Command() )->restart(
			[ 'firehose-workers' ],
			[ 'partition' => 1 ]
		);

		$this->assertTrue( Lock_Node::is_restart_pending( $lock_dir_p1 ), 'p1 flag should be written' );
		$this->assertFalse( Lock_Node::is_restart_pending( $lock_dir_p0 ), 'p0 flag should not be written' );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
	}

	public function test_restart_all_partitions_writes_every_lock(): void {
		$this->register_topology( 'firehose-workers', 3 );
		for ( $p = 0; $p < 3; $p++ ) {
			\mkdir( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d", 0755, true );
		}

		( new Worker_CLI_Command() )->restart( [ 'firehose-workers' ], [] );

		for ( $p = 0; $p < 3; $p++ ) {
			$lock_dir = "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d";
			$this->assertTrue( Lock_Node::is_restart_pending( $lock_dir ), "p{$p} flag should be set" );
		}
	}

	public function test_restart_all_wildcard_matches_every_type(): void {
		$this->register_topology( 'firehose-workers', 1 );
		$this->register_topology( 'aggregator', 1 );
		\mkdir( "{$this->tmp}/locks/firehose-workers.p0.lock.d", 0755, true );
		\mkdir( "{$this->tmp}/locks/aggregator.p0.lock.d", 0755, true );

		( new Worker_CLI_Command() )->restart( [ 'all' ], [] );

		$this->assertTrue( Lock_Node::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p0.lock.d" ) );
		$this->assertTrue( Lock_Node::is_restart_pending( "{$this->tmp}/locks/aggregator.p0.lock.d" ) );
	}

	// -------------------------------------------------------------------------
	// status
	// -------------------------------------------------------------------------

	public function test_status_warns_when_no_workers_registered(): void {
		( new Worker_CLI_Command() )->status( [], [] );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_warns'] );
	}

	public function test_status_lists_fleet_rows_with_state_heartbeat_and_uptime(): void {
		$this->register_topology( 'aggregator', 1 );
		$lock = "{$this->tmp}/locks/aggregator.p0.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", '1' );
		\file_put_contents( "{$lock}/started", (string) ( \time() - 4520 ) );

		( new Worker_CLI_Command() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'aggregator', $haystack );
		$this->assertStringContainsString( 'live', $haystack );
		$this->assertStringContainsString( '1h 15m', $haystack, 'uptime from the lock started file' );
		$this->assertMatchesRegularExpression( '/\b\d+s ago\b/', $haystack, 'heartbeat age' );
	}

	public function test_status_names_the_attachable_worker_id(): void {
		// The Worker column is the exact id `wp nodes cli` takes — without it
		// a new user has no path from status output to a REPL.
		$this->register_topology( 'aggregator', 2 );

		( new Worker_CLI_Command() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'aggregator.p0', $haystack );
		$this->assertStringContainsString( 'aggregator.p1', $haystack );
		$this->assertStringContainsString( 'wp nodes cli <Worker>', $haystack, 'status must teach the attach command' );
	}

	public function test_status_marks_active_topology_without_a_lock_as_down(): void {
		$this->register_topology( 'aggregator', 2 );
		\mkdir( "{$this->tmp}/locks/aggregator.p0.lock.d", 0755, true );
		\file_put_contents( "{$this->tmp}/locks/aggregator.p0.lock.d/heartbeat", '1' );

		( new Worker_CLI_Command() )->status( [], [] ); // p1 has no lock dir

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'down', $haystack );
	}

	public function test_status_marks_a_stale_heartbeat(): void {
		$this->register_topology( 'aggregator', 1 );
		$lock = "{$this->tmp}/locks/aggregator.p0.lock.d";
		\mkdir( $lock, 0755, true );
		\file_put_contents( "{$lock}/heartbeat", '1' );
		\touch( "{$lock}/heartbeat", \time() - 120 ); // > Lock_Node::STALE_TIMEOUT

		( new Worker_CLI_Command() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'stale', $haystack );
	}

	public function test_status_surfaces_an_orphan_lock_of_a_deactivated_type(): void {
		// Lock dir with no matching active topology and no heartbeat file:
		// still listed (base_dir resolution proof), suffixed, heartbeat '-'.
		\mkdir( "{$this->tmp}/locks/retired.p0.lock.d", 0755, true );

		( new Worker_CLI_Command() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'retired', $haystack );
		$this->assertStringContainsString( '(inactive)', $haystack );
		$this->assertStringContainsString( '-', $haystack );
	}

	public function test_status_lists_inactive_catalog_topologies(): void {
		\mkdir( "{$this->tmp}/tsl", 0755, true );
		\file_put_contents( "{$this->tmp}/tsl/parked.tsl", "# no nodes\n" );
		Topology_Registry::register_builtin_dir( "{$this->tmp}/tsl" );

		( new Worker_CLI_Command() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'parked', $haystack );
		$this->assertStringContainsString( 'inactive', $haystack );
	}

	public function test_status_renders_a_row_per_active_consumer(): void {
		// The consumer-lag section rides below the fleet table.
		$this->seed_consumer_checkpoint( 'firehose', 0, [ 'source' => 'firehose.p0', 'distance' => 0 ] );
		$this->seed_consumer_checkpoint( 'requests', 1, [ 'source' => 'requests.p1', 'distance' => 0 ] );

		( new Worker_CLI_Command() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'firehose.p0', $haystack );
		$this->assertStringContainsString( 'requests.p1', $haystack );
	}

	public function test_status_sorts_the_reader_list(): void {
		// Probe-snapshot order is arrival order; the table sorts by reader,
		// then source, then partition.
		$this->seed_consumer_checkpoint( 'zebra-reader', 0, [ 'source' => 'zeta.p0', 'distance' => 0 ] );
		$this->seed_consumer_checkpoint( 'apple-reader', 1, [ 'source' => 'alpha.p1', 'distance' => 0 ] );
		$this->seed_consumer_checkpoint( 'mango-reader', 0, [ 'source' => 'mid.p0', 'distance' => 0 ] );

		( new Worker_CLI_Command() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$apple = \strpos( $haystack, 'apple-reader' );
		$mango = \strpos( $haystack, 'mango-reader' );
		$zebra = \strpos( $haystack, 'zebra-reader' );
		$this->assertNotFalse( $apple );
		$this->assertNotFalse( $mango );
		$this->assertNotFalse( $zebra );
		$this->assertLessThan( $mango, $apple, 'apple before mango' );
		$this->assertLessThan( $zebra, $mango, 'mango before zebra' );
	}

	// -------------------------------------------------------------------------
	// run
	// -------------------------------------------------------------------------

	public function test_run_synopsis_does_not_shadow_global_quiet(): void {
		// Declaring `[--quiet]` in the command synopsis collides with WP-CLI's
		// built-in global --quiet and makes registration warn. Rely on the
		// global; the synopsis must not redeclare it.
		$doc = ( new \ReflectionMethod( Worker_CLI_Command::class, 'run' ) )->getDocComment();
		$this->assertIsString( $doc );
		$this->assertStringNotContainsString( '--quiet', $doc );
	}

	public function test_run_requires_type(): void {
		$this->expectException( \RuntimeException::class );
		( new Worker_CLI_Command() )->run( [], [] );
	}

	public function test_run_rejects_unknown_type(): void {
		$this->register_topology( 'firehose-workers', 1 );
		$this->expectException( \RuntimeException::class );
		( new Worker_CLI_Command() )->run( [ 'unknown' ], [] );
	}

	public function test_run_errors_on_missing_topology_file(): void {
		// Topology registered but the path doesn't exist.
		$this->register_topology( 'firehose-workers', 1, '/nonexistent/topology.php' );
		$this->expectException( \RuntimeException::class );
		( new Worker_CLI_Command() )->run( [ 'firehose-workers' ], [] );
	}

	public function test_run_errors_when_topology_name_not_in_registry(): void {
		// Descriptor names a topology no plugin has registered with
		// Topology_Registry — the registry returns null on resolve()
		// and WorkerCliCommand bails with a clear message.
		$this->register_topology( 'bogus-topology', 1, 'bogus-topology' );
		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/Topology not found in registry/' );
		( new Worker_CLI_Command() )->run( [ 'bogus-topology' ], [] );
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

		Worker_CLI_Command::restart_fleet_by_name( 'firehose-workers' );

		for ( $p = 0; $p < 3; $p++ ) {
			$this->assertTrue(
				Lock_Node::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p{$p}.lock.d" ),
				"partition p{$p} must have restart flag written"
			);
		}
	}

	public function test_restart_fleet_by_name_noop_for_unknown_fleet(): void {
		// "Best-effort: unknown name or no live workers → no-op."
		// No matching workers in expand_workers → array_filter strips all
		// entries → no work to do. Must not throw, must not touch disk.
		\mkdir( "{$this->tmp}/locks", 0755, true );

		Worker_CLI_Command::restart_fleet_by_name( 'never-registered' );

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

		Worker_CLI_Command::restart_fleet_by_name( 'firehose-workers' );

		$this->assertTrue( Lock_Node::is_restart_pending( "{$this->tmp}/locks/firehose-workers.p0.lock.d" ) );
		$this->assertFalse(
			Lock_Node::is_restart_pending( "{$this->tmp}/locks/aggregator.p0.lock.d" ),
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
		( new Worker_CLI_Command() )->run(
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

		( new Worker_CLI_Command() )->types( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( '1 partition', $haystack );
		// Make sure the plural form did NOT also leak in.
		$this->assertStringNotContainsString( '1 partitions', $haystack );
	}

	public function test_types_includes_topology_path_when_provided(): void {
		// Each entry's `topology` field is logged on a separate "topology:"
		// line when set; verifies the secondary log statement.
		$this->register_topology( 'firehose-workers', 2, '/some/explicit/path.tsl' );

		( new Worker_CLI_Command() )->types( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( '/some/explicit/path.tsl', $haystack );
	}

	// -------------------------------------------------------------------------
	// status command — saved_position + Behind + cache filter branches
	// -------------------------------------------------------------------------

	public function test_status_renders_per_consumer_behind_from_the_probe_snapshot(): void {
		// Behind is read straight off the probe snapshot's DISTANCE (cursor vs
		// partition-end measured together) — never recomputed against a fresh stat.
		$this->seed_consumer_checkpoint( 'firehose', 0, [
			'source' => 'firehose.p0', 'distance' => 200,
		] );

		( new Worker_CLI_Command() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'firehose.p0', $haystack );
		$this->assertStringContainsString( '200B', $haystack );
	}

	public function test_status_renders_a_row_per_disambiguated_reader(): void {
		// Two Consumers of the SAME source under distinct readers each get their
		// OWN row + Behind, from their own probe snapshot.
		$this->seed_consumer_checkpoint( 'firehose', 0, [ 'source' => 'firehose.p0', 'distance' => 400 ] );
		$this->seed_consumer_checkpoint( 'firehose.job-router', 0, [ 'source' => 'firehose.p0', 'distance' => 200 ] );

		( new Worker_CLI_Command() )->status( [], [] );

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'firehose.job-router.p0', $haystack );
		$this->assertStringContainsString( '400B', $haystack );
		$this->assertStringContainsString( '200B', $haystack );
	}

	public function test_status_exits_cleanly_with_fallback_renderer(): void {
		// `WP_CLI\Utils\format_items` is not stubbed in this test harness, so
		// status() emits via the printf-style fallback. Pin the contract.
		$this->seed_consumer_checkpoint( 'firehose', 0, [ 'source' => 'firehose.p0', 'msgs' => 7 ] );

		( new Worker_CLI_Command() )->status( [], [] );

		// Plain-text fallback emits a header line plus one line per row.
		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'firehose.p0', $haystack );
		$this->assertStringContainsString( 'Msgs', $haystack );
		$this->assertStringContainsString( '7', $haystack );
	}

	// -------------------------------------------------------------------------
	// run — full path: descriptor lookup → topology resolution → execute()
	// -------------------------------------------------------------------------

	public function test_run_refuses_root(): void {
		// Same footgun as `wp nodes cli`: a root run seeds root-owned IPC/lock
		// dirs that lock out the web-user fleet.
		CLI::$uid_provider = static fn (): int => 0;
		try {
			$this->expectException( \RuntimeException::class );
			$this->expectExceptionMessageMatches( '/root/' );
			( new Worker_CLI_Command() )->run( [ 'anything' ], [] );
		} finally {
			CLI::$uid_provider = null;
		}
	}

	public function test_run_prints_the_skip_reason(): void {
		// `wp nodes run` is the debugging verb — dropping the reason hides the
		// root-ownership footgun a third time. The success line must carry it.
		$stock_dir = "{$this->tmp}/stock";
		\mkdir( $stock_dir, 0755, true );
		\file_put_contents( "{$stock_dir}/reason-topology.tsl", "# noop\n" );
		Topology_Registry::register_stock_dir( $stock_dir );
		$this->register_topology( 'reason-topology', 1, 'reason-topology' );

		$lock_dir = "{$this->tmp}/locks/reason-topology.p0.lock.d";
		\mkdir( $lock_dir, 0755, true );
		\file_put_contents( "{$lock_dir}/heartbeat", (string) ( \getmypid() + 99999 ) );

		( new Worker_CLI_Command() )->run( [ 'reason-topology' ], [ 'partition' => 0 ] );

		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
		$this->assertStringContainsString( 'lock_held', $GLOBALS['_test_wp_cli_success'][0], 'the skip reason must reach the operator' );
	}

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

		( new Worker_CLI_Command() )->run( [ 'run-test-topology' ], [ 'partition' => 0 ] );

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

	public function test_run_delegates_quiet_to_wp_cli_global(): void {
		// Quiet is WP-CLI's global concern: its Quiet logger no-ops log/success
		// when --quiet is set. The command no longer special-cases a `quiet`
		// arg — so a stray one is ignored and the calls still fire (the runtime
		// logger, not the command, decides whether they print).
		$stock_dir = "{$this->tmp}/stock";
		\mkdir( $stock_dir, 0755, true );
		\file_put_contents( "{$stock_dir}/run-quiet-test.tsl", "# noop\n" );
		Topology_Registry::register_stock_dir( $stock_dir );

		$this->register_topology( 'run-quiet-test', 1, 'run-quiet-test' );

		$lock_dir = "{$this->tmp}/locks/run-quiet-test.p0.lock.d";
		\mkdir( $lock_dir, 0755, true );
		\file_put_contents( "{$lock_dir}/heartbeat", (string) ( \getmypid() + 99999 ) );

		( new Worker_CLI_Command() )->run(
			[ 'run-quiet-test' ],
			[ 'partition' => 0, 'quiet' => true ]
		);

		$haystack = \implode( "\n", $GLOBALS['_test_wp_cli_logs'] );
		$this->assertStringContainsString( 'Starting run-quiet-test', $haystack );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
	}
}
