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
		$GLOBALS['_wp_test_remote_posts']      = [];
		$GLOBALS['_test_wp_cli_logs']          = [];
		$GLOBALS['_test_wp_cli_warns']         = [];
		$GLOBALS['_test_wp_cli_errors']        = [];
		$GLOBALS['_test_wp_cli_success']       = [];

		// Filter base_dir to point at our tmp.
		\add_filter( 'newspack_nodes/base_dir', fn () => $this->tmp );
	}

	protected function tearDown(): void {
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
		$this->assertStringContainsString( 'No topologies registered', $GLOBALS['_test_wp_cli_warns'][0] );
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
}
