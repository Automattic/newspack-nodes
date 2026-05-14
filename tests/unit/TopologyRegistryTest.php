<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

class TopologyRegistryTest extends TestCase {

	private string $stock;
	private string $user;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->stock = $this->make_temp_dir( 'tsl-stock-' );
		$this->user  = $this->make_temp_dir( 'tsl-user-' );
		\file_put_contents( "{$this->stock}/firehose-workers.tsl", '' );
		\file_put_contents( "{$this->user}/firehose-workers.tsl", '' );
		\file_put_contents( "{$this->stock}/only-stock.tsl", '' );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->stock );
		$this->rmdir_recursive( $this->user );
		Topology_Registry::reset();
		parent::tearDown();
	}

	public function test_resolve_returns_stock_when_no_user_override(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::set_user_dir( $this->user );

		$this->assertSame( "{$this->stock}/only-stock.tsl", Topology_Registry::resolve( 'only-stock' ) );
	}

	public function test_resolve_prefers_user_dir_over_stock(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::set_user_dir( $this->user );

		$this->assertSame(
			"{$this->user}/firehose-workers.tsl",
			Topology_Registry::resolve( 'firehose-workers' )
		);
	}

	public function test_resolve_returns_null_for_unknown_topology(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::set_user_dir( $this->user );

		$this->assertNull( Topology_Registry::resolve( 'no-such-topology' ) );
	}

	public function test_list_unions_stock_and_user_topologies(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::set_user_dir( $this->user );
		\file_put_contents( "{$this->user}/only-user.tsl", '' );

		$names = Topology_Registry::list();
		\sort( $names );
		$this->assertSame( [ 'firehose-workers', 'only-stock', 'only-user' ], $names );
	}

	public function test_frontmatter_extracts_var_lines(): void {
		\file_put_contents(
			"{$this->stock}/aggregator.tsl",
			"# header\nvar num_partitions = 1\nvar stale_timeout = 600;\nmake_node Topic firehose:topic foo bar baz\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );
		$frontmatter = Topology_Registry::frontmatter( 'aggregator' );
		$this->assertSame(
			[ 'num_partitions' => '1', 'stale_timeout' => '600' ],
			$frontmatter
		);
	}

	public function test_frontmatter_returns_empty_for_unknown_topology(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		$this->assertSame( [], Topology_Registry::frontmatter( 'no-such-topology' ) );
	}

	public function test_multiple_stock_dirs_first_wins(): void {
		$second = $this->make_temp_dir( 'tsl-stock-2-' );
		\file_put_contents( "{$second}/only-stock.tsl", '' );
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_stock_dir( $second );
		Topology_Registry::set_user_dir( $this->user );

		$this->assertSame(
			"{$this->stock}/only-stock.tsl",
			Topology_Registry::resolve( 'only-stock' )
		);
		$this->rmdir_recursive( $second );
	}
}
