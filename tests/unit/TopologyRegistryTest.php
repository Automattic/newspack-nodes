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
		Topology_Registry::register_user_dir( $this->user );

		$this->assertSame( "{$this->stock}/only-stock.tsl", Topology_Registry::resolve( 'only-stock' ) );
	}

	public function test_resolve_prefers_user_dir_over_stock(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );

		$this->assertSame(
			"{$this->user}/firehose-workers.tsl",
			Topology_Registry::resolve( 'firehose-workers' )
		);
	}

	public function test_resolve_returns_null_for_unknown_topology(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );

		$this->assertNull( Topology_Registry::resolve( 'no-such-topology' ) );
	}

	public function test_list_unions_stock_and_user_topologies(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );
		\file_put_contents( "{$this->user}/only-user.tsl", '' );

		$names = Topology_Registry::list();
		\sort( $names );
		$this->assertSame( [ 'firehose-workers', 'only-stock', 'only-user' ], $names );
	}

	public function test_list_ignores_tsl_named_directories(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );
		\mkdir( "{$this->stock}/stock-directory.tsl" );
		\mkdir( "{$this->user}/user-directory.tsl" );

		$names = Topology_Registry::list();
		\sort( $names );

		$this->assertSame( [ 'firehose-workers', 'only-stock' ], $names );
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

	public function test_synthesize_entry_reads_frontmatter_vars(): void {
		\file_put_contents(
			"{$this->stock}/aggregator.tsl",
			"var num_partitions = 3\nvar stale_timeout = 120\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[
				'topology'       => 'aggregator',
				'num_partitions' => 3,
				'stale_timeout'  => 120,
			],
			Topology_Registry::synthesize_entry( 'aggregator' )
		);
	}

	public function test_synthesize_entry_uses_caller_defaults_when_frontmatter_silent(): void {
		\file_put_contents( "{$this->stock}/quiet.tsl", "# no var lines\n" );
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[
				'topology'       => 'quiet',
				'num_partitions' => 4,
				'stale_timeout'  => 99,
			],
			Topology_Registry::synthesize_entry( 'quiet', 4, 99 )
		);
	}

	public function test_synthesize_entry_returns_null_for_missing_tsl(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		$this->assertNull( Topology_Registry::synthesize_entry( 'no-such-topology' ) );
	}

	public function test_multiple_stock_dirs_first_wins(): void {
		$second = $this->make_temp_dir( 'tsl-stock-2-' );
		\file_put_contents( "{$second}/only-stock.tsl", '' );
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_stock_dir( $second );
		Topology_Registry::register_user_dir( $this->user );

		$this->assertSame(
			"{$this->stock}/only-stock.tsl",
			Topology_Registry::resolve( 'only-stock' )
		);
		$this->rmdir_recursive( $second );
	}

	public function test_describe_reports_user_only_stock_only_and_both(): void {
		$stock = $this->make_temp_dir( 'a4-stock-' );
		$user  = $this->make_temp_dir( 'a4-user-' );
		\file_put_contents( "{$stock}/stock-only.tsl", "make_node Echo e\n" );
		\file_put_contents( "{$stock}/shadowed.tsl", "make_node Echo s\n" );
		\file_put_contents( "{$user}/user-only.tsl", "make_node Echo u\n" );
		\file_put_contents( "{$user}/shadowed.tsl", "make_node Echo o\n" );

		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $stock );
		Topology_Registry::register_user_dir( $user );

		$desc = Topology_Registry::describe();
		$this->assertArrayHasKey( 'stock-only', $desc );
		$this->assertNull( $desc['stock-only']['user'] );
		$this->assertSame( [ "{$stock}/stock-only.tsl" ], $desc['stock-only']['stock'] );

		$this->assertArrayHasKey( 'user-only', $desc );
		$this->assertSame( "{$user}/user-only.tsl", $desc['user-only']['user'] );
		$this->assertSame( [], $desc['user-only']['stock'] );

		$this->assertArrayHasKey( 'shadowed', $desc );
		$this->assertSame( "{$user}/shadowed.tsl", $desc['shadowed']['user'] );
		$this->assertSame( [ "{$stock}/shadowed.tsl" ], $desc['shadowed']['stock'] );

		$this->rmdir_recursive( $stock );
		$this->rmdir_recursive( $user );
	}

	public function test_describe_ignores_tsl_named_directories(): void {
		\mkdir( "{$this->stock}/stock-directory.tsl" );
		\mkdir( "{$this->user}/user-directory.tsl" );
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );

		$desc = Topology_Registry::describe();

		$this->assertArrayNotHasKey( 'stock-directory', $desc );
		$this->assertArrayNotHasKey( 'user-directory', $desc );
	}

	public function test_user_dir_getter_returns_set_value(): void {
		Topology_Registry::reset();
		Topology_Registry::register_user_dir( '/tmp/np-a4-user-getter' );
		$this->assertSame( '/tmp/np-a4-user-getter', Topology_Registry::user_dir() );
	}

	public function test_register_stock_dir_ignores_empty_paths(): void {
		Topology_Registry::reset();

		Topology_Registry::register_stock_dir( '' );

		$this->assertSame( [], Topology_Registry::list() );
	}

	public function test_segment_size_overrides_return_literal_partition_sizes_and_cache_by_topology(): void {
		\file_put_contents(
			"{$this->stock}/segments.tsl",
			"# comments and blank lines are skipped\n\n"
			. "make_node Echo e\n"
			. "make_node Partition requests:p <config:logs_dir>/requests.p<partition> 4096 2\n"
			. "make_node Partition dynamic:p <config:logs_dir>/dynamic.p<partition> <config:segment_size> 2\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[ 'requests' => 4096 ],
			Topology_Registry::segment_size_overrides_for( 'segments' )
		);

		\file_put_contents(
			"{$this->stock}/segments.tsl",
			"make_node Partition changed:p <config:logs_dir>/changed.p<partition> 8192 2\n"
		);

		$this->assertSame(
			[ 'requests' => 4096 ],
			Topology_Registry::segment_size_overrides_for( 'segments' ),
			'segment-size overrides are memoized until reset_basename_cache()'
		);

		Topology_Registry::reset_basename_cache();
		$this->assertSame(
			[ 'changed' => 8192 ],
			Topology_Registry::segment_size_overrides_for( 'segments' )
		);
	}

	public function test_segment_size_overrides_return_empty_for_unknown_topology(): void {
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame( [], Topology_Registry::segment_size_overrides_for( 'missing' ) );
	}
}
