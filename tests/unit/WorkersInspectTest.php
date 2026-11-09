<?php
/**
 * `workers inspect`: one read-only interpreter command run inside a live
 * worker over its command channel, the round trip `wp nodes tables` makes.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Rest\Workers_CI_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Table_Node;
use Newspack_Nodes\Tests\Answers_Worker_Channel;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Registry;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Workers_CI_Node::class )]
#[CoversClass( CLI::class )]
final class WorkersInspectTest extends TestCase {
	use Answers_Worker_Channel;

	private string $base = '';

	private ?\Closure $saved_curl_exec = null;

	protected function setUp(): void {
		parent::setUp();
		$this->base = $this->make_temp_dir( 'workers-inspect-' );
		$this->use_base_dir( $this->base );
		$this->use_wpdb();
		$this->use_loop_time();
		Topology_Registry::reset();
		Config::reset();
		$this->saved_curl_exec                = Core::$curl_exec;
		$GLOBALS['_wp_test_current_user_can'] = [ 'manage_options' => true ];
	}

	protected function tearDown(): void {
		Core::$curl_exec = $this->saved_curl_exec;
		\delete_option( 'newspack_nodes_topologies' );
		Config::reset();
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->base );
		parent::tearDown();
	}

	private function ci(): Workers_CI_Node {
		$ci      = new Workers_CI_Node();
		$ci->cli = new CLI( $this->base );
		return $ci;
	}

	/** A node inside the fake worker whose dump names it. */
	private function kea_node(): Node {
		$node = new Capture_Sink_Node();
		$node->name( 'kea-node-5531' );
		return $node;
	}

	/** The request graph a `/command` or MCP request already holds. */
	private function request_graph(): Command_Interpreter_Node {
		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( Node_Names::COMMAND_INTERPRETER );
		$interpreter->sink( $router );
		return $interpreter;
	}

	public function test_inspect_answers_the_workers_reply(): void {
		$this->answer_channel( 'kea-7', 0 );
		$this->kea_node();
		$expected = $this->request_graph()->dispatch( 'dump_node', [ 'kea-node-5531' ] );

		$reply = $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'dump_node', 'kea-node-5531' ] );

		$this->assertSame( $expected, $reply );
		$this->assertStringContainsString( 'kea-node-5531', $reply );
		$this->assertSame( [ ' dump_node' ], $this->answered, 'the worker took it as addressed to its own interpreter' );
	}

	public function test_inspect_addresses_a_path_inside_the_worker(): void {
		$this->answer_channel( 'kea-7', 0 );
		Core::$var['partition'] = '0';
		try {
			$table = new Table_Node();
			$table->name( 'kea-node' );
			$table->arguments( [ 'kea:p0', '777', 'sqlite' ] );
		} finally {
			unset( Core::$var['partition'] );
		}
		$table->sink( new Capture_Sink_Node() );

		$reply = $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'stats', '--path=kea-node:config' ] );

		$this->assertSame( [ 'kea-node:config stats' ], $this->answered );
		$this->assertIsArray( $reply );
		$this->assertArrayHasKey( 'GET', $reply );
	}

	public function test_inspect_refuses_rm_and_RM_and_a_padded_ls(): void {
		$this->answer_channel( 'kea-7', 0 );
		foreach ( [ 'rm', 'RM', 'ls ' ] as $verb ) {
			$e = $this->caught( fn () => $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', $verb, 'kea-node-5531' ] ), "{$verb} was sent" );
			$this->assertSame( "inspect sends only read commands; {$verb} is not one", $e->getMessage() );
		}
		$this->assertSame( [], $this->answered );
		$this->assertNull( Core::node( 'kea-7.p0' ), 'no channel was opened' );
	}

	public function test_inspect_of_an_unknown_worker_is_refused(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( "no worker 'ghost-4417.p3'" );

		$this->ci()->dispatch( 'inspect', [ 'ghost-4417.p3', 'uptime' ] );
	}

	public function test_inspect_of_a_silent_worker_times_out_by_name(): void {
		$this->answer_channel( 'kea-7', 0, false );
		$started = Core::right_now();

		$e = $this->caught( fn () => $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'uptime' ] ), 'a silent worker answered' );

		$this->assertSame( 'kea-7.p0 did not answer uptime within 5 s; a command whose answer is empty sends none', $e->getMessage() );
		$this->assertSame( [ ' uptime' ], $this->answered, 'the command reached the worker' );
		$this->assertGreaterThanOrEqual( Workers_CI_Node::INSPECT_TIMEOUT_S, Core::right_now() - $started );
	}

	public function test_inspect_throws_the_workers_refusal(): void {
		$this->answer_channel( 'kea-7', 0 );

		$e = $this->caught( fn () => $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'dump_node', 'ghost-node-9031' ] ), 'a refusal answered' );

		$this->assertSame( \esc_html( 'can\'t find node "ghost-node-9031"' ), $e->getMessage(), 'as the worker threw it' );
	}

	public function test_inspect_throws_the_routers_bounce_for_a_missing_path(): void {
		$this->answer_channel( 'kea-7', 0 );

		$e = $this->caught( fn () => $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'stats', '--path=ghost-node-6620:config' ] ), 'a bounce answered' );

		$this->assertSame( 'NOT_AVAILABLE', $e->getMessage() );
	}

	public function test_inspect_removes_every_node_it_built(): void {
		$this->answer_channel( 'kea-7', 0 );
		$this->kea_node();
		$this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'dump_node', 'kea-node-5531' ] );
		$this->caught( fn () => $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'dump_node', 'ghost-node-9031' ] ), 'a refusal answered' );

		foreach ( [ 'kea-7.p0', 'kea-7.p0:replies', 'workers-inspect', Node_Names::ROUTER, Node_Names::COMMAND_INTERPRETER ] as $name ) {
			$this->assertNull( Core::node( $name ), "{$name} outlived the inspect" );
		}
	}

	public function test_inspect_of_a_silent_worker_removes_every_node_it_built(): void {
		$this->answer_channel( 'kea-7', 0, false );
		$this->caught( fn () => $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'uptime' ] ), 'a silent worker answered' );

		foreach ( [ 'kea-7.p0', 'kea-7.p0:replies', 'workers-inspect', Node_Names::ROUTER ] as $name ) {
			$this->assertNull( Core::node( $name ), "{$name} outlived the inspect" );
		}
	}

	public function test_inspect_rides_a_request_graph_already_mounted_and_leaves_it(): void {
		$this->answer_channel( 'kea-7', 0 );
		$this->kea_node();
		$interpreter = $this->request_graph();
		$router      = Core::node( Node_Names::ROUTER );

		$reply = $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'dump_node', 'kea-node-5531' ] );

		$this->assertStringContainsString( 'kea-node-5531', $reply );
		$this->assertSame( $router, Core::node( Node_Names::ROUTER ) );
		$this->assertSame( $interpreter, Core::node( Node_Names::COMMAND_INTERPRETER ) );
		$this->assertNull( Core::node( 'kea-7.p0' ) );
	}

	public function test_inspect_of_a_sleeping_worker_wakes_it(): void {
		$posts           = [];
		Core::$curl_exec = static function ( \CurlHandle $ch, array $body ) use ( &$posts ) {
			$posts[] = $body;
			return '';
		};
		\add_filter(
			'newspack_nodes/topologies',
			static fn ( array $t ): array => $t + [
				'marmot-ondemand' => [
					'topology'       => 'marmot-ondemand',
					'num_partitions' => 1,
					'on_demand_idle' => 23,
				],
			]
		);
		\update_option( 'newspack_nodes_topologies', [ 'marmot-ondemand' ] );
		Config::reset();

		$e = $this->caught( fn () => $this->ci()->dispatch( 'inspect', [ 'marmot-ondemand.p0', 'uptime' ] ), 'a sleeping worker answered at once' );

		$this->assertSame( 'marmot-ondemand.p0 did not answer uptime within 5 s; a command whose answer is empty sends none', $e->getMessage(), 'woken, not refused' );
		$this->assertSame( [ 'marmot-ondemand.p0' ], \array_map( static fn ( array $b ): string => $b['type'] . '.p' . $b['partition'], $posts ) );
	}

	public function test_inspect_declares_read_and_sends_only_read_verbs(): void {
		$this->assertSame( Capabilities::READ, Command_Interpreter_Node::declared_commands( Workers_CI_Node::class )['inspect']['capability'] );
		$this->assertSame( Capabilities::READ, Command_Interpreter_Node::base_role( 'uptime' ) );
		$this->assertSame( Capabilities::MANAGE, Command_Interpreter_Node::base_role( 'rm' ) );
	}

	public function test_inspect_refuses_a_path_naming_a_node_that_is_not_a_config_interpreter(): void {
		$this->answer_channel( 'kea-7', 0 );
		$sink = new Capture_Sink_Node();
		$sink->name( 'kea-sink-8840' );
		foreach ( [ 'kea-sink-8840', 'kea-sink-8840/x:config', ':config', 'kea-sink-8840:configs' ] as $path ) {
			$e = $this->caught( fn () => $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'uptime', "--path={$path}" ] ), "{$path} was addressed" );
			$this->assertSame( "inspect addresses only the worker interpreter or a :config interpreter inside it; {$path} is neither", $e->getMessage() );
		}
		$this->assertSame( [], $sink->captured, 'the sink took no command' );
		$this->assertSame( [], $this->answered );
		$this->assertNull( Core::node( 'kea-7.p0' ), 'no channel was opened' );
	}

	public function test_a_late_reply_to_an_earlier_ask_is_not_the_next_asks_answer(): void {
		$this->answer_channel( 'kea-7', 0 );
		$this->late = true;
		$this->caught( fn () => $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'uptime' ] ), 'the first ask was answered on time' );

		$e = $this->caught( fn () => $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'uptime' ] ), 'the first ask\'s late answer was taken for the second\'s' );

		$this->assertSame( 'kea-7.p0 did not answer uptime within 5 s; a command whose answer is empty sends none', $e->getMessage() );
		$this->assertCount( 2, $this->asked_from );
		$this->assertNotSame( $this->asked_from[0], $this->asked_from[1], 'each ask heads its own replies' );
		$this->assertMatchesRegularExpression( '#^_output/_cli:' . \getmypid() . '-[0-9a-f]{12}/workers-inspect/reply$#', $this->asked_from[1] );
	}

	public function test_a_channel_half_built_when_a_name_collides_leaves_nothing_named(): void {
		$this->answer_channel( 'kea-7', 0 );
		$squatter = new Capture_Sink_Node();
		$squatter->name( 'kea-7.p0:replies' );

		$this->caught( fn () => $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'uptime' ] ), 'a squatted gate name was built over' );

		$this->assertNull( Core::node( 'kea-7.p0' ), 'the input Partition outlived the throw' );
		$this->assertNull( Core::node( 'kea-7.p0:config' ), "the Partition's :config outlived the throw" );
		$this->assertSame( $squatter, Core::node( 'kea-7.p0:replies' ) );
		$this->assertSame( [], $this->answered );
	}

	public function test_inspect_rides_a_worker_input_an_earlier_command_mounted_and_leaves_it(): void {
		$this->answer_channel( 'kea-7', 0 );
		$this->kea_node();
		$this->request_graph();
		$this->assertTrue( Bootstrap::register_worker_partition( 'kea-7.p0', $this->base ) );
		$mounted = Core::node( 'kea-7.p0' );
		$this->assertInstanceOf( Partition_Node::class, $mounted );

		$reply = $this->ci()->dispatch( 'inspect', [ 'kea-7.p0', 'dump_node', 'kea-node-5531' ] );

		$this->assertStringContainsString( 'kea-node-5531', $reply );
		$this->assertSame( $mounted, Core::node( 'kea-7.p0' ), 'the mount stands for the rest of the POST' );
		$this->assertNull( Core::node( 'kea-7.p0:replies' ) );
	}

	public function test_refusal_reads_a_refused_reply_and_answers_null_for_an_answer(): void {
		$answer                   = Message::new_message();
		$answer[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_RESPONSE;
		$answer[ Message::VALUE ] = [ 'name' => 'uptime', 'arguments' => [], 'payload' => "kea-up-4410\n" ];
		$refused                  = $answer;
		$refused[ Message::TYPE ] = Message::TM_COMMAND | Message::TM_ERROR;
		$bounce                   = Message::new_message();
		$bounce[ Message::TYPE ]  = Message::TM_ERROR;
		$bounce[ Message::VALUE ] = "NOT_AVAILABLE\n";

		$this->assertNull( CLI::refusal( $answer ) );
		$this->assertSame( 'kea-up-4410', CLI::refusal( $refused ) );
		$this->assertSame( 'NOT_AVAILABLE', CLI::refusal( $bounce ) );
	}

	public function test_a_refusal_with_no_text_still_names_itself(): void {
		$blank                   = Message::new_message();
		$blank[ Message::TYPE ]  = Message::TM_COMMAND | Message::TM_ERROR;
		$blank[ Message::VALUE ] = [ 'name' => 'uptime', 'arguments' => [], 'payload' => " \n" ];

		$this->assertSame( 'refused', CLI::refusal( $blank ) );
	}
}
