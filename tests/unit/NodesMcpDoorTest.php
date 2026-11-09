<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Nodes_Mcp_Door;
use Newspack_Nodes\Tests\Mcp_Requests;
use Newspack_Nodes\Tests\TestCase;

/**
 * The substrate's own MCP door, the cockpit: every command the substrate's
 * service CIs declare is a tool but the seven `NOT_TOOLS` names, and a
 * session sees only the tools its scope covers.
 */
#[CoversClass( Nodes_Mcp_Door::class )]
class NodesMcpDoorTest extends TestCase {

	use Mcp_Requests;

	/** Every tool a manage session is offered, as the design names them. */
	private const COCKPIT = [
		'read'   => [
			'status_get',
			'workers_list', 'workers_dump_graph', 'workers_dump_cleanup', 'workers_inspect',
			'topologies_dump', 'topologies_get', 'topologies_expand',
			'raw_logs_list_logs', 'raw_logs_dump_log', 'raw_logs_read_message',
			'classes_dump', 'settings_get', 'layouts_get',
			'aggregator_summary', 'aggregator_list_servers',
		],
		'tune'   => [ 'settings_set', 'layouts_save' ],
		'manage' => [
			'workers_restart',
			'topologies_save', 'topologies_delete', 'topologies_activate', 'topologies_deactivate',
			'aggregator_probe',
			'vault_list', 'vault_get', 'vault_delete', 'vault_test',
			'sessions_list', 'sessions_revoke',
		],
	];

	protected function setUp(): void {
		parent::setUp();
		$this->use_wpdb_sessions();
		$this->use_in_memory_memcached();
		$GLOBALS['_wp_test_current_user_id']  = 42;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
		\add_action( 'newspack_nodes/request_graph_ready', 'newspack_nodes_mount_substrate_cis' );
	}

	protected function tearDown(): void {
		$this->restore_memcached();
		parent::tearDown();
	}

	/** A cockpit holding a session of `$scope` open, and its bearer. */
	private function door( string $scope ): array {
		[ , $bearer ] = $this->session( $scope );
		$door         = new Nodes_Mcp_Door();
		$door->check_permission( $this->request( [], $bearer ) );
		return [ $door, $bearer ];
	}

	/**
	 * The tool names a session of `$scope` is offered, sorted.
	 *
	 * @return list<string>
	 */
	private function listed_names( string $scope ): array {
		[ $door, $bearer ] = $this->door( $scope );
		$names             = \array_keys( $this->listed( $door, $bearer ) );
		\sort( $names );
		return $names;
	}

	/**
	 * Every role's tools, sorted, up to and including `$role`.
	 *
	 * @return list<string>
	 */
	private static function cockpit_through( string $role ): array {
		$tools = [];
		foreach ( self::COCKPIT as $level => $names ) {
			\array_push( $tools, ...$names );
			if ( $level === $role ) {
				break;
			}
		}
		\sort( $tools );
		return $tools;
	}

	/**
	 * The tool names `NOT_TOOLS` keeps from the cockpit, `<mount>_<verb>`.
	 *
	 * @return list<string>
	 */
	private static function excluded(): array {
		$tools = [];
		foreach ( Nodes_Mcp_Door::NOT_TOOLS as $mount => $verbs ) {
			foreach ( $verbs as $verb ) {
				$tools[] = \str_replace( '-', '_', $mount ) . '_' . $verb;
			}
		}
		return $tools;
	}

	/** A manage session is offered the thirty tools the design names. */
	public function test_a_manage_session_sees_the_thirty_cockpit_tools(): void {
		$listed = $this->listed_names( Capabilities::MANAGE );

		$this->assertSame( self::cockpit_through( Capabilities::MANAGE ), $listed );
		$this->assertCount( 30, $listed );
	}

	/** A scope sees the tools its role covers: read 16, tune 18. */
	public function test_a_read_session_sees_16_tools_and_a_tune_session_18(): void {
		$read = $this->listed_names( Capabilities::READ );
		$tune = $this->listed_names( Capabilities::TUNE );

		$this->assertSame( self::cockpit_through( Capabilities::READ ), $read );
		$this->assertCount( 16, $read );
		$this->assertSame( self::cockpit_through( Capabilities::TUNE ), $tune );
		$this->assertCount( 18, $tune );
	}

	/** No exclusion is listed to a manage session, or callable by one. */
	public function test_no_excluded_command_is_listed_or_callable(): void {
		[ $door, $bearer ] = $this->door( Capabilities::MANAGE );
		$listed            = $this->listed( $door, $bearer );

		foreach ( [ ...self::excluded(), 'vault_add', 'vault_update' ] as $tool ) {
			$this->assertArrayNotHasKey( $tool, $listed );
			$this->assertSame(
				[ 'code' => -32601, 'message' => "Unknown tool: {$tool}" ],
				$this->call( $door, $bearer, $tool, [] )['error'] ?? null,
				$tool
			);
		}
	}

