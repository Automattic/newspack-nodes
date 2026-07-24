<?php
/**
 * Tests for `wp nodes activate <topology>` / `wp nodes deactivate <topology>`.
 *
 * Both verbs delegate the option-write + cache-invalidate + spawn/drain to the
 * shared Topology_Registry::activate() / deactivate(); the CLI layer owns arg
 * validation, the catalog-listing error on an unknown name, and the WP_CLI
 * success/warning messaging. Spawn POSTs are captured via the bootstrap
 * Core::$curl_exec seam into $GLOBALS['_test_outbound_posts']; drain is
 * asserted via the restart flags kill_readers drops on live lock dirs.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Config;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_CLI_Command;
use PHPUnit\Framework\Attributes\CoversClass;

require_once \dirname( __DIR__, 2 ) . '/includes/cli/class-worker-cli-command.php';
require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( Worker_CLI_Command::class )]
class CliActivateCommandTest extends TestCase {

	private string $base_dir;
	private string $stock;
	private string $user;

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir( 'cli-activate-' );
		$this->use_base_dir( $this->base_dir );

		$this->stock = $this->make_temp_dir( 'cli-activate-stock-' );
		$this->user  = $this->make_temp_dir( 'cli-activate-user-' );
		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );

		$GLOBALS['_wp_actions']          = [];
		$GLOBALS['_test_outbound_posts'] = [];
		$GLOBALS['_test_wp_cli_logs']    = [];
		$GLOBALS['_test_wp_cli_warns']   = [];
		$GLOBALS['_test_wp_cli_errors']  = [];
		$GLOBALS['_test_wp_cli_success'] = [];

		// Start from clean Config + active-set state so a prior test FILE that left
		// a topology active (or a non-default num_partitions) can't skew how many
		// partitions deactivate drains here. Mirrors tearDown.
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		Config::reset();
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->user );
		$this->rmdir_recursive( $this->base_dir );
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		Config::reset();
		parent::tearDown();
	}

	// ── activate ───────────────────────────────────────────────────────────────

	public function test_activate_adds_to_active_set_and_reports_success(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "var num_partitions = 2\nmake_node Echo e\n" );

		( new Worker_CLI_Command() )->activate( [ 'alpha' ], [] );

		$this->assertContains( 'alpha', (array) \get_option( 'newspack_nodes_topologies', [] ) );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
		$this->assertStringContainsString( 'alpha', $GLOBALS['_test_wp_cli_success'][0] );
		// spawn_fleet POSTed one spawn per partition.
		$this->assertCount( 2, $GLOBALS['_test_outbound_posts'] ?? [] );
	}

	public function test_activate_is_idempotent_no_duplicate_entry(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha' ];
		Config::reset();

		( new Worker_CLI_Command() )->activate( [ 'alpha' ], [] );

		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertSame( [ 'alpha' ], \array_values( $active ) );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );
	}

	public function test_activate_requires_topology_arg(): void {
		$this->expectException( \RuntimeException::class );
		( new Worker_CLI_Command() )->activate( [], [] );
	}

	public function test_activate_errors_on_unknown_topology_listing_catalog(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		\file_put_contents( "{$this->stock}/beta.tsl", "make_node Echo b\n" );

		try {
			( new Worker_CLI_Command() )->activate( [ 'nope' ], [] );
			$this->fail( 'expected WP_CLI::error to throw' );
		} catch ( \RuntimeException $e ) {
			// WP_CLI::error stub throws with the message prefixed.
			$this->assertStringContainsString( 'nope', $e->getMessage() );
			// The catalog names are listed so the operator can pick a real one.
			$this->assertStringContainsString( 'alpha', $e->getMessage() );
			$this->assertStringContainsString( 'beta', $e->getMessage() );
		}

		// Nothing written, nothing spawned.
		$this->assertArrayNotHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'] );
		$this->assertEmpty( $GLOBALS['_test_outbound_posts'] ?? [] );
	}

	public function test_activate_errors_on_write_conflict(): void {
		$partition = 'make_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:min_segments> <config:max_segments> <config:min_lifetime> <config:max_lifetime>';
		\file_put_contents( "{$this->stock}/alpha.tsl", "var num_partitions = 2\n{$partition}\n" );
		\file_put_contents( "{$this->stock}/beta.tsl", "var num_partitions = 2\nmake_node Partition requests:partition <config:logs_dir>/requests.p<partition> 1048576 2 4 0 0\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha' ];
		Config::reset();

		try {
			( new Worker_CLI_Command() )->activate( [ 'beta' ], [] );
			$this->fail( 'expected WP_CLI::error to throw on conflict' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'conflict', $e->getMessage() );
		}

		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertNotContains( 'beta', $active );
	}

	// ── deactivate ───────────────────────────────────────────────────────────

	public function test_deactivate_removes_from_active_set_and_drains(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "var num_partitions = 2\nmake_node Echo e\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha' ];
		Config::reset();

		foreach ( [ 0, 1 ] as $p ) {
			$dir = "{$this->base_dir}/locks/alpha.p{$p}.lock.d";
			\mkdir( $dir, 0755, true );
			\file_put_contents( "{$dir}/heartbeat", (string) \getmypid() );
		}

		( new Worker_CLI_Command() )->deactivate( [ 'alpha' ], [] );

		$this->assertNotContains( 'alpha', (array) \get_option( 'newspack_nodes_topologies', [] ) );
		$this->assertNotEmpty( $GLOBALS['_test_wp_cli_success'] );

		foreach ( [ 0, 1 ] as $p ) {
			$this->assertTrue(
				Lock_Node::is_restart_pending( "{$this->base_dir}/locks/alpha.p{$p}.lock.d" ),
				"partition p{$p} must have restart flag dropped"
			);
		}
	}

	public function test_deactivate_requires_topology_arg(): void {
		$this->expectException( \RuntimeException::class );
		( new Worker_CLI_Command() )->deactivate( [], [] );
	}

	public function test_deactivate_errors_on_unknown_topology_listing_catalog(): void {
		// Symmetry with activate: a name not in the catalog must error (and list
		// the available names) rather than silently "succeed" having matched
		// nothing — and an unvalidated token must never reach kill_readers().
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		\file_put_contents( "{$this->stock}/beta.tsl", "make_node Echo b\n" );

		try {
			( new Worker_CLI_Command() )->deactivate( [ 'nope' ], [] );
			$this->fail( 'expected WP_CLI::error to throw' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'nope', $e->getMessage() );
			$this->assertStringContainsString( 'alpha', $e->getMessage() );
			$this->assertStringContainsString( 'beta', $e->getMessage() );
		}

		// The active-set option must be untouched.
		$this->assertArrayNotHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'] );
	}

	public function test_deactivate_preserves_other_active_names(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		\file_put_contents( "{$this->stock}/beta.tsl", "make_node Echo b\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha', 'beta' ];
		Config::reset();

		( new Worker_CLI_Command() )->deactivate( [ 'alpha' ], [] );

		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertNotContains( 'alpha', $active );
		$this->assertContains( 'beta', $active );
	}
}
