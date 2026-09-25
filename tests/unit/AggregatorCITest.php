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
use Newspack_Nodes\Remote_Source_Node;
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
	 * Seed an active topology whose spokes come from the Vault through one
	 * `Vault_Group` of `Remote_Source` children over `tw-edge`, the way a hub
	 * declares them. Each id in `$members` joins `tw-edge`; `lone` (no group)
	 * and `aux` (group `llm`) sit in the Vault too, so a reader that lists the
	 * whole Vault rather than the group shows them. Children are named
	 * `firehose:<id>`, and `var num_partitions` pins how many partitions
	 * Aggregator_CI enumerates.
	 *
	 * @param list<string> $members        Vault ids in `tw-edge`.
	 * @param int          $num_partitions Configured partition count.
	 * @param string       $topology       Active topology name.
	 * @param list<string> $written        Further hand-written lines.
	 */
	private function seed_group_topology( array $members, int $num_partitions = 1, string $topology = 'aggregator', array $written = [] ): void {
		$servers = [
			'lone' => [ 'url' => 'https://lone.example/' ],
			'aux'  => [ 'url' => 'https://aux.example/', 'group' => 'llm' ],
		];
		foreach ( $members as $id ) {
			$servers[ $id ] = [ 'url' => "https://{$id}.example/", 'group' => 'tw-edge' ];
		}
		$this->seed_vault_servers( $servers );
		$lines = [
			"var num_partitions = {$num_partitions}",
			'make_node Remote_Job_Rewrite remote-job-rewrite',
			'make_node Vault_Group firehose Remote_Source tw-edge firehose.p<partition>',
			'connect_node firehose remote-job-rewrite',
			...$written,
		];
		\file_put_contents( "{$this->tmp}/topologies/{$topology}.tsl", \implode( "\n", $lines ) . "\n" );
		Topology_Registry::reset_basename_cache();
		// The snapshot scans the ACTIVE set; a seeded topology must be active.
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ $topology ];
		\Newspack_Nodes\Config::reset();
	}

	/**
	 * Seed one child's status snapshot, as its reader publishes it.
	 *
	 * @param string               $id       Vault id of the child.
	 * @param string               $source   Concrete remote partition.
	 * @param array<string, mixed> $snapshot Published status.
	 */
	private static function seed_status( string $id, string $source, array $snapshot ): void {
		Core::$memd->set( Remote_Source_Node::status_key_for( "firehose:{$id}", $source ), $snapshot, 60 );
	}

	/** @return list<array<string, mixed>> The decoded `list_servers` slice. */
	private static function list_servers(): array {
		return \json_decode( VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'list_servers' ), true );
	}

	// ---------------------------------------------------------------------
	// build_snapshot (exercised via the list_servers slice)
	// ---------------------------------------------------------------------

	public function test_list_servers_names_the_group_members_in_any_active_topology(): void {
		// Readers live in include-based overlays with their own names; the
		// dashboard must not be married to the literal topology name.
		$this->seed_group_topology( [ 'tw0', 'tw9' ], 1, 'aggregator-x9' );

		$decoded = self::list_servers();

		$this->assertSame( [ 'firehose:tw0', 'firehose:tw9' ], \array_column( $decoded, 'id' ) );
		$this->assertSame( [ 'tw0', 'tw9' ], \array_column( $decoded, 'vault_id' ) );
	}

	public function test_list_servers_lists_a_written_reader_beside_the_group(): void {
		$this->seed_group_topology( [ 'tw0', 'tw9' ], 1, 'aggregator', [ 'make_node Remote_Source spoke-x9 lone firehose.p<partition>' ] );

		$decoded = self::list_servers();

		$this->assertSame( [ 'firehose:tw0', 'firehose:tw9', 'spoke-x9' ], \array_column( $decoded, 'id' ) );
		$this->assertSame( 'https://lone.example/', \array_column( $decoded, 'url', 'id' )['spoke-x9'] );
	}

	public function test_list_servers_skips_a_config_vault_id(): void {
		$this->seed_group_topology( [ 'config', 'tw9' ] );

		$this->assertSame( [ 'firehose:tw9' ], \array_column( self::list_servers(), 'id' ) );
	}

	public function test_list_servers_uses_empty_block_on_cache_miss(): void {
		$this->seed_group_topology( [ 'tw9' ] );

		$decoded = self::list_servers();

		$this->assertSame( 'firehose:tw9', $decoded[0]['id'] );
		$this->assertSame( [], $decoded[0]['partitions'][0] );
	}

	public function test_list_servers_reads_every_configured_partition(): void {
		// The remote_partition template carries `<partition>`, so with two
		// partitions the snapshot reads firehose.p0 AND firehose.p1, keyed by
		// partition index.
		$this->seed_group_topology( [ 'tw9' ], 2 );
		self::seed_status( 'tw9', 'firehose.p0', [ 'connected' => true ] );
		self::seed_status( 'tw9', 'firehose.p1', [ 'connected' => false ] );

		$decoded = self::list_servers();

		$this->assertSame( 'firehose:tw9', $decoded[0]['id'] );
		$this->assertSame( [ 0, 1 ], \array_keys( $decoded[0]['partitions'] ) );
		$this->assertTrue( $decoded[0]['partitions'][0]['connected'] );
		$this->assertFalse( $decoded[0]['partitions'][1]['connected'] );
	}

	public function test_list_servers_ignores_non_remote_source_nodes(): void {
		// The rewrite node and the group itself are in the graph too; only the
		// Remote_Source children become snapshot entries.
		$this->seed_group_topology( [ 'tw9' ] );

		$decoded = self::list_servers();

		$this->assertCount( 1, $decoded );
		$this->assertSame( 'firehose:tw9', $decoded[0]['id'] );
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
		$this->seed_group_topology( [] );

		$interpreter = new Aggregator_CI_Node();
		$result      = VerbHarness::fire( $interpreter, 'aggregator', 'summary' );

		$this->assertIsString( $result );
		$decoded = \json_decode( $result, true );
		$this->assertSame( 0, $decoded['connected'] );
		$this->assertSame( 0, $decoded['total'], 'lone and aux sit outside the group' );
		$this->assertIsInt( $decoded['server_now'] );
	}

	public function test_summary_verb_counts_servers_with_at_least_one_connected_partition(): void {
		// tw0 has one connected partition (p0) → counts as 1 connected;
		// tw9 has no connected partitions → counts toward total only.
		$this->seed_group_topology( [ 'tw0', 'tw9' ], 2 );
		self::seed_status( 'tw0', 'firehose.p0', [ 'connected' => true ] );
		self::seed_status( 'tw0', 'firehose.p1', [ 'connected' => false ] );

		$interpreter = new Aggregator_CI_Node();
		$decoded     = \json_decode( VerbHarness::fire( $interpreter, 'aggregator', 'summary' ), true );

		$this->assertSame( 1, $decoded['connected'] );
		$this->assertSame( 2, $decoded['total'] );
	}

	public function test_summary_verb_counts_a_spoke_idle_at_eof_as_up_not_missing(): void {
		// tw0 is streaming; tw5 closed at EOF and is due back. Both are up — a
		// header that read tw5 as missing would alarm an operator about a
		// fleet where nothing is wrong.
		$this->seed_group_topology( [ 'tw0', 'tw5', 'tw9' ] );
		self::seed_status( 'tw0', 'firehose.p0', [ 'connected' => true ] );
		self::seed_status( 'tw5', 'firehose.p0', [ 'connected' => false, 'scheduled_reconnect_at' => \time() + 9 ] );
		self::seed_status( 'tw9', 'firehose.p0', [ 'connected' => false, 'last_error' => 'connection refused 8531' ] );

		$interpreter = new Aggregator_CI_Node();
		$decoded     = \json_decode( VerbHarness::fire( $interpreter, 'aggregator', 'summary' ), true );

		$this->assertSame( 1, $decoded['connected'] );
		$this->assertSame( 1, $decoded['idle'], 'a stream closed at EOF is idle, not down' );
		$this->assertSame( 3, $decoded['total'] );
	}

	public function test_summary_verb_stamps_a_wall_clock_server_now(): void {
		$this->seed_group_topology( [ 'tw9' ] );

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
	// list_servers verb (de-god slice: the heavy per-server partition data)
	//
	// The servers slice carries the full per-server partition snapshot the
	// server cards render. Same discovery + memcache read as `status`, but
	// returned as a SEQUENTIAL ARRAY (the React server-card list maps over it)
	// and encoded as a JSON STRING (SliceViewNode contract).
	// ---------------------------------------------------------------------

	/** The verb is `list_servers`; the noun-first name is refused, not aliased. */
	public function test_servers_status_is_refused_as_an_unknown_command(): void {
		$this->seed_group_topology( [] );

		$result = VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'servers_status' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'unknown command: servers_status', $result );
	}

	public function test_list_servers_verb_returns_empty_array_when_no_remote_sources_wired(): void {
		$this->seed_group_topology( [] );

		$this->assertSame( [], self::list_servers() );
	}

	public function test_list_servers_verb_returns_sequential_array_of_server_snapshots(): void {
		$this->seed_group_topology( [ 'tw9' ] );
		self::seed_status( 'tw9', 'firehose.p0', [ 'connected' => true, 'last_http_code' => 200 ] );

		$decoded = self::list_servers();

		// Sequential array (NOT keyed by node-name) — the card list maps over it.
		$this->assertArrayHasKey( 0, $decoded );
		$this->assertCount( 1, $decoded );
		$this->assertSame( 'firehose:tw9', $decoded[0]['id'] );
		$this->assertSame( 'tw9', $decoded[0]['vault_id'] );
		$this->assertStringStartsWith( 'https://tw9.example', $decoded[0]['url'] );
		$this->assertTrue( $decoded[0]['partitions'][0]['connected'] );
		$this->assertSame( 200, $decoded[0]['partitions'][0]['last_http_code'] );
	}

	public function test_list_servers_verb_rejects_unauthorized(): void {
		$GLOBALS['_wp_test_current_user_can'] = [];
		$result                               = VerbHarness::fire( new Aggregator_CI_Node(), 'aggregator', 'list_servers' );

		$this->assertIsString( $result );
		$this->assertStringContainsString( 'permission denied', $result );
	}

	public function test_slice_verbs_agree_on_the_same_snapshot(): void {
		// summary and list_servers both derive from build_snapshot(), so the
		// header counts must match the server-card list they summarize.
		$this->seed_group_topology( [ 'tw0', 'tw9' ] );
		// Each VerbHarness::fire builds a fresh request-scope graph and Core::reset
		// (which clears Core::$memd) clears its node registry between fires. Re-seed
		// the memcache snapshot + auth before each fire so both verbs read the same
		// snapshot; the seeded topology lives in Topology_Registry and survives.
		$reseed = function (): void {
			Core::$memd = new InMemoryMemcached();
			self::seed_status( 'tw0', 'firehose.p0', [ 'connected' => true ] );
			$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		};

		$reseed();
		$servers_slice = self::list_servers();
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
	// The `summary` / `list_servers` slice handlers derive from build_snapshot(),
	// which reads the substrate `Newspack_Nodes\Vault` singleton directly (no
	// injected registry); the seeded-Vault test proves the dispatched handler
	// actually read the option store, not a fresh/empty view.
	// ---------------------------------------------------------------------

	public function test_node_schema_lists_all_verbs_with_handlers(): void {
		$verbs = [];
		foreach ( Aggregator_CI_Node::node_schema()['commands'] as $verb ) {
			$verbs[ $verb['name'] ] = $verb;
		}

		foreach ( [ 'summary', 'list_servers' ] as $name ) {
			$this->assertArrayHasKey( $name, $verbs, "node_schema must list the '{$name}' verb" );
			$this->assertIsCallable( $verbs[ $name ]['handler'] );
		}
		// The raw `status` / legacy `servers` / `health` verbs were removed — the
		// de-god slices `summary` + `list_servers` are the only live surface.
		foreach ( [ 'status', 'health', 'servers' ] as $removed ) {
			$this->assertArrayNotHasKey( $removed, $verbs, "removed verb '{$removed}' must not be listed" );
		}
	}

	public function test_all_verbs_declare_no_args(): void {
		// summary/list_servers read no $payload/$args — neither handler even
		// declares a $payload param, so each stays args => [].
		$verbs = [];
		foreach ( Aggregator_CI_Node::node_schema()['commands'] as $verb ) {
			$verbs[ $verb['name'] ] = $verb;
		}

		foreach ( [ 'summary', 'list_servers' ] as $name ) {
			$this->assertSame( [], $verbs[ $name ]['args'], "'{$name}' must declare no args" );
		}
	}

	/**
	 * Tachikoma uniform-construction parity: the substrate `make_node` calls
	 * a no-arg ctor. Aggregator_CI reads the Vault singleton directly (no
	 * injected object dep), so a bare `new Aggregator_CI_Node()` dispatches
	 * its verbs against the seeded Vault with no further wiring — the member's
	 * URL proves the handler read the option store.
	 */
	public function test_constructible_via_no_arg_ctor(): void {
		$this->seed_group_topology( [ 'tw9' ] );

		$decoded = self::list_servers();

		$this->assertSame( 'tw9', $decoded[0]['vault_id'] );
		$this->assertStringStartsWith( 'https://tw9.example', $decoded[0]['url'] );
	}

	/**
	 * Catalog-visibility guard (carried over from the ELN ServiceCiHandlerGuardTest
	 * when this CI moved here): a future edit dropping node_schema's `category` to
	 * ''/'Hidden' would silently hide Aggregator_CI from the Inspector/palette while
	 * every other test stayed green. Fire the substrate `classes dump` and assert
	 * the CI surfaces under 'Service'.
	 */
	public function test_appears_in_class_catalog_as_service(): void {
		$result = VerbHarness::fire( new Classes_CI_Node(), 'classes', 'dump' );

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
