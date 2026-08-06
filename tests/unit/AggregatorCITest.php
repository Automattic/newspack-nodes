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

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\HTTP_Out_Node;
use Newspack_Nodes\Rest\Aggregator_CI_Node;
use Newspack_Nodes\Rest\Classes_CI_Node;
use Newspack_Nodes\Tests\Helpers\VerbHarness;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Vault;

#[CoversClass( Aggregator_CI_Node::class )]
class AggregatorCITest extends TestCase {

	/** Session ids this file seeds; tearDown drops them so they can't leak. */
	private const SEEDED_SESSIONS = [ 'austin', 'ghost', 'sentinel', 'xvault', 'spoke1' ];
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		// A probe now requires a live session for its destination; seed the ids
		// this file probes so the $http_call stubs answer only the /command leg.
		foreach ( self::SEEDED_SESSIONS as $spoke ) {
			Command_Auth::remember_session( $spoke, \str_repeat( '3', 32 ), 'probe-session-key' );
		}
		// /tmp directly to dodge symlink-resolved sys_get_temp_dir on macOS,
		// matching ServersCITest / StatusCITest.
		$this->tmp = (string) \realpath( \sys_get_temp_dir() ) . '/aggregator-ci-test-' . \uniqid();
		\mkdir( $this->tmp, 0755, true );
		\mkdir( $this->tmp . '/topologies', 0755, true );
		$this->use_base_dir( $this->tmp );
		Core::$memd                   = new InMemoryMemcached();
		$GLOBALS['_wp_options']       = [];
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		Vault::get_instance()->reset_cache();
		Topology_Registry::reset();
		Topology_Registry::register_user_dir( $this->tmp . '/topologies' );
		HTTP_Out_Node::$http_call = null;
	}

	protected function tearDown(): void {
		foreach ( self::SEEDED_SESSIONS as $spoke ) {
			Command_Auth::forget_session( $spoke );
		}
		VerbHarness::reset();
		Topology_Registry::reset();
		$GLOBALS['_wp_options']       = [];
		$GLOBALS['_wp_test_current_user_can'] = [];
		Vault::get_instance()->reset_cache();
		HTTP_Out_Node::$http_call = null;
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/**
	 * Seed the active `aggregator` topology graph with operator-wired
	 * Remote_Source nodes by writing a real .tsl into the registered user dir
	 * (graph_for parses it). Each line is the real 2-arg schema
	 * `make_node Remote_Source <name> <vault> <remote_partition>`, where
	 * remote_partition embeds the `<partition>` token so the node fans across
	 * every configured partition. `var num_partitions` pins how many partitions
	 * Aggregator_CI enumerates.
	 *
	 * @param array<int,array{0:string,1:string,2:string}> $sources        Tuples of [node-name, vault-id, remote_partition-template].
	 * @param int                                          $num_partitions Configured partition count.
	 */
	private function seed_aggregator_topology( array $sources, int $num_partitions = 1 ): void {
		$lines = [
			"var num_partitions = {$num_partitions}",
			'make_node Remote_Job_Rewrite remote-job-rewrite',
		];
		foreach ( $sources as [ $node_name, $vault_id, $remote_partition ] ) {
			$lines[] = "make_node Remote_Source {$node_name} {$vault_id} {$remote_partition}";
			$lines[] = "connect_node {$node_name} remote-job-rewrite";
		}
		\file_put_contents( $this->tmp . '/topologies/aggregator.tsl', \implode( "\n", $lines ) . "\n" );
		Topology_Registry::reset_basename_cache();
		// The snapshot scans the ACTIVE set; a seeded topology must be active.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'aggregator' ];
		\Newspack_Nodes\Config::reset();
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
	// build_snapshot (exercised via the servers_status slice)
	// ---------------------------------------------------------------------

	public function test_servers_status_discovers_remote_sources_in_any_active_topology(): void {
		// Readers live in include-based overlays with their own names (e.g.
		// aggregator-tw0); the dashboard must not be married to the literal
		// topology name 'aggregator'.
		$lines = [
			'var num_partitions = 1',
			'make_node Remote_Job_Rewrite remote-job-rewrite',
			'make_node Remote_Source spoke-x9 xvault firehose.p<partition>',
			'connect_node spoke-x9 remote-job-rewrite',
		];
		\file_put_contents( $this->tmp . '/topologies/aggregator-x9.tsl', \implode( "\n", $lines ) . "\n" );
		Topology_Registry::reset_basename_cache();
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'aggregator-x9' ];
		\Newspack_Nodes\Config::reset();
		$this->seed_vault( 'xvault', [ 'url' => 'https://x9.example' ] );

		$decoded = \json_decode(
			VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'servers_status' ),
			true
		);

		$this->assertCount( 1, $decoded );
		$this->assertSame( 'spoke-x9', $decoded[0]['id'] );
		$this->assertSame( 'xvault', $decoded[0]['vault_id'] );
	}

	public function test_servers_status_uses_empty_block_on_cache_miss(): void {
		$this->seed_aggregator_topology( [ [ 'spoke-b', 'other', 'firehose.p<partition>' ] ] );

		$decoded = \json_decode(
			VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'servers_status' ),
			true
		);

		$this->assertSame( 'spoke-b', $decoded[0]['id'] );
		$this->assertSame( [], $decoded[0]['partitions'][0] );
	}

	public function test_servers_status_reads_every_configured_partition(): void {
		// One Remote_Source whose remote_partition embeds the `<partition>` token
		// fans across all configured partitions: with num_partitions=2 the snapshot
		// reads np:remote:spoke-c:firehose.p0 AND ...firehose.p1, keyed by partition
		// index (0,1) — not a single wired partition.
		$this->seed_aggregator_topology( [ [ 'spoke-c', 'cville', 'firehose.p<partition>' ] ], 2 );
		Core::$memd->set( 'np:remote:spoke-c:firehose.p0', [ 'connected' => true ], 60 );
		Core::$memd->set( 'np:remote:spoke-c:firehose.p1', [ 'connected' => false ], 60 );

		$decoded = \json_decode(
			VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'servers_status' ),
			true
		);

		$this->assertSame( 'spoke-c', $decoded[0]['id'] );
		$this->assertSame( [ 0, 1 ], \array_keys( $decoded[0]['partitions'] ) );
		$this->assertTrue( $decoded[0]['partitions'][0]['connected'] );
		$this->assertFalse( $decoded[0]['partitions'][1]['connected'] );
	}

	public function test_servers_status_ignores_non_remote_source_nodes(): void {
		// The rewrite node + Topic sink are in the graph too; only Remote_Source
		// nodes become snapshot entries.
		$this->seed_aggregator_topology( [ [ 'spoke-d', 'denver', 'firehose.p<partition>' ] ] );

		$decoded = \json_decode(
			VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'servers_status' ),
			true
		);

		$this->assertCount( 1, $decoded );
		$this->assertSame( 'spoke-d', $decoded[0]['id'] );
	}

	// ---------------------------------------------------------------------
	// summary verb (de-god slice: cheap header derivation, server-computed)
	//
	// The de-god split replaced the single `status` god-view with two slice
	// views, each fed by its own slice verb. `summary` is the header slice:
	// connected/total counts + the snapshot clock — computed server-side from
	// the SAME per-node partition snapshot `status` builds, so the dashboard
	// header reads a tiny JSON blob instead of recomputing the count from the
	// full partition payload. slice_verb returns a JSON STRING (the substrate
	// SliceViewNode contract), so VerbHarness gets the encoded string back.
	// ---------------------------------------------------------------------

	public function test_summary_verb_returns_zero_counts_when_no_remote_sources_wired(): void {
		$this->seed_aggregator_topology( [] );

		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'summary' );

		$this->assertIsString( $result );
		$decoded = \json_decode( $result, true );
		$this->assertSame( 0, $decoded['connected'] );
		$this->assertSame( 0, $decoded['total'] );
		$this->assertIsInt( $decoded['server_now'] );
	}

	public function test_summary_verb_counts_servers_with_at_least_one_connected_partition(): void {
		// spoke-a has one connected partition (p0) → counts as 1 connected;
		// spoke-b has no connected partitions → counts toward total only.
		$this->seed_aggregator_topology(
			[
				[ 'spoke-a', 'austin', 'firehose.p<partition>' ],
				[ 'spoke-b', 'denver', 'firehose.p<partition>' ],
			],
			2
		);
		Core::$memd->set( 'np:remote:spoke-a:firehose.p0', [ 'connected' => true ], 60 );
		Core::$memd->set( 'np:remote:spoke-a:firehose.p1', [ 'connected' => false ], 60 );

		$interpreter = new Aggregator_CI_Node();
		$decoded     = \json_decode( VerbHarness::fire( $interpreter, 'aggregator', 'summary' ), true );

		$this->assertSame( 1, $decoded['connected'] );
		$this->assertSame( 2, $decoded['total'] );
	}

	public function test_summary_verb_stamps_a_wall_clock_server_now(): void {
		$this->seed_aggregator_topology( [ [ 'spoke-a', 'austin', 'firehose.p<partition>' ] ] );

		$before  = \time();
		$decoded = \json_decode(
			VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'summary' ),
			true
		);
		$after   = \time();

		$this->assertGreaterThanOrEqual( $before, $decoded['server_now'] );
		$this->assertLessThanOrEqual( $after, $decoded['server_now'] );
	}

	public function test_summary_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result                               = VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'summary' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	// ---------------------------------------------------------------------
	// servers_status verb (de-god slice: the heavy per-server partition data)
	//
	// The servers slice carries the full per-server partition snapshot the
	// server cards render. Same discovery + memcache read as `status`, but
	// returned as a SEQUENTIAL ARRAY (the React server-card list maps over it)
	// and encoded as a JSON STRING (SliceViewNode contract).
	// ---------------------------------------------------------------------

	public function test_servers_status_verb_returns_empty_array_when_no_remote_sources_wired(): void {
		$this->seed_aggregator_topology( [] );

		$decoded = \json_decode(
			VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'servers_status' ),
			true
		);

		$this->assertSame( [], $decoded );
	}

	public function test_servers_status_verb_returns_sequential_array_of_server_snapshots(): void {
		$this->seed_aggregator_topology( [ [ 'spoke-a', 'austin', 'firehose.p<partition>' ] ] );
		$this->seed_vault( 'austin', [ 'url' => 'https://spoke.example/' ] );
		Core::$memd->set(
			'np:remote:spoke-a:firehose.p0',
			[ 'connected' => true, 'last_http_code' => 200 ],
			60
		);

		$decoded = \json_decode(
			VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'servers_status' ),
			true
		);

		// Sequential array (NOT keyed by node-name) — the card list maps over it.
		$this->assertArrayHasKey( 0, $decoded );
		$this->assertCount( 1, $decoded );
		$this->assertSame( 'spoke-a', $decoded[0]['id'] );
		$this->assertSame( 'austin', $decoded[0]['vault_id'] );
		$this->assertStringStartsWith( 'https://spoke.example', $decoded[0]['url'] );
		$this->assertTrue( $decoded[0]['partitions'][0]['connected'] );
		$this->assertSame( 200, $decoded[0]['partitions'][0]['last_http_code'] );
	}

	public function test_servers_status_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result                               = VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'servers_status' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	public function test_slice_verbs_agree_on_the_same_snapshot(): void {
		// summary and servers_status both derive from build_snapshot(), so the
		// header counts must match the server-card list they summarize.
		$this->seed_aggregator_topology(
			[
				[ 'spoke-a', 'austin', 'firehose.p<partition>' ],
				[ 'spoke-b', 'denver', 'firehose.p<partition>' ],
			]
		);
		// Each VerbHarness::fire builds a fresh request-scope graph and Core::reset
		// (which clears Core::$memd) clears its node registry between fires. Re-seed
		// the memcache snapshot + auth before each fire so both verbs read the same
		// snapshot; the seeded topology lives in Topology_Registry and survives.
		$reseed = function (): void {
			Core::$memd = new InMemoryMemcached();
			Core::$memd->set( 'np:remote:spoke-a:firehose.p0', [ 'connected' => true ], 60 );
			$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		};

		$reseed();
		$servers_slice = \json_decode( VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'servers_status' ), true );
		VerbHarness::reset();
		$reseed();
		$summary = \json_decode( VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'summary' ), true );

		// summary's total matches the server-card count; connected matches the rollup.
		$this->assertSame( \count( $servers_slice ), $summary['total'] );
		$this->assertSame( 1, $summary['connected'] );
	}

	// ---------------------------------------------------------------------
	// schema-driven dispatch + Vault reach
	//
	// The `summary` / `servers_status` slice handlers derive from build_snapshot(),
	// which reads the substrate `Newspack_Nodes\Vault` singleton directly (no
	// injected registry); the seeded-Vault test proves the dispatched handler
	// actually read the option store, not a fresh/empty view.
	// ---------------------------------------------------------------------

	public function test_node_schema_lists_all_verbs_with_handlers(): void {
		$verbs = [];
		foreach ( Aggregator_CI_Node::node_schema()['commands'] as $verb ) {
			$verbs[ $verb['name'] ] = $verb;
		}

		foreach ( [ 'summary', 'servers_status' ] as $name ) {
			$this->assertArrayHasKey( $name, $verbs, "node_schema must list the '{$name}' verb" );
			$this->assertIsCallable( $verbs[ $name ]['handler'] );
		}
		// The raw `status` / legacy `servers` / `health` verbs were removed — the
		// de-god slices `summary` + `servers_status` are the only live surface.
		foreach ( [ 'status', 'health', 'servers' ] as $removed ) {
			$this->assertArrayNotHasKey( $removed, $verbs, "removed verb '{$removed}' must not be listed" );
		}
	}

	public function test_all_verbs_declare_no_args(): void {
		// summary/servers_status read no $payload/$args — neither handler even
		// declares a $payload param, so each stays args => [].
		$verbs = [];
		foreach ( Aggregator_CI_Node::node_schema()['commands'] as $verb ) {
			$verbs[ $verb['name'] ] = $verb;
		}

		foreach ( [ 'summary', 'servers_status' ] as $name ) {
			$this->assertSame( [], $verbs[ $name ]['args'], "'{$name}' must declare no args" );
		}
	}

	public function test_servers_status_reads_the_vault(): void {
		// A server seeded into the substrate Vault must surface in the response,
		// proving the dispatched handler reads the Vault singleton rather than a
		// fresh/empty view.
		$this->seed_aggregator_topology( [ [ 'spoke-a', 'sentinel', 'firehose.p<partition>' ] ] );
		$this->seed_vault( 'sentinel', [ 'url' => 'https://sentinel.example/', 'enabled' => true ] );

		$decoded = \json_decode(
			VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'servers_status' ),
			true
		);

		$this->assertCount( 1, $decoded );
		$this->assertSame( 'sentinel', $decoded[0]['vault_id'] );
		$this->assertStringStartsWith( 'https://sentinel.example', $decoded[0]['url'] );
	}

	/**
	 * Tachikoma uniform-construction parity: the substrate `make_node` calls
	 * a no-arg ctor. Aggregator_CI now reads the Vault singleton directly (no
	 * injected object dep), so a bare `new Aggregator_CI_Node()` must dispatch
	 * its verbs against the seeded Vault with no further wiring.
	 */
	public function test_constructible_via_no_arg_ctor(): void {
		$this->seed_aggregator_topology( [ [ 'spoke-a', 'sentinel', 'firehose.p<partition>' ] ] );
		$this->seed_vault( 'sentinel', [ 'url' => 'https://s.example/', 'enabled' => true ] );

		$decoded = \json_decode(
			VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'servers_status' ),
			true
		);

		$this->assertSame( 'sentinel', $decoded[0]['vault_id'] );
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

	// ── probe verb — on-demand per-spoke fleet roll-up ──────────────────────

	/**
	 * Stub the shared probe seam to return a spoke `workers/dump_graph` reply.
	 *
	 * @param array<string,mixed> $payload The dump_graph payload the spoke returns.
	 */
	private function stub_probe_reply( array $payload ): void {
		HTTP_Out_Node::$http_call = static function ( string $url, array $args ) use ( $payload ): array {
			$reply                     = Message::new_message();
			$reply[ Message::TYPE ]    = Message::TM_COMMAND | Message::TM_RESPONSE;
			$reply[ Message::VALUE ]   = [ 'name' => 'dump_graph', 'payload' => $payload ];
			return [ 'response' => [ 'code' => 200 ], 'body' => Message::packed( $reply ) ];
		};
	}

	public function test_probe_verb_rolls_up_a_spoke_dump_graph(): void {
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com', 'auth_username' => 'u', 'auth_password' => 'p' ] );
		Vault::get_instance()->reset_cache();
		$this->stub_probe_reply(
			[
				'workers'             => [
					[ 'type' => 'a', 'partition' => 0, 'status' => 'running', 'live' => true, 'stale' => false, 'heartbeat_age' => 1 ],
					[ 'type' => 'b', 'partition' => 0, 'status' => 'dead', 'live' => false, 'stale' => true, 'heartbeat_age' => 240 ],
					[ 'type' => 'c', 'partition' => 0, 'status' => 'dead', 'live' => false, 'stale' => false, 'heartbeat_age' => null ],
				],
				'consumers'           => [
					[ 'reader' => 'x.p0', 'distance' => 512 ],
					[ 'reader' => 'y.p0', 'distance' => 88_888 ],
				],
				'deadletter_segments' => 6,
			]
		);

		$out = VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'probe', 'spoke1' );

		$this->assertSame( 'spoke1', $out['id'] );
		$this->assertSame( [ 'total' => 3, 'live' => 1, 'stale' => 1, 'dead' => 1 ], $out['workers'] );
		$this->assertSame( 88_888, $out['worst_distance'] );
		$this->assertSame( 6, $out['deadletter_segments'] );
	}

	public function test_probe_verb_requires_a_known_server(): void {
		$out = VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'probe', 'ghost' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'server not found', $out );
	}

	public function test_probe_verb_requires_an_id(): void {
		$out = VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'probe' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'id required', $out );
	}

	public function test_probe_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		Vault::get_instance()->add( 'spoke1', [ 'url' => 'https://e.com' ] );
		Vault::get_instance()->reset_cache();

		$out = VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'probe', 'spoke1' );

		$this->assertIsString( $out );
		$this->assertStringContainsString( 'permission denied', $out );
	}
}
