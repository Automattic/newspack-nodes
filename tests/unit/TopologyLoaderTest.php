<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Topology_Loader;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\CaptureSink;
use Newspack_Nodes\Tests\TestCase;

class TopologyLoaderTest extends TestCase {

	private string $stock;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->stock = $this->make_temp_dir( 'tsl-load-' );
		Topology_Registry::register_stock_dir( $this->stock );
		Command_Interpreter_Node::register_class( 'CaptureSink', CaptureSink::class );
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
			"make_node CaptureSink alice\nmake_node CaptureSink bob\nconnect_node alice bob\n"
		);

		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		Topology_Loader::load( 'two-nodes', 0, $ci );

		$this->assertNotNull( Core::node( 'alice' ) );
		$this->assertNotNull( Core::node( 'bob' ) );
	}

	public function test_load_builds_graph_under_worker_verifier_policy(): void {
		// Regression: a worker installs the HMAC verifier as the process-wide
		// authorize policy, THEN loads its topology in-process via Shell. The
		// Shell stamps LOCAL (no HMAC); the verifier must accept LOCAL-tainted
		// in-process commands or the worker boots with an empty graph.
		\Newspack_Nodes\Command_Interpreter_Node::$default_authorize = \Newspack_Nodes\Command_Auth::verifier();
		$this->write_tsl(
			'verified',
			"make_node CaptureSink alice\nmake_node CaptureSink bob\nconnect_node alice bob\n"
		);

		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		Topology_Loader::load( 'verified', 0, $ci );

		$this->assertNotNull( Core::node( 'alice' ), 'verifier process must build its own topology' );
		$this->assertNotNull( Core::node( 'bob' ) );
	}

	public function test_load_interpolates_partition_via_angle_bracket(): void {
		$this->write_tsl(
			'parted',
			"make_node CaptureSink consumer-p<partition>\n"
		);

		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		Topology_Loader::load( 'parted', 7, $ci );

		$this->assertNotNull( Core::node( 'consumer-p7' ) );
	}

	public function test_load_interpolates_config_namespace(): void {
		$this->write_tsl(
			'configed',
			"make_node CaptureSink node-<config:env_label>\n"
		);

		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		Topology_Loader::load( 'configed', 0, $ci, [ 'env_label' => 'prod' ] );

		$this->assertNotNull( Core::node( 'node-prod' ) );
	}

	public function test_load_unknown_config_key_expands_to_empty_string(): void {
		// Shell's interpolate-then-expand-empty policy applies — unknown
		// `<config:foo>` becomes ''. The loader doesn't pre-validate.
		$this->write_tsl( 'unknown', "make_node CaptureSink node-<config:nope>\n" );

		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		Topology_Loader::load( 'unknown', 0, $ci, [] );
		$this->assertNotNull( Core::node( 'node-' ) );
	}

	public function test_load_skips_blank_lines_and_comments(): void {
		$this->write_tsl(
			'comments',
			"# header comment\n\nmake_node CaptureSink alice\n\n# trailing comment\n"
		);

		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		Topology_Loader::load( 'comments', 0, $ci );

		$this->assertNotNull( Core::node( 'alice' ) );
	}

	public function test_load_supports_var_frontmatter_and_semicolons(): void {
		// Frontmatter `var` lines populate Core::$var so subsequent
		// statements (and supervisor-side metadata reads) can pick
		// them up. Semicolons separate statements on a single line.
		$this->write_tsl(
			'frontmatter',
			"var num_partitions = 4; var stale_timeout = 60\nmake_node CaptureSink leader-p<partition>"
		);

		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		Topology_Loader::load( 'frontmatter', 0, $ci );

		$this->assertSame( '4', Core::$var['num_partitions'] );
		$this->assertSame( '60', Core::$var['stale_timeout'] );
		$this->assertNotNull( Core::node( 'leader-p0' ) );
	}

	public function test_load_throws_when_topology_not_found(): void {
		$ci = new Command_Interpreter_Node();
		$ci->name( '_command_interpreter' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'no-such-topology' );
		Topology_Loader::load( 'no-such-topology', 0, $ci );
	}
}
