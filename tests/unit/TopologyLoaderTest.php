<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CommandInterpreter;
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
		CommandInterpreter::register_class( 'CaptureSink', CaptureSink::class );
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

		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		Topology_Loader::load( 'two-nodes', 0, $ci );

		$this->assertNotNull( Core::node( 'alice' ) );
		$this->assertNotNull( Core::node( 'bob' ) );
	}

	public function test_load_substitutes_partition_token(): void {
		$this->write_tsl(
			'parted',
			"make_node CaptureSink consumer-p{partition}\n"
		);

		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		Topology_Loader::load( 'parted', 7, $ci );

		$this->assertNotNull( Core::node( 'consumer-p7' ) );
	}

	public function test_load_substitutes_config_vars(): void {
		$this->write_tsl(
			'configed',
			"make_node CaptureSink node-{config:env_label}\n"
		);

		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		Topology_Loader::load( 'configed', 0, $ci, [ 'env_label' => 'prod' ] );

		$this->assertNotNull( Core::node( 'node-prod' ) );
	}

	public function test_load_skips_blank_lines_and_comments(): void {
		$this->write_tsl(
			'comments',
			"# header comment\n\nmake_node CaptureSink alice\n\n# trailing comment\n"
		);

		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		Topology_Loader::load( 'comments', 0, $ci );

		$this->assertNotNull( Core::node( 'alice' ) );
	}

	public function test_load_throws_when_topology_not_found(): void {
		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'no-such-topology' );
		Topology_Loader::load( 'no-such-topology', 0, $ci );
	}

	public function test_load_throws_on_unknown_substitution_key(): void {
		$this->write_tsl( 'bad', "make_node CaptureSink {config:nope}\n" );

		$ci = new CommandInterpreter();
		$ci->name( '_command_interpreter' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'nope' );
		Topology_Loader::load( 'bad', 0, $ci, [] );
	}
}
