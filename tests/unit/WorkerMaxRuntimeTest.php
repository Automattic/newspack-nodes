<?php
/**
 * A topology's `var max_runtime`, from its frontmatter to the worker it
 * builds, and the `shutdown` verb that ends a worker the normal way.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\DataProvider;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Capabilities;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_Base;
use Newspack_Nodes\Tests\TestCase;

/**
 * The lifetime rides the path `on_demand_idle` rides: frontmatter, catalog
 * entry, one descriptor per partition, then `Worker_Base::for_descriptor()`,
 * the one constructor both spawn paths share. 0 turns the recycle off.
 */
#[CoversClass( Bootstrap::class )]
#[CoversClass( Topology_Registry::class )]
#[CoversClass( Worker_Base::class )]
#[CoversClass( Command_Interpreter_Node::class )]
class WorkerMaxRuntimeTest extends TestCase {

	/** Seeded apart from the 595s default so a dropped override cannot pass. */
	private const RUNTIME_SECONDS = 1913;

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		$this->tmp = $this->stock_topology_dir( 'max-runtime-' );
		$this->use_base_dir( $this->tmp );
	}

	protected function tearDown(): void {
		Core::$shutting_down = false;
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_the_entry_carries_a_declared_max_runtime(): void {
		$this->write_tsl( 'wombat-long', 'var max_runtime = ' . self::RUNTIME_SECONDS . "\nmake_node Echo wombat-echo\n" );

		$this->assertSame( self::RUNTIME_SECONDS, Topology_Registry::synthesize_entry( 'wombat-long' )['max_runtime'] );
	}

	public function test_a_topology_declaring_none_recycles_at_the_default(): void {
		$this->write_tsl( 'wombat-plain', "make_node Echo wombat-echo\n" );

		$this->assertSame( Worker_Base::DEFAULT_MAX_RUNTIME, Topology_Registry::synthesize_entry( 'wombat-plain' )['max_runtime'] );
	}

	public function test_zero_turns_the_recycle_off(): void {
		$this->write_tsl( 'wombat-forever', "var max_runtime = 0\nmake_node Echo wombat-echo\n" );

		$this->assertSame( 0, Topology_Registry::synthesize_entry( 'wombat-forever' )['max_runtime'] );
	}

	/**
	 * A value no worker can mean takes the default, as `num_partitions` and
	 * `stale_timeout` do: a negative budget would read as already spent.
	 */
	public function test_a_negative_or_non_numeric_value_takes_the_default(): void {
		$this->write_tsl( 'wombat-negative', "var max_runtime = -40\nmake_node Echo wombat-echo\n" );
		$this->write_tsl( 'wombat-garbled', "var max_runtime = 12abc\nmake_node Echo wombat-echo\n" );

		$this->assertSame( Worker_Base::DEFAULT_MAX_RUNTIME, Topology_Registry::synthesize_entry( 'wombat-negative' )['max_runtime'] );
		$this->assertSame( Worker_Base::DEFAULT_MAX_RUNTIME, Topology_Registry::synthesize_entry( 'wombat-garbled' )['max_runtime'] );
	}

	/**
	 * Only a whole 0 turns the recycle off: a fraction asked for the shortest
	 * lifetime, and truncating it to 0 would run the worker forever.
	 */
	public function test_a_fraction_takes_the_default_rather_than_truncating_to_zero(): void {
		$this->write_tsl( 'wombat-half', "var max_runtime = 0.5\nmake_node Echo wombat-echo\n" );

		$this->assertSame( Worker_Base::DEFAULT_MAX_RUNTIME, Topology_Registry::synthesize_entry( 'wombat-half' )['max_runtime'] );
	}

	public function test_every_partition_carries_the_max_runtime(): void {
		$this->write_tsl( 'wombat-long', "var num_partitions = 2\nvar max_runtime = " . self::RUNTIME_SECONDS . "\nmake_node Echo wombat-echo\n" );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'wombat-long' ];

		$workers = Bootstrap::expand_workers();

		$this->assertSame( [ self::RUNTIME_SECONDS, self::RUNTIME_SECONDS ], \array_column( $workers, 'max_runtime' ) );
	}

	public function test_a_worker_built_from_a_descriptor_takes_its_three_windows(): void {
		$worker = Worker_Base::for_descriptor(
			$this->tmp,
			[
				'type'           => 'wombat-long',
				'partition'      => 3,
				'topology'       => 'wombat-long',
				'stale_timeout'  => 47,
				'on_demand_idle' => 23,
				'max_runtime'    => self::RUNTIME_SECONDS,
			]
		);

		$this->assertSame( 'wombat-long', $this->read_private( $worker, 'worker_type' ) );
		$this->assertSame( 3, $this->read_private( $worker, 'partition' ) );
		$this->assertSame( 47, $this->read_private( $worker, 'stale_timeout' ) );
		$this->assertSame( 23, $this->read_private( $worker, 'on_demand_idle' ) );
		$this->assertSame( self::RUNTIME_SECONDS, $this->read_private( $worker, 'max_runtime' ) );
	}

	/**
	 * One reader, ruled by `Worker_Base::WINDOWS`: each window's default, and
	 * whether 0 means something. Seeds sit apart from every default.
	 *
	 * @return array<string,array{0:string,1:mixed,2:int}>
	 */
	public static function windows(): array {
		return [
			'stale declared'   => [ 'stale_timeout', '47', 47 ],
			'stale zero'       => [ 'stale_timeout', '0', Lock_Node::STALE_TIMEOUT ],
			'stale negative'   => [ 'stale_timeout', '-3', Lock_Node::STALE_TIMEOUT ],
			'stale fraction'   => [ 'stale_timeout', '47.5', Lock_Node::STALE_TIMEOUT ],
			'stale absent'     => [ 'stale_timeout', null, Lock_Node::STALE_TIMEOUT ],
			'idle declared'    => [ 'on_demand_idle', 23, 23 ],
			'idle zero'        => [ 'on_demand_idle', '0', 0 ],
			'idle negative'    => [ 'on_demand_idle', '-9', 0 ],
			'idle garbled'     => [ 'on_demand_idle', '23abc', 0 ],
			'runtime declared' => [ 'max_runtime', '1913', 1913 ],
			'runtime zero'     => [ 'max_runtime', 0, 0 ],
			'runtime fraction' => [ 'max_runtime', '0.5', Worker_Base::DEFAULT_MAX_RUNTIME ],
			'runtime absent'   => [ 'max_runtime', null, Worker_Base::DEFAULT_MAX_RUNTIME ],
		];
	}

	#[DataProvider( 'windows' )]
	public function test_each_window_reads_through_one_rule( string $key, mixed $declared, int $expected ): void {
		$descriptor = null === $declared ? [] : [ $key => $declared ];

		$this->assertSame( $expected, Worker_Base::window_of( $descriptor, $key ) );
	}

	public function test_a_caller_default_replaces_the_table_default(): void {
		$this->assertSame( 31, Worker_Base::window_of( [], 'on_demand_idle', 31 ) );
		$this->assertSame( 900, Worker_Base::window_of( [ 'stale_timeout' => '0' ], 'stale_timeout', 900 ) );
	}

	/**
	 * A negative or garbled idle window declares nothing, so it takes the
	 * fleet default, where a clamp would have kept the worker resident.
	 */
	public function test_a_negative_idle_window_takes_the_fleet_default(): void {
		$this->assertSame( 31, Worker_Base::window_of( [ 'on_demand_idle' => '-9' ], 'on_demand_idle', 31 ) );
		$this->assertSame( 31, Worker_Base::window_of( [ 'on_demand_idle' => '23abc' ], 'on_demand_idle', 31 ) );
	}

	public function test_an_unknown_window_fails_loud(): void {
		$this->expectException( \InvalidArgumentException::class );

		Worker_Base::window_of( [ 'max_lifetime' => 30 ], 'max_lifetime' );
	}

	public function test_a_descriptor_without_a_type_or_partition_fails_loud(): void {
		$this->expectException( \InvalidArgumentException::class );

		Worker_Base::for_descriptor( $this->tmp, [ 'topology' => 'wombat-long', 'max_runtime' => self::RUNTIME_SECONDS ] );
	}

	/**
	 * Tachikoma's `shutdown`: the process stops, and whatever follows a normal
	 * stop follows it. The drain loop breaks on the flag as it does on SIGTERM.
	 */
	public function test_shutdown_stops_this_process_as_a_signal_does(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );

		$answer = $interpreter->dispatch( 'shutdown' );

		$this->assertTrue( Core::$shutting_down );
		$this->assertSame( "shutting down\n", $answer );
	}

	public function test_a_read_session_cannot_shut_a_worker_down(): void {
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		Capabilities::$session_scope = Capabilities::READ;

		try {
			$interpreter->dispatch( 'shutdown' );
			$this->fail( 'a READ session shut the worker down' );
		} catch ( \RuntimeException $e ) {
			$this->assertSame( 'permission denied: manage capability required', $e->getMessage() );
		}
		$this->assertFalse( Core::$shutting_down );
	}
}