	/** A read grant can neither see nor call a manage tool. */
	public function test_a_read_session_cannot_call_a_manage_tool(): void {
		[ $door, $bearer ] = $this->door( Capabilities::READ );

		$this->assertArrayNotHasKey( 'workers_restart', $this->listed( $door, $bearer ) );
		$this->assertSame(
			[ 'code' => -32601, 'message' => 'Unknown tool: workers_restart' ],
			$this->call( $door, $bearer, 'workers_restart', [ 'types' => 'job-worker' ] )['error'] ?? null
		);
	}

	/** A manage tool runs its command: `sessions_revoke` ends the session it names. */
	public function test_a_manage_tool_reaches_its_command(): void {
		$victim = Command_Auth::mint_session( Capabilities::READ, 600 )['handle'];
		$this->assertNotNull( Command_Auth::load_session_record( $victim ) );
		[ $door, $bearer ] = $this->door( Capabilities::MANAGE );

		$reply = $this->call( $door, $bearer, 'sessions_revoke', [ 'id' => $victim ] );

		$this->assertArrayNotHasKey( 'isError', $reply['result'] ?? [], \wp_json_encode( $reply ) );
		$this->assertNull( Command_Auth::load_session_record( $victim ) );
	}

	/** The cockpit names itself at the version it ships, and serves its own resource. */
	public function test_the_door_names_its_server_and_resource(): void {
		[ $door, $bearer ] = $this->door( Capabilities::READ );

		$reply = $door->dispatch( $this->request( [ 'jsonrpc' => '2.0', 'id' => 1, 'method' => 'initialize' ], $bearer ) );

		$this->assertSame( [ 'name' => 'newspack-nodes', 'version' => \NEWSPACK_NODES_VERSION ], $reply['result']['serverInfo'] );
		$this->assertStringEndsWith( '/wp-json/newspack-nodes/v1/mcp', $door->resource() );
	}

	/** Loading the plugin wires the cockpit: its route on `rest_api_init`, and its resource. */
	public function test_the_plugin_wires_the_cockpit(): void {
		$GLOBALS['_wp_test_registered_routes'] = [];

		\do_action( 'rest_api_init' );

		$routes = \array_map( static fn ( array $r ): string => $r['namespace'] . $r['route'], $GLOBALS['_wp_test_registered_routes'] );
		$this->assertContains( 'newspack-nodes/v1/mcp', $routes );
		$this->assertContains( ( new Nodes_Mcp_Door() )->resource(), \apply_filters( 'newspack_nodes/oauth_resources', [] ) );
	}

	/** The instructions, served once, name the tools that change the running fleet. */
	public function test_the_caveat_names_the_fleet_changing_tools(): void {
		[ $door, $bearer ] = $this->door( Capabilities::READ );

		$instructions = $door->dispatch( $this->request( [ 'jsonrpc' => '2.0', 'id' => 2, 'method' => 'initialize' ], $bearer ) )['result']['instructions'];

		foreach ( [ 'workers_restart', 'topologies_activate', 'topologies_delete', 'sessions_revoke', 'vault_delete' ] as $tool ) {
			$this->assertStringContainsString( $tool, $instructions );
		}
	}

	/** Each tool description closes on the caveat, one clause long. */
	public function test_every_description_closes_on_the_one_clause_caveat(): void {
		[ $door, $bearer ] = $this->door( Capabilities::MANAGE );

		foreach ( $this->listed( $door, $bearer ) as $name => $tool ) {
			$this->assertStringEndsWith( ' — The manage tools change the running fleet, so call them only on the operator\'s own request.', $tool['description'], $name );
		}
	}

	/** The glossary names what `workers_inspect` reaches and the states a partition reports. */
	public function test_the_instructions_carry_a_glossary(): void {
		[ $door, $bearer ] = $this->door( Capabilities::READ );

		$instructions = $door->dispatch( $this->request( [ 'jsonrpc' => '2.0', 'id' => 3, 'method' => 'initialize' ], $bearer ) )['result']['instructions'];

		$this->assertStringContainsString( '`<type>.p<n>`', $instructions );
		$this->assertStringContainsString( 'workers_inspect', $instructions );
		foreach ( [ 'live', 'stale', 'down', 'idle', 'held', 'inactive' ] as $state ) {
			$this->assertStringContainsString( "`{$state}`", $instructions );
		}
	}
}
