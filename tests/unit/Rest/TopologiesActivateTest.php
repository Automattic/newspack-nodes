<?php
/**
 * TopologiesActivateTest: unit tests for the activate / deactivate verbs on
 * Topologies_CI_Node — the first CI writers of the `newspack_nodes_topologies`
 * active-set option.
 *
 * activate materializes the effective active set (Bootstrap::get_topologies()),
 * adds the name, writes the option, invalidates the config cache, then spawns
 * the fleet immediately via Supervisor::spawn_fleet(). deactivate is the
 * symmetric drain: remove the name, write, invalidate, then kill the fleet via
 * Supervisor::kill_readers().
 *
 * Spawn is captured via the bootstrap-installed Core::$curl_exec seam,
 * which records every fire-and-forget POST into $GLOBALS['_test_outbound_posts'].
 * Drain is asserted via the restart flags kill_readers drops on each live
 * lock dir (Lock_Node::is_restart_pending).
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit\Rest;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Rest\Topologies_CI_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Topologies_CI_Node::class )]
class TopologiesActivateTest extends TestCase {

	private string $base_dir;
	private string $stock;
	private string $user;

	protected function setUp(): void {
		parent::setUp();
		$this->base_dir = $this->make_temp_dir( 'topologies-activate-' );
		$this->use_base_dir( $this->base_dir );

		$this->stock = $this->make_temp_dir( 'topologies-activate-stock-' );
		$this->user  = $this->make_temp_dir( 'topologies-activate-user-' );
		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );

		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$GLOBALS['_wp_actions']           = [];
		$GLOBALS['_test_outbound_posts']  = [];

		// Start from clean Config + active-set state so a prior test FILE that left
		// a topology active can't skew this suite. Mirrors tearDown.
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		Config::reset();
	}

	protected function tearDown(): void {
		VerbHarness::reset();
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->user );
		$this->rmdir_recursive( $this->base_dir );
		$GLOBALS['_wp_test_current_user_can'] = [];
		$GLOBALS['_wp_actions']               = [];
		$GLOBALS['_test_outbound_posts']      = [];
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		\putenv(
			'LOCAL_NEWSPACK_NODES_CONF=' . \dirname( __DIR__, 2 ) . '/newspack-nodes-test-config.php'
		);
		Config::reset();
		parent::tearDown();
	}

	// ── activate ───────────────────────────────────────────────────────────────

	public function test_activate_adds_name_to_option_and_spawns_fleet(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "var num_partitions = 2\nmake_node Echo e\n" );

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'activate',
			'alpha'
		);

		$this->assertIsArray( $result );
		$this->assertSame( 'alpha', $result['name'] );
		$this->assertTrue( $result['active'] );
		$this->assertSame( 2, $result['spawned'] );

		// The active-set option now contains the name.
		$this->assertContains( 'alpha', (array) \get_option( 'newspack_nodes_topologies', [] ) );

		// spawn_fleet POSTed one spawn per partition.
		$posts = $GLOBALS['_test_outbound_posts'] ?? [];
		$this->assertCount( 2, $posts );
		foreach ( $posts as $post ) {
			$this->assertSame( 'alpha', $post['args']['body']['type'] );
		}
	}

	public function test_activate_preserves_already_active_names(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		\file_put_contents( "{$this->stock}/beta.tsl",  "make_node Echo b\n" );
		// beta already active.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'beta' ];
		Config::reset();

		VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'activate', 'alpha' );

		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertContains( 'alpha', $active );
		$this->assertContains( 'beta', $active );
	}

	public function test_activate_does_not_duplicate_an_already_active_name(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha' ];
		Config::reset();

		VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'activate', 'alpha' );

		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertSame( [ 'alpha' ], \array_values( $active ) );
	}

	public function test_activate_preserves_unset_option_default_active_set(): void {
		// The data-loss-adjacent edge: the WP option `newspack_nodes_topologies`
		// has NEVER been written, but the config-file default makes the effective
		// active set non-empty (alpha + beta). activate must materialize from the
		// effective set (Bootstrap::get_topologies()), not from
		// get_option(..., []) — otherwise activating a third name would silently
		// narrow the active set to just that name and drop the file defaults.
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		\file_put_contents( "{$this->stock}/beta.tsl",  "make_node Echo b\n" );
		\file_put_contents( "{$this->stock}/gamma.tsl", "make_node Echo g\n" );

		// File-default active set = [alpha, beta]; WP option remains unset.
		$this->use_base_dir( $this->base_dir, [ 'topologies' => [ 'alpha', 'beta' ] ] );
		$this->assertArrayNotHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'] );

		VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'activate', 'gamma' );

		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertContains( 'alpha', $active );
		$this->assertContains( 'beta', $active );
		$this->assertContains( 'gamma', $active );
	}

	public function test_activate_rejects_unknown_topology_without_writing(): void {
		// activate must THROW on an unknown name (mirroring get/save/delete), so
		// interpret() packages the reply as TM_ERROR — not a plain error STRING
		// that rides back as a SUCCESS (TM_RESPONSE) and lets the JS
		// `await activate(bad)` resolve as if it worked. Capture the raw response
		// Message so the TM_ERROR flag is observable (VerbHarness collapses both
		// shapes to the payload string and can't tell them apart).
		$response = $this->fire_capturing_response( 'activate', 'does-not-exist' );

		$type = $response[ Message::TYPE ];
		$this->assertSame( Message::TM_ERROR, $type & Message::TM_ERROR, 'unknown activate must reply TM_ERROR' );
		$this->assertStringContainsString( 'unknown topology', (string) $response[ Message::VALUE ]['payload'] );
		$this->assertStringContainsString( 'does-not-exist', (string) $response[ Message::VALUE ]['payload'] );

		// No write, no spawn.
		$this->assertArrayNotHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'] );
		$this->assertEmpty( $GLOBALS['_test_outbound_posts'] ?? [] );
	}

	/**
	 * Fire a verb through the interpreter → base → router path, capturing the
	 * raw response Message (TYPE intact) on a Capture_Sink_Node. Mirrors
	 * VerbHarness::fire but keeps the wire-level TYPE for TM_ERROR assertions.
	 *
	 * @return array<int,mixed> The captured response Message.
	 */
	private function fire_capturing_response( string $verb, string $args ): array {
		$router  = new Router_Node();
		$router->name( '_router' );
		$capture = new Capture_Sink_Node();
		$capture->name( '_output' );
		$base = new Command_Interpreter_Node();
		$base->name( '_command_interpreter' );
		$base->sink( $router );

		$ci = new Topologies_CI_Node();
		$ci->name( 'topologies' );
		$ci->sink( $base );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_COMMAND;
		$message[ Message::FROM ]  = '_output';
		$message[ Message::TO ]    = '';
		$message[ Message::ID ]    = 'test-' . \bin2hex( \random_bytes( 4 ) );
		$message[ Message::VALUE ] = [ 'name' => $verb, 'arguments' => $args ];
		$message[ Message::LOCAL ] = true;

		$ci->fill( $message );

		$this->assertNotEmpty( $capture->captured, 'no response captured' );
		return $capture->captured[0];
	}

	public function test_activate_rejects_a_write_conflicting_topology(): void {
		// Active topology A and a topology B that WRITES the same partition log —
		// activating B would put two fleets on one log and corrupt it. The verb
		// must reject (TM_ERROR) BEFORE writing the option or spawning, so the
		// regression that let the manager toggle create the conflict stays closed.
		$partition = 'make_node Partition requests:partition <config:logs_dir>/requests.p<partition> <config:segment_size> <config:num_segments> <config:max_lifespan>';
		\file_put_contents( "{$this->stock}/alpha.tsl", "var num_partitions = 2\n{$partition}\n" );
		\file_put_contents( "{$this->stock}/beta.tsl", "var num_partitions = 2\n{$partition}\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha' ];
		Config::reset();

		$response = $this->fire_capturing_response( 'activate', 'beta' );

		$type = $response[ Message::TYPE ];
		$this->assertSame( Message::TM_ERROR, $type & Message::TM_ERROR, 'conflicting activate must reply TM_ERROR' );
		$this->assertStringContainsString( 'conflict', (string) $response[ Message::VALUE ]['payload'] );
		$this->assertStringContainsString( 'beta', (string) $response[ Message::VALUE ]['payload'] );

		// A stays active, B never got written, nothing spawned.
		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertContains( 'alpha', $active );
		$this->assertNotContains( 'beta', $active );
		$this->assertEmpty( $GLOBALS['_test_outbound_posts'] ?? [] );
	}

	public function test_activate_rejects_a_malformed_name(): void {
		// A malformed name (path traversal / slashes / whitespace) must be
		// rejected by require_valid_name BEFORE any update_option or spawn —
		// the active set is consumed downstream as file-name-safe basenames.
		$response = $this->fire_capturing_response( 'activate', '../evil' );

		$type = $response[ Message::TYPE ];
		$this->assertSame( Message::TM_ERROR, $type & Message::TM_ERROR, 'malformed activate must reply TM_ERROR' );
		$this->assertStringContainsString( 'invalid name', (string) $response[ Message::VALUE ]['payload'] );

		// No write, no spawn.
		$this->assertArrayNotHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'] );
		$this->assertEmpty( $GLOBALS['_test_outbound_posts'] ?? [] );
	}

	public function test_activate_requires_manage_options(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		$GLOBALS['_wp_test_current_user_can'] = [];

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'activate',
			'alpha'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
		// Gate prevented the write.
		$this->assertArrayNotHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'] );
	}

	// ── deactivate ───────────────────────────────────────────────────────────

	public function test_deactivate_removes_name_from_option_and_drains_fleet(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "var num_partitions = 2\nmake_node Echo e\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha' ];
		Config::reset();

		// Two live workers (lock dirs) so kill_readers has something to flag.
		foreach ( [ 0, 1 ] as $p ) {
			$dir = "{$this->base_dir}/locks/alpha.p{$p}.lock.d";
			\mkdir( $dir, 0755, true );
			\file_put_contents( "{$dir}/heartbeat", (string) \getmypid() );
		}

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'deactivate',
			'alpha'
		);

		$this->assertIsArray( $result );
		$this->assertSame( 'alpha', $result['name'] );
		$this->assertFalse( $result['active'] );

		// Option no longer contains the name.
		$this->assertNotContains( 'alpha', (array) \get_option( 'newspack_nodes_topologies', [] ) );

		// kill_readers dropped a restart flag on each live lock dir.
		foreach ( [ 0, 1 ] as $p ) {
			$this->assertTrue(
				Lock_Node::is_restart_pending( "{$this->base_dir}/locks/alpha.p{$p}.lock.d" ),
				"partition p{$p} must have restart flag dropped"
			);
		}
	}

	public function test_deactivate_preserves_other_active_names(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		\file_put_contents( "{$this->stock}/beta.tsl",  "make_node Echo b\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha', 'beta' ];
		Config::reset();

		VerbHarness::fire( new Topologies_CI_Node(), 'topologies', 'deactivate', 'alpha' );

		$active = (array) \get_option( 'newspack_nodes_topologies', [] );
		$this->assertNotContains( 'alpha', $active );
		$this->assertContains( 'beta', $active );
	}

	public function test_deactivate_rejects_a_malformed_name(): void {
		// deactivate must also guard the name before array_diff + update_option,
		// so a malformed basename can never reach the persisted active set.
		$response = $this->fire_capturing_response( 'deactivate', 'bad/name' );

		$type = $response[ Message::TYPE ];
		$this->assertSame( Message::TM_ERROR, $type & Message::TM_ERROR, 'malformed deactivate must reply TM_ERROR' );
		$this->assertStringContainsString( 'invalid name', (string) $response[ Message::VALUE ]['payload'] );

		// No write.
		$this->assertArrayNotHasKey( 'newspack_nodes_topologies', $GLOBALS['_wp_options'] );
	}

	public function test_deactivate_requires_manage_options(): void {
		\file_put_contents( "{$this->stock}/alpha.tsl", "make_node Echo a\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'alpha' ];
		Config::reset();
		$GLOBALS['_wp_test_current_user_can'] = [];

		$result = VerbHarness::fire(
			new Topologies_CI_Node(),
			'topologies',
			'deactivate',
			'alpha'
		);

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
		// Gate prevented the write — option unchanged.
		$this->assertSame( [ 'alpha' ], (array) \get_option( 'newspack_nodes_topologies', [] ) );
	}

	public function test_node_schema_declares_activate_and_deactivate(): void {
		$schema = Topologies_CI_Node::node_schema();
		$names  = \array_map( static fn ( array $v ): string => $v['name'], $schema['commands'] );

		$this->assertContains( 'activate', $names );
		$this->assertContains( 'deactivate', $names );
	}
}
