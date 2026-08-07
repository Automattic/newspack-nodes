<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Topology_Analyzer;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_Base;
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

	/**
	 * A stock name resolves ONLY from a stock dir. The user dir used to win on a
	 * bare is_file(), so anyone who could write there replaced the graph the
	 * plugin ships — under a name already marked active, executed by every
	 * worker spawn. Extending a stock topology does not need the override: name
	 * the file something else and `include` the stock one, which the old
	 * precedence actively prevented (including the name you shadow is a cycle).
	 */
	public function test_a_user_file_cannot_shadow_a_stock_topology(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );

		$this->assertSame(
			"{$this->stock}/firehose-workers.tsl",
			Topology_Registry::resolve( 'firehose-workers' )
		);
	}

	public function test_resolve_serves_a_user_name_stock_does_not_provide(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );
		\file_put_contents( "{$this->user}/my-firehose.tsl", "include firehose-workers\n" );

		$this->assertSame(
			"{$this->user}/my-firehose.tsl",
			Topology_Registry::resolve( 'my-firehose' )
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

	public function test_register_builtin_dir_is_lowest_priority_so_consumers_override(): void {
		$builtin  = $this->make_temp_dir( 'tsl-builtin-' );
		$consumer = $this->make_temp_dir( 'tsl-consumer-' );
		\file_put_contents( "{$builtin}/hub-control.tsl", '' );
		\file_put_contents( "{$consumer}/hub-control.tsl", '' );

		// Builtin registered AFTER the consumer: priority must not depend on order.
		Topology_Registry::register_stock_dir( $consumer );
		Topology_Registry::register_builtin_dir( $builtin );

		$this->assertSame( "{$consumer}/hub-control.tsl", Topology_Registry::resolve( 'hub-control' ) );

		$this->rmdir_recursive( $builtin );
		$this->rmdir_recursive( $consumer );
	}

	public function test_register_builtin_dir_resolves_when_no_consumer_registered(): void {
		$builtin = $this->make_temp_dir( 'tsl-builtin-' );
		\file_put_contents( "{$builtin}/hub-control.tsl", '' );

		Topology_Registry::register_builtin_dir( $builtin );

		$this->assertSame( "{$builtin}/hub-control.tsl", Topology_Registry::resolve( 'hub-control' ) );

		$this->rmdir_recursive( $builtin );
	}

	public function test_register_builtin_dir_is_idempotent(): void {
		$builtin = $this->make_temp_dir( 'tsl-builtin-' );
		\file_put_contents( "{$builtin}/only-builtin.tsl", '' );

		Topology_Registry::register_builtin_dir( $builtin );
		Topology_Registry::register_builtin_dir( $builtin );

		$this->assertSame( [ 'only-builtin' ], Topology_Registry::list() );

		$this->rmdir_recursive( $builtin );
	}

	public function test_register_stock_dir_does_not_inject_the_substrate_topologies(): void {
		// A consumer/test registering its own dir must NOT pull in nodes' real
		// production topologies — that builtin dir is opt-in via register_builtin_dir.
		Topology_Registry::register_stock_dir( $this->stock );

		$names = Topology_Registry::list();
		\sort( $names );
		$this->assertSame( [ 'firehose-workers', 'only-stock' ], $names );
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
		$frontmatter = Topology_Analyzer::frontmatter( 'aggregator' );
		$this->assertSame(
			[ 'num_partitions' => '1', 'stale_timeout' => '600' ],
			$frontmatter
		);
	}

	public function test_frontmatter_joins_a_backslash_continued_var(): void {
		// The runtime Shell joins continuations before the var branch, so a
		// continued `var` is valid syntax the console must read the same way.
		// Value 7 is distinct from the num_partitions default (1).
		\file_put_contents(
			"{$this->stock}/aggregator.tsl",
			"var num_partitions = \\\n    7\nmake_node Echo zebra-echo\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[ 'num_partitions' => '7' ],
			Topology_Analyzer::frontmatter( 'aggregator' )
		);
	}

	public function test_frontmatter_returns_empty_for_unknown_topology(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		$this->assertSame( [], Topology_Analyzer::frontmatter( 'no-such-topology' ) );
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
				'on_demand'      => false,
				'on_demand_idle' => Worker_Base::DEFAULT_ON_DEMAND_IDLE_S,
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
				'on_demand'      => false,
				'on_demand_idle' => Worker_Base::DEFAULT_ON_DEMAND_IDLE_S,
			],
			Topology_Registry::synthesize_entry( 'quiet', 4, 99 )
		);
	}

	public function test_synthesize_entry_returns_null_for_missing_tsl(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		$this->assertNull( Topology_Registry::synthesize_entry( 'no-such-topology' ) );
	}

	public function test_multiple_stock_dirs_last_wins(): void {
		$second = $this->make_temp_dir( 'tsl-stock-2-' );
		\file_put_contents( "{$second}/only-stock.tsl", '' );
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_stock_dir( $second );
		Topology_Registry::register_user_dir( $this->user );

		$this->assertSame(
			"{$second}/only-stock.tsl",
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
			Topology_Analyzer::segment_size_overrides_for( 'segments' )
		);

		\file_put_contents(
			"{$this->stock}/segments.tsl",
			"make_node Partition changed:p <config:logs_dir>/changed.p<partition> 8192 2\n"
		);

		$this->assertSame(
			[ 'requests' => 4096 ],
			Topology_Analyzer::segment_size_overrides_for( 'segments' ),
			'segment-size overrides are memoized until reset_basename_cache()'
		);

		Topology_Registry::reset_basename_cache();
		$this->assertSame(
			[ 'changed' => 8192 ],
			Topology_Analyzer::segment_size_overrides_for( 'segments' )
		);
	}

	public function test_segment_size_overrides_are_layout_agnostic(): void {
		// The <partition> token sits anywhere — or nowhere: a hardwired .p0
		// journal and a quoted deferred '<partition>' Topic-style path both
		// carry their configured size (the .p<partition>-only regex lost them).
		\file_put_contents(
			"{$this->stock}/vicuna-layouts.tsl",
			"make_node Partition pinned:p <config:logs_dir>/pinned.p0 1048576 2 7 0 0\n"
			. "make_node Partition quoted:p <config:logs_dir>/quoted.p'<partition>' 8192 2\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[
				'pinned' => 1048576,
				'quoted' => 8192,
			],
			Topology_Analyzer::segment_size_overrides_for( 'vicuna-layouts' )
		);
	}

	public function test_segment_size_overrides_return_empty_for_unknown_topology(): void {
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame( [], Topology_Analyzer::segment_size_overrides_for( 'missing' ) );
	}
}
