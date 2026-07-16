<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Core;
use Newspack_Nodes\Topology_Loader;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

class TopologyLoaderTest extends TestCase {

	private string $stock;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->stock = $this->make_temp_dir( 'tsl-load-' );
		Topology_Registry::register_stock_dir( $this->stock );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->stock );
		Topology_Registry::reset();
		parent::tearDown();
	}

	private function write_tsl( string $name, string $body ): void {
		\file_put_contents( "{$this->stock}/{$name}.tsl", $body );
	}

	public function test_load_builds_graph_from_tsl_script(): void {
		$this->write_tsl(
			'two-nodes',
			"make_node Capture_Sink alice\nmake_node Capture_Sink bob\nconnect_node alice bob\n"
		);

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );

		Topology_Loader::load( 'two-nodes', 0, $interpreter );

		$this->assertNotNull( Core::node( 'alice' ) );
		$this->assertNotNull( Core::node( 'bob' ) );
	}

	public function test_load_suppresses_command_replies(): void {
		// The boot topology has no console to reply to; every successful command's
		// reply would otherwise route TO=`_output/<pid>`, dead-end on the absent
		// `_output`, and bounce a dropped NOT_AVAILABLE. The loader runs the Shell
		// with want_reply off, so the interpreter emits nothing downstream.
		$this->write_tsl(
			'replyless',
			"make_node Capture_Sink alice\nmake_node Capture_Sink bob\n"
		);

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$sink = new Capture_Sink_Node();
		$interpreter->sink( $sink );

		Topology_Loader::load( 'replyless', 0, $interpreter );

		$this->assertNotNull( Core::node( 'alice' ), 'graph still builds' );
		$this->assertCount( 0, $sink->captured, 'no command replies bounce at boot' );
	}

	public function test_load_builds_graph_under_worker_verifier_policy(): void {
		// Regression: a worker installs the HMAC verifier as the process-wide
		// authorize policy, THEN loads its topology in-process via Shell. The
		// Shell stamps LOCAL (no HMAC); the verifier must accept LOCAL-tainted
		// in-process commands or the worker boots with an empty graph.
		\Newspack_Nodes\Command_Interpreter_Node::$default_authorize = \Newspack_Nodes\Command_Auth::verifier();
		$this->write_tsl(
			'verified',
			"make_node Capture_Sink alice\nmake_node Capture_Sink bob\nconnect_node alice bob\n"
		);

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );

		Topology_Loader::load( 'verified', 0, $interpreter );

		$this->assertNotNull( Core::node( 'alice' ), 'verifier process must build its own topology' );
		$this->assertNotNull( Core::node( 'bob' ) );
	}

	public function test_load_interpolates_partition_via_angle_bracket(): void {
		$this->write_tsl(
			'parted',
			"make_node Capture_Sink consumer-p<partition>\n"
		);

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );

		Topology_Loader::load( 'parted', 7, $interpreter );

		$this->assertNotNull( Core::node( 'consumer-p7' ) );
	}

	public function test_load_interpolates_config_namespace(): void {
		$this->write_tsl(
			'configed',
			"make_node Capture_Sink node-<config:env_label>\n"
		);

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );

		// `<config:env_label>` resolves through the registered `config` namespace
		// resolver, not a per-call array. Snapshot/restore around a custom one.
		$saved = Core::$config_resolvers;
		Core::register_config_namespace( 'config', static fn ( string $k ) => 'env_label' === $k ? 'prod' : null );
		try {
			Topology_Loader::load( 'configed', 0, $interpreter );
			$this->assertNotNull( Core::node( 'node-prod' ) );
		} finally {
			Core::$config_resolvers = $saved;
		}
	}

	public function test_load_unknown_config_key_expands_to_empty_string(): void {
		// Shell's interpolate-then-expand-empty policy applies — an unknown
		// `<config:foo>` resolves to ''. The loader doesn't pre-validate.
		$this->write_tsl( 'unknown', "make_node Capture_Sink node-<config:nope>\n" );

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );

		$saved = Core::$config_resolvers;
		Core::register_config_namespace( 'config', static fn ( string $k ) => null );
		try {
			Topology_Loader::load( 'unknown', 0, $interpreter );
			$this->assertNotNull( Core::node( 'node-' ) );
		} finally {
			Core::$config_resolvers = $saved;
		}
	}

	public function test_load_skips_blank_lines_and_comments(): void {
		$this->write_tsl(
			'comments',
			"# header comment\n\nmake_node Capture_Sink alice\n\n# trailing comment\n"
		);

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );

		Topology_Loader::load( 'comments', 0, $interpreter );

		$this->assertNotNull( Core::node( 'alice' ) );
	}

	public function test_load_supports_var_frontmatter_and_semicolons(): void {
		// Frontmatter `var` lines populate Core::$var so subsequent
		// statements (and supervisor-side metadata reads) can pick
		// them up. Semicolons separate statements on a single line.
		$this->write_tsl(
			'frontmatter',
			"var num_partitions = 4; var stale_timeout = 60\nmake_node Capture_Sink leader-p<partition>"
		);

		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );

		Topology_Loader::load( 'frontmatter', 0, $interpreter );

		$this->assertSame( '4', Core::$var['num_partitions'] );
		$this->assertSame( '60', Core::$var['stale_timeout'] );
		$this->assertNotNull( Core::node( 'leader-p0' ) );
	}

	public function test_load_throws_when_topology_not_found(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( new Capture_Sink_Node() );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'no-such-topology' );
		Topology_Loader::load( 'no-such-topology', 0, $interpreter );
	}

	/**
	 * `<topology>` names the FLEET. An offsetlog is a reader's cursor, and the
	 * reader is the fleet — two processes tailing one log need two cursors. The
	 * token lets request-builder.tsl and job-router.tsl declare BYTE-IDENTICAL
	 * Consumer lines (so `combined` dedupes them into one reader) while each
	 * standalone fleet still gets its own offsetlog.
	 */
	public function test_binds_the_topology_name_for_the_topology_token(): void {
		$this->write_tsl(
			'zebra-top',
			"make_node Consumer zebra:consumer /logs/z.p<partition> /offsets/z.<topology>.p<partition>\n"
		);

		$sink = new Capture_Sink_Node();
		Topology_Loader::load( 'zebra-top', 3, $sink );

		$lines = [];
		foreach ( $sink->captured as $message ) {
			$value = $message[ Message::VALUE ];
			if ( \is_array( $value ) && isset( $value['name'] ) ) {
				$lines[] = \trim( $value['name'] . ' ' . \implode( ' ', $value['arguments'] ?? [] ) );
			}
		}

		$this->assertContains(
			'make_node Consumer zebra:consumer /logs/z.p3 /offsets/z.zebra-top.p3',
			$lines
		);
	}
}
