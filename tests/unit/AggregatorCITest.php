<?php
/**
 * AggregatorCITest: unit tests for Aggregator_CI, the substrate service-CI that
 * collapses two legacy controllers (AggregatorController +
 * AggregatorStatusController) which both registered under
 * newspack-nodes-aggregator/v1.
 *
 * Three verbs:
 *   status  — per-server partition status (lifted from
 *             AggregatorStatusController::get_status, the purpose-built
 *             body that AggregatorController's stub delegated to).
 *   health  — cache reachability + timestamp (lifted from
 *             AggregatorController::health).
 *   servers — sequential array of registered servers with public-safe
 *             shape (lifted from AggregatorController::list_servers).
 *             Distinct from Servers_CI.list which returns a keyed map.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\Aggregator_CI_Node;
use Newspack_Nodes\Rest\Classes_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Core;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Vault;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Aggregator_CI_Node::class )]
class AggregatorCITest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		// /tmp directly to dodge symlink-resolved sys_get_temp_dir on macOS,
		// matching ServersCITest / StatusCITest.
		$this->tmp = '/tmp/aggregator-ci-test-' . \uniqid();
		\mkdir( $this->tmp, 0755, true );
		\mkdir( $this->tmp . '/topologies', 0755, true );
		$this->use_base_dir( $this->tmp );
		Core::$memd                   = new InMemoryMemcached();
		$GLOBALS['_wp_options']       = [];
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		Vault::get_instance()->reset_cache();
		Topology_Registry::reset();
		Topology_Registry::register_user_dir( $this->tmp . '/topologies' );
	}

	protected function tearDown(): void {
		VerbHarness::reset();
		Topology_Registry::reset();
		$GLOBALS['_wp_options']       = [];
		$GLOBALS['_wp_test_current_user_can'] = [];
		Vault::get_instance()->reset_cache();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/**
	 * Seed the active `aggregator` topology graph with operator-wired
	 * Remote_Source nodes by writing a real .tsl into the registered user dir
	 * (graph_for parses it). Each line is `make_node Remote_Source <name> <vault> firehose <partition>`.
	 *
	 * @param array<int,array{0:string,1:string,2:int}> $sources Tuples of [node-name, vault-id, partition].
	 */
	private function seed_aggregator_topology( array $sources ): void {
		$lines = [ 'make_node Remote_Job_Rewrite remote-job-rewrite' ];
		foreach ( $sources as [ $node_name, $vault_id, $partition ] ) {
			$lines[] = "make_node Remote_Source {$node_name} {$vault_id} firehose {$partition}";
			$lines[] = "connect_node {$node_name} remote-job-rewrite";
		}
		\file_put_contents( $this->tmp . '/topologies/aggregator.tsl', \implode( "\n", $lines ) . "\n" );
		Topology_Registry::reset_basename_cache();
	}

	/**
	 * Seed the substrate Vault directly via its option store so the
	 * status/servers verbs (which read `Vault::get_instance()`) see the
	 * server set under test. `logs` is intentionally NOT stored — the Vault
	 * drops it, matching the substrate public shape.
	 *
	 * @param string               $id     Server id.
	 * @param array<string, mixed> $config Server config (url, enabled, auth_*).
	 */
	private function seed_vault( string $id, array $config ): void {
		$existing            = $GLOBALS['_wp_options'][ Vault::OPTION_KEY ] ?? [];
		$existing[ $id ]     = $config;
		$GLOBALS['_wp_options'][ Vault::OPTION_KEY ] = $existing;
		Vault::get_instance()->reset_cache();
	}

	// ---------------------------------------------------------------------
	// status verb
	// ---------------------------------------------------------------------

	public function test_status_verb_returns_empty_map_when_no_remote_sources_wired(): void {
		// Topology graph has the rewrite node only — no Remote_Source lines.
		$this->seed_aggregator_topology( [] );

		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'status' );

		$this->assertSame( [], $result );
	}

	public function test_status_verb_discovers_wired_remote_sources_and_reads_np_remote_key(): void {
		// Operator wired one Remote_Source on partition 0; its substrate status
		// snapshot lives under np:remote:<node-name>:p<partition>.
		$this->seed_aggregator_topology( [ [ 'spoke-a', 'austin', 0 ] ] );
		$this->seed_vault( 'austin', [ 'url' => 'https://spoke.example/' ] );

		Core::$memd->set(
			'np:remote:spoke-a:p0',
			[ 'connected' => true, 'last_http_code' => 200, 'current_backoff' => 1 ],
			60
		);

		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'status' );

		$this->assertIsArray( $result );
		// Keyed by the wired NODE NAME (not the vault id).
		$this->assertArrayHasKey( 'spoke-a', $result );
		$this->assertSame( 'spoke-a', $result['spoke-a']['id'] );
		$this->assertSame( 'austin', $result['spoke-a']['vault_id'] );
		$this->assertStringStartsWith( 'https://spoke.example', $result['spoke-a']['url'] );
		$this->assertArrayHasKey( 'partitions', $result['spoke-a'] );
		$this->assertArrayHasKey( 0, $result['spoke-a']['partitions'] );
		$this->assertTrue( $result['spoke-a']['partitions'][0]['connected'] );
		$this->assertSame( 200, $result['spoke-a']['partitions'][0]['last_http_code'] );
	}

	public function test_status_verb_uses_empty_block_on_cache_miss(): void {
		$this->seed_aggregator_topology( [ [ 'spoke-b', 'other', 0 ] ] );

		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'status' );

		$this->assertArrayHasKey( 'spoke-b', $result );
		$this->assertSame( [], $result['spoke-b']['partitions'][0] );
	}

	public function test_status_verb_keys_each_partition_by_the_wired_partition(): void {
		// A Remote_Source wired on partition 3 reads np:remote:<name>:p3 — the
		// status snapshot keys on the node's own partition, not a 0..N sweep.
		$this->seed_aggregator_topology( [ [ 'spoke-c', 'cville', 3 ] ] );
		Core::$memd->set( 'np:remote:spoke-c:p3', [ 'connected' => false ], 60 );

		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'status' );

		$this->assertArrayHasKey( 'spoke-c', $result );
		$this->assertArrayHasKey( 3, $result['spoke-c']['partitions'] );
		$this->assertFalse( $result['spoke-c']['partitions'][3]['connected'] );
	}

	public function test_status_verb_ignores_non_remote_source_nodes(): void {
		// The rewrite node + Topic sink are in the graph too; only Remote_Source
		// nodes become status entries.
		$this->seed_aggregator_topology( [ [ 'spoke-d', 'denver', 0 ] ] );

		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'status' );

		$this->assertSame( [ 'spoke-d' ], \array_keys( $result ) );
	}

	// ---------------------------------------------------------------------
	// health verb
	// ---------------------------------------------------------------------

	public function test_health_verb_reports_cache_available(): void {
		// Core::$memd seeded in setUp().
		$interpreter = new Aggregator_CI_Node();

		$before = \time();
		$result = VerbHarness::fire( $interpreter, 'aggregator', 'health' );
		$after  = \time();

		$this->assertIsArray( $result );
		$this->assertTrue( $result['healthy'] );
		$this->assertTrue( $result['cache'] );
		$this->assertIsInt( $result['timestamp'] );
		$this->assertGreaterThanOrEqual( $before, $result['timestamp'] );
		$this->assertLessThanOrEqual( $after, $result['timestamp'] );
	}

	public function test_health_verb_reports_cache_unavailable_when_memd_null(): void {
		Core::$memd  = null;
		$interpreter = new Aggregator_CI_Node();

		$result = VerbHarness::fire( $interpreter, 'aggregator', 'health' );

		$this->assertTrue( $result['healthy'] );
		$this->assertFalse( $result['cache'] );
	}

	// ---------------------------------------------------------------------
	// servers verb
	// ---------------------------------------------------------------------

	public function test_servers_verb_returns_empty_sequential_array(): void {
		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'servers' );

		$this->assertSame( [], $result );
	}

	public function test_servers_verb_returns_sequential_array_of_public_shapes(): void {
		$this->seed_vault( 'site-a', [
			'url'           => 'https://a.example.com',
			'auth_username' => 'admin',
			'auth_password' => 'secret-pw-1',
		] );

		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'servers' );

		$this->assertIsArray( $result );
		// Sequential (not keyed by id) — distinguishes from Servers_CI.list.
		$this->assertArrayHasKey( 0, $result );
		$this->assertCount( 1, $result );
		$this->assertSame( 'site-a', $result[0]['id'] );
		$this->assertSame( 'https://a.example.com', $result[0]['url'] );
		// `enabled` and `logs` are dropped — mirrors the substrate Vault_CI public shape.
		$this->assertArrayNotHasKey( 'enabled', $result[0] );
		$this->assertArrayNotHasKey( 'logs', $result[0] );
		$this->assertTrue( $result[0]['has_credentials'] );
		// Credentials are NOT leaked into the response.
		$this->assertArrayNotHasKey( 'auth_username', $result[0] );
		$this->assertArrayNotHasKey( 'auth_password', $result[0] );
	}

	public function test_servers_verb_reports_no_credentials(): void {
		$this->seed_vault( 'plain', [ 'url' => 'https://plain.example.com' ] );

		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'servers' );

		$this->assertCount( 1, $result );
		$this->assertFalse( $result[0]['has_credentials'] );
	}

	// ---------------------------------------------------------------------
	// auth-gating
	//
	// Legacy AggregatorController + AggregatorStatusController both call
	// read_permissions_check(), which enforces manage_options on every
	// verb. Aggregator_CI mirrors that — even read-only verbs (status,
	// health, servers) require manage_options.
	// ---------------------------------------------------------------------

	public function test_status_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$interpreter                  = new Aggregator_CI_Node();
		$result                       = VerbHarness::fire( $interpreter, 'aggregator', 'status' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	public function test_health_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$interpreter                  = new Aggregator_CI_Node();
		$result                       = VerbHarness::fire( $interpreter, 'aggregator', 'health' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	public function test_servers_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$interpreter                  = new Aggregator_CI_Node();
		$result                       = VerbHarness::fire( $interpreter, 'aggregator', 'servers' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	// ---------------------------------------------------------------------
	// schema-driven dispatch + Vault reach
	//
	// After the schema migration the three verbs live in node_schema()['commands']
	// with handlers. The status/servers handlers read the substrate
	// `Newspack_Nodes\Vault` singleton directly (no injected registry); the
	// seeded-Vault test proves the dispatched handler actually read the option
	// store, not a fresh/empty view.
	// ---------------------------------------------------------------------

	public function test_node_schema_lists_all_verbs_with_handlers(): void {
		$verbs = [];
		foreach ( Aggregator_CI_Node::node_schema()['commands'] as $verb ) {
			$verbs[ $verb['name'] ] = $verb;
		}

		foreach ( [ 'status', 'health', 'servers' ] as $name ) {
			$this->assertArrayHasKey( $name, $verbs, "node_schema must list the '{$name}' verb" );
			$this->assertIsCallable( $verbs[ $name ]['handler'] );
		}
	}

	public function test_all_verbs_declare_no_args(): void {
		// status/health/servers read no $payload/$args — none of their handlers
		// even declare a $payload param, so each verb stays args => [].
		$verbs = [];
		foreach ( Aggregator_CI_Node::node_schema()['commands'] as $verb ) {
			$verbs[ $verb['name'] ] = $verb;
		}

		foreach ( [ 'status', 'health', 'servers' ] as $name ) {
			$this->assertSame( [], $verbs[ $name ]['args'], "'{$name}' must declare no args" );
		}
	}

	public function test_servers_verb_reads_the_vault(): void {
		// A server seeded into the substrate Vault must surface in the response,
		// proving the dispatched handler reads `Vault::get_instance()` rather
		// than a fresh/empty view.
		$this->seed_vault( 'sentinel', [ 'url' => 'https://sentinel.example/', 'enabled' => true ] );

		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'servers' );

		$this->assertCount( 1, $result );
		$this->assertSame( 'sentinel', $result[0]['id'] );
	}

	/**
	 * Tachikoma uniform-construction parity: the substrate `make_node` calls
	 * a no-arg ctor. Aggregator_CI now reads the Vault singleton directly (no
	 * injected object dep), so a bare `new Aggregator_CI_Node()` must dispatch
	 * its verbs against the seeded Vault with no further wiring.
	 */
	public function test_constructible_via_no_arg_ctor(): void {
		$this->seed_vault( 'sentinel', [ 'url' => 'https://s.example/', 'enabled' => true ] );

		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'servers' );

		$this->assertSame( 'sentinel', $result[0]['id'] );
	}

	/**
	 * Catalog-visibility guard (carried over from the ELN ServiceCiHandlerGuardTest
	 * when this CI moved here): a future edit dropping node_schema's `category` to
	 * ''/'Hidden' would silently hide Aggregator_CI from the Inspector/palette while
	 * every other test stayed green. Fire the substrate `classes list` and assert
	 * the CI surfaces under 'Service'.
	 */
	public function test_appears_in_class_catalog_as_service(): void {
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'list' );

		$this->assertArrayHasKey( 'classes', $result );
		// A stale classmap (no composer dump-autoload -o) yields zero classes and
		// would pass the per-CI assertion vacuously. Fail loudly instead.
		$this->assertNotEmpty(
			$result['classes'],
			'class discovery found nothing — stale composer classmap? (run composer dump-autoload -o)'
		);

		$by_shell = [];
		foreach ( $result['classes'] as $entry ) {
			$by_shell[ $entry['shell_name'] ] = $entry['category'];
		}

		$this->assertArrayHasKey(
			'Aggregator_CI',
			$by_shell,
			"Aggregator_CI is absent from the class catalog — its node_schema category was dropped to ''/'Hidden', or class discovery is broken"
		);
		$this->assertSame( 'Service', $by_shell['Aggregator_CI'] );
	}
}
