<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Rest\Settings_CI_Node;
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
	 * A stock name resolves ONLY from a stock dir. Were the user dir to win on a
	 * bare is_file(), anyone who could write there would replace the graph the
	 * plugin ships — under a name already marked active, executed by every
	 * worker spawn. Extending a stock topology does not need the override: name
	 * the file something else and `include` the stock one, which a shadowing
	 * precedence would prevent (including the name you shadow is a cycle).
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

	/**
	 * The registry lives in `includes/`, so it can always name its own stock
	 * dir. Registered inside the LAZY `ensure_runtime_wired()` instead — while
	 * consumers register theirs at plugin load — a request that wired neither
	 * tier would see the consumer topologies and not the substrate's, and their
	 * `include topic-probe` would throw.
	 */
	public function test_register_builtin_registers_the_substrates_own_topologies(): void {
		$this->assertNull( Topology_Registry::resolve( 'topic-probe' ), 'reset leaves nothing registered' );

		Topology_Registry::register_builtin();

		$this->assertStringEndsWith(
			'/topologies/topic-probe.tsl.php',
			(string) Topology_Registry::resolve( 'topic-probe' )
		);
	}

	/**
	 * A stock topology ships as `<name>.tsl.php`, so a web server runs its
	 * guard rather than serving its text, and it resolves by its bare name.
	 */
	public function test_a_guarded_stock_topology_resolves_and_lists_by_its_bare_name(): void {
		$dir = \sys_get_temp_dir() . '/np-guarded-tsl-' . \getmypid();
		\mkdir( $dir );
		\file_put_contents( "{$dir}/harbor.tsl.php", "# <?php \\defined( 'ABSPATH' ) || exit; ?>\nmake_node Null x\n" );
		try {
			Topology_Registry::register_stock_dir( $dir );

			$this->assertSame( "{$dir}/harbor.tsl.php", Topology_Registry::resolve( 'harbor' ) );
			$this->assertSame( "{$dir}/harbor.tsl.php", Topology_Registry::resolve_file( 'harbor.tsl' ) );
			$this->assertContains( 'harbor', Topology_Registry::list() );
		} finally {
			\unlink( "{$dir}/harbor.tsl.php" );
			\rmdir( $dir );
		}
	}

	/**
	 * Every topology the plugin ships is guarded: a plain `.tsl` would be
	 * served as text over HTTP.
	 */
	public function test_every_shipped_topology_carries_the_guard(): void {
		$dir = \dirname( __DIR__, 2 ) . '/topologies';

		$this->assertSame( [], \glob( "{$dir}/*.tsl" ) ?: [] );
		$files = \glob( "{$dir}/*.tsl.php" ) ?: [];
		$this->assertNotSame( [], $files );
		foreach ( $files as $file ) {
			$this->assertStringStartsWith( "# <?php \\defined( 'ABSPATH' ) || exit; ?>\n", (string) \file_get_contents( $file ), $file );
		}
	}

	/**
	 * A wp-admin save classifies its restart by node type in a process that
	 * only loaded the plugin, so the substrate's types resolve from load.
	 */
	public function test_register_builtin_makes_the_substrates_node_types_resolvable(): void {
		( new \ReflectionProperty( Command_Interpreter_Node::class, 'namespaces' ) )->setValue( null, [] );
		( new \ReflectionProperty( Command_Interpreter_Node::class, 'resolve_cache' ) )->setValue( null, [] );

		Topology_Registry::register_builtin();

		$this->assertSame( Partition_Node::class, Command_Interpreter_Node::resolve_class( 'Partition' ) );
		$this->assertSame( Settings_CI_Node::class, Command_Interpreter_Node::resolve_class( 'Settings_CI' ) );
	}

	public function test_register_builtin_is_lowest_priority_so_consumers_override(): void {
		$consumer = $this->make_temp_dir( 'tsl-consumer-' );
		\file_put_contents( "{$consumer}/topic-probe.tsl", '' );

		// Builtin registered AFTER: priority must not depend on load order.
		Topology_Registry::register_stock_dir( $consumer );
		Topology_Registry::register_builtin();

		$this->assertSame( "{$consumer}/topic-probe.tsl", Topology_Registry::resolve( 'topic-probe' ) );

		$this->rmdir_recursive( $consumer );
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

	public function test_resolve_file_answers_the_last_registered_dirs_copy(): void {
		$second = $this->make_temp_dir( 'tsl-stock-2-' );
		\file_put_contents( "{$this->stock}/seed-4417.json", '{}' );
		\file_put_contents( "{$second}/seed-4417.json", '[]' );
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_stock_dir( $second );

		$this->assertSame( "{$second}/seed-4417.json", Topology_Registry::resolve_file( 'seed-4417.json' ) );
		$this->rmdir_recursive( $second );
	}

	public function test_resolve_file_falls_back_to_an_earlier_dir_then_the_user_dir(): void {
		$second = $this->make_temp_dir( 'tsl-stock-2-' );
		\file_put_contents( "{$this->stock}/held-by-first.json", '{}' );
		\file_put_contents( "{$this->user}/held-by-user.json", '{}' );
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_stock_dir( $second );
		Topology_Registry::register_user_dir( $this->user );

		$this->assertSame( "{$this->stock}/held-by-first.json", Topology_Registry::resolve_file( 'held-by-first.json' ) );
		$this->assertSame( "{$this->user}/held-by-user.json", Topology_Registry::resolve_file( 'held-by-user.json' ) );
		$this->rmdir_recursive( $second );
	}

	public function test_resolve_file_answers_null_for_a_name_no_dir_holds(): void {
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_user_dir( $this->user );
		\mkdir( "{$this->stock}/a-directory.json" );

		$this->assertNull( Topology_Registry::resolve_file( 'absent-8810.json' ) );
		$this->assertNull( Topology_Registry::resolve_file( 'a-directory.json' ) );
	}

	/**
	 * @return array<string,array{string}>
	 */
	public static function refused_file_names(): array {
		return [
			'slash'         => [ 'nested/seed.json' ],
			'backslash'     => [ 'nested\\seed.json' ],
			'parent inside' => [ 'seed..json' ],
		];
	}

	/**
	 * Each refused name names a file that exists, so only the refusal can
	 * answer null.
	 */
	#[\PHPUnit\Framework\Attributes\DataProvider( 'refused_file_names' )]
	public function test_resolve_file_refuses_a_name_that_could_leave_the_dir( string $name ): void {
		\mkdir( "{$this->stock}/inner" );
		\mkdir( "{$this->stock}/inner/nested" );
		\file_put_contents( "{$this->stock}/inner/nested/seed.json", '{}' );
		\file_put_contents( "{$this->stock}/inner/seed..json", '{}' );
		\file_put_contents( "{$this->stock}/inner/nested\\seed.json", '{}' );
		Topology_Registry::register_stock_dir( "{$this->stock}/inner" );

		$this->assertNull( Topology_Registry::resolve_file( $name ) );
	}

	public function test_resolve_refuses_a_topology_name_that_walks_out_of_the_dir(): void {
		\mkdir( "{$this->stock}/inner" );
		Topology_Registry::register_stock_dir( "{$this->stock}/inner" );

		$this->assertNull( Topology_Registry::resolve( '../only-stock' ) );
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

	public function test_frontmatter_deletes_on_a_valueless_assignment(): void {
		// `var <name> =` DELETES, in both Shells (Shell3.pm:2839). Setting it
		// to '' instead is not the same thing: an absent key falls back to the
		// config default, while '' overrides it with nothing. 9 is distinct
		// from the num_partitions default (1) and from every other seed here.
		\file_put_contents(
			"{$this->stock}/aggregator.tsl",
			"var num_partitions = 9\nvar num_partitions =\nvar stale_timeout = 600\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[ 'stale_timeout' => '600' ],
			Topology_Analyzer::frontmatter( 'aggregator' )
		);
	}

	public function test_frontmatter_keeps_an_explicitly_quoted_empty_value(): void {
		// A quoted empty string is a VALUE token, so it sets. Only a valueless
		// `=` deletes — the two must not collapse.
		\file_put_contents(
			"{$this->stock}/aggregator.tsl",
			"var num_partitions = \"\"\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[ 'num_partitions' => '' ],
			Topology_Analyzer::frontmatter( 'aggregator' )
		);
	}

	public function test_frontmatter_skips_a_compound_operator_instead_of_inventing_a_key(): void {
		// The static reader splits on the FIRST `=` with no operator awareness,
		// so `//=` could yield the key `num_partitions //` — a junk entry,
		// and the real key absent. It does not APPLY the operator (the
		// executed Shell does), but it must not invent a name for it.
		\file_put_contents(
			"{$this->stock}/aggregator.tsl",
			"var num_partitions //= 9\nvar stale_timeout = 600\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[ 'stale_timeout' => '600' ],
			Topology_Analyzer::frontmatter( 'aggregator' )
		);
	}

	public function test_synthesize_entry_falls_back_when_a_declared_value_is_not_positive(): void {
		// `var stale_timeout = ""` casts to 0, and 0 means every worker in the
		// fleet reads as instantly stale — continuous respawn churn. A
		// non-positive declaration is not a declaration. Caller defaults here
		// (5/900) are distinct from both the frontmatter and the class
		// defaults, so a fallback to the WRONG default still fails.
		\file_put_contents(
			"{$this->stock}/aggregator.tsl",
			"var num_partitions = \"\"\nvar stale_timeout = 0\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[
				'topology'       => 'aggregator',
				'num_partitions' => 5,
				'stale_timeout'  => 900,
				'on_demand_idle' => 0,
			],
			Topology_Registry::synthesize_entry( 'aggregator', 5, 900, 0 )
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
				'on_demand_idle' => 0,
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
				'on_demand_idle' => 0,
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

	/**
	 * One walk, two views. `list()` is the API and `array_keys( describe() )` is
	 * what several callers actually use, so any dir-precedence or file-filtering
	 * rule that reaches one must reach the other.
	 */
	public function test_list_is_exactly_the_keys_describe_reports(): void {
		$stock = $this->make_temp_dir( 'one-walk-stock-' );
		$user  = $this->make_temp_dir( 'one-walk-user-' );
		\file_put_contents( "{$stock}/stock-only.tsl", "make_node Echo e\n" );
		\file_put_contents( "{$stock}/shadowed.tsl", "make_node Echo s\n" );
		\file_put_contents( "{$user}/user-only.tsl", "make_node Echo u\n" );
		\file_put_contents( "{$user}/shadowed.tsl", "make_node Echo o\n" );
		\mkdir( "{$stock}/a-directory.tsl" );

		Topology_Registry::reset();
		Topology_Registry::register_stock_dir( $stock );
		Topology_Registry::register_user_dir( $user );

		$this->assertSame( \array_keys( Topology_Registry::describe() ), Topology_Registry::list() );

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

	/**
	 * A scoped read resolves the dir's own copy over a stock dir registered
	 * after it, and leaves the resolution order as it found it.
	 */
	public function test_with_stock_dir_reads_its_own_copy_and_restores_the_order(): void {
		$later = $this->make_temp_dir( 'tsl-stock-later-' );
		\file_put_contents( "{$later}/only-stock.tsl", "make_node Echo kea-later-4419\n" );
		$scoped = $this->make_temp_dir( 'tsl-stock-scoped-' );
		\file_put_contents( "{$scoped}/kea-scoped-4419.tsl", "make_node Echo kea-4419\n" );
		Topology_Registry::register_stock_dir( $this->stock );
		Topology_Registry::register_stock_dir( $later );

		$inside = Topology_Registry::with_stock_dir(
			$this->stock,
			static fn (): array => [ Topology_Registry::resolve( 'only-stock' ), Topology_Registry::resolve( 'kea-scoped-4419' ) ]
		);
		$scoped_inside = Topology_Registry::with_stock_dir( $scoped, static fn (): ?string => Topology_Registry::resolve( 'kea-scoped-4419' ) );

		$this->assertSame( [ "{$this->stock}/only-stock.tsl", null ], $inside );
		$this->assertSame( "{$scoped}/kea-scoped-4419.tsl", $scoped_inside );
		$this->assertSame( "{$later}/only-stock.tsl", Topology_Registry::resolve( 'only-stock' ) );
		$this->assertNull( Topology_Registry::resolve( 'kea-scoped-4419' ), 'the scoped dir is registered no longer' );
		$this->rmdir_recursive( $later );
		$this->rmdir_recursive( $scoped );
	}

	/** A read that throws restores the order and the parse caches all the same. */
	public function test_with_stock_dir_restores_the_order_when_the_read_throws(): void {
		$scoped = $this->make_temp_dir( 'tsl-stock-throws-' );
		\file_put_contents( "{$scoped}/kea-throws-4420.tsl", "make_node Echo kea-4420\n" );
		Topology_Registry::register_stock_dir( $this->stock );

		try {
			Topology_Registry::with_stock_dir(
				$scoped,
				static function (): never {
					Topology_Analyzer::statements( 'kea-throws-4420' );
					throw new \LogicException( 'kea-4420' );
				}
			);
			$this->fail( 'the read threw' );
		} catch ( \LogicException $e ) {
			$this->assertSame( 'kea-4420', $e->getMessage() );
		}

		$this->assertNull( Topology_Registry::resolve( 'kea-throws-4420' ) );
		$this->expectExceptionMessage( 'unknown topology: kea-throws-4420' );
		Topology_Analyzer::statements( 'kea-throws-4420' );
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
			. "make_node Partition requests:p <config:logs_dir>/requests.p{partition} 4096 2\n"
			. "make_node Partition dynamic:p <config:logs_dir>/dynamic.p{partition} <config:segment_size> 2\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[ 'requests.p0' => 4096 ],
			Topology_Analyzer::segment_size_overrides_for( 'segments' )
		);

		\file_put_contents(
			"{$this->stock}/segments.tsl",
			"make_node Partition changed:p <config:logs_dir>/changed.p{partition} 8192 2\n"
		);

		$this->assertSame(
			[ 'requests.p0' => 4096 ],
			Topology_Analyzer::segment_size_overrides_for( 'segments' ),
			'segment-size overrides are memoized until reset_basename_cache()'
		);

		Topology_Registry::reset_basename_cache();
		$this->assertSame(
			[ 'changed.p0' => 8192 ],
			Topology_Analyzer::segment_size_overrides_for( 'segments' )
		);
	}

	public function test_segment_size_overrides_are_layout_agnostic(): void {
		// The {partition} token sits anywhere — or nowhere: a hardwired .p0
		// journal and a {partition} path both carry their configured size.
		\file_put_contents(
			"{$this->stock}/vicuna-layouts.tsl",
			"make_node Partition pinned:p <config:logs_dir>/pinned.p0 1048576 2 7 0 0\n"
			. "make_node Partition tokened:p <config:logs_dir>/tokened.p{partition} 8192 2\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[
				'pinned.p0' => 1048576,
				'tokened.p0' => 8192,
			],
			Topology_Analyzer::segment_size_overrides_for( 'vicuna-layouts' )
		);
	}

	/**
	 * A NESTED layout puts `{partition}` below the first level, where a
	 * `.p(?:{partition}|\d+)$` suffix regex matches nothing, so the override
	 * would be dropped and the dashboard report the global default. The key is the
	 * concrete first-level dir under logs_dir, the SAME reduction
	 * `resolved_resource_dirs()` and `Log_Cleaner` name their dirs by.
	 */
	public function test_segment_size_overrides_cover_a_nested_partition_layout(): void {
		\file_put_contents(
			"{$this->stock}/vicuna-nested.tsl",
			"make_node Partition nested:p <config:logs_dir>/burrow/{partition} 32768 2\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[ 'burrow' => 32768 ],
			Topology_Analyzer::segment_size_overrides_for( 'vicuna-nested', 3 )
		);
	}

	/** Every partition's concrete dir carries the override, not just p0. */
	public function test_segment_size_overrides_span_every_partition(): void {
		\file_put_contents(
			"{$this->stock}/vicuna-fanned.tsl",
			"make_node Partition fanned:p <config:logs_dir>/fanned.p{partition} 16384 2\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame(
			[
				'fanned.p0' => 16384,
				'fanned.p1' => 16384,
				'fanned.p2' => 16384,
			],
			Topology_Analyzer::segment_size_overrides_for( 'vicuna-fanned', 3 )
		);
	}

	/**
	 * `make` is the documented alias for `make_node`, and every other reader in
	 * the analyzer sees the canonical verb because `Shell_Node::build_statement()`
	 * resolves it. This method re-tokenized the RAW line and compared against the
	 * literal `make_node`, so an aliased declaration — and a `Partition` SUBCLASS
	 * — silently yielded no override.
	 */
	public function test_segment_size_overrides_honor_the_make_alias_and_partition_subclasses(): void {
		\file_put_contents(
			"{$this->stock}/vicuna-aliased.tsl",
			"make Partition aliased:p <config:logs_dir>/aliased.p{partition} 2048 2\n"
			. "make_node Log journal:l <config:logs_dir>/journal.p{partition} 65536 2\n"
		);
		Topology_Registry::register_stock_dir( $this->stock );
		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );

		$this->assertSame(
			[
				'aliased.p0' => 2048,
				'journal.p0' => 65536,
			],
			Topology_Analyzer::segment_size_overrides_for( 'vicuna-aliased' )
		);
	}

	public function test_segment_size_overrides_return_empty_for_unknown_topology(): void {
		Topology_Registry::register_stock_dir( $this->stock );

		$this->assertSame( [], Topology_Analyzer::segment_size_overrides_for( 'missing' ) );
	}
}
