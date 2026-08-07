<?php
/**
 * OnDemandWorkersTest: `var on_demand = 1` from TSL frontmatter to the three
 * places that currently read a worker's absence as death.
 *
 * A resident worker is absent only because something went wrong. An on-demand
 * worker is absent because it had nothing to do, and the spawn scan, the alert
 * evaluator and `wp nodes status` each have to be told the difference. A STALE
 * lock is not that difference: staleness means a worker died holding it, which
 * is a crash whether or not the type is on-demand.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Alerts;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Worker_Base;
use Newspack_Nodes\Worker_CLI_Command;
use Newspack_Nodes\Tests\TestCase;

require_once \dirname( __DIR__ ) . '/Helpers/WPCLIStub.php';

#[CoversClass( Bootstrap::class )]
#[CoversClass( Spawn_Coordinator::class )]
#[CoversClass( Topology_Registry::class )]
#[CoversClass( Worker_CLI_Command::class )]
class OnDemandWorkersTest extends TestCase {

	/** Seeded apart from the 5s default so a dropped override cannot pass. */
	private const IDLE_SECONDS = 23;

	/** Seeded apart from the 60s default for the same reason. */
	private const STALE_SECONDS = 47;

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Topology_Registry::reset();
		Topology_Registry::$spawn_runner = null;
		Alerts::reset();
		$GLOBALS['_test_wp_cli_logs']    = [];
		$GLOBALS['_test_wp_cli_warns']   = [];
		$GLOBALS['_test_wp_cli_errors']  = [];
		$GLOBALS['_test_wp_cli_success'] = [];
		$this->tmp = $this->make_temp_dir( 'on-demand-' );
		Topology_Registry::register_stock_dir( $this->tmp );
		$this->use_base_dir( $this->tmp );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		Topology_Registry::$spawn_runner = null;
		Alerts::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function write_tsl( string $name, string $contents ): void {
		\file_put_contents( "{$this->tmp}/{$name}.tsl", $contents );
	}

	/** A descriptor of the shape expand_workers() emits. */
	private function descriptor( bool $on_demand ): array {
		return [
			'type'           => 'marmot-ondemand',
			'partition'      => 0,
			'topology'       => 'marmot-ondemand',
			'stale_timeout'  => self::STALE_SECONDS,
			'on_demand'      => $on_demand,
			'on_demand_idle' => self::IDLE_SECONDS,
		];
	}

	/** Lock dir whose heartbeat is $age seconds old. */
	private function make_lock( string $name, int $age ): string {
		$dir = "{$this->tmp}/locks/{$name}.lock.d";
		\mkdir( $dir, 0755, true );
		\touch( "{$dir}/heartbeat", \time() - $age );
		return $dir;
	}

	// ── the flag through the descriptor ─────────────────────────────────────

	public function test_synthesize_entry_carries_the_on_demand_frontmatter(): void {
		$this->write_tsl(
			'marmot-ondemand',
			"var on_demand = 1\nvar on_demand_idle = " . self::IDLE_SECONDS . "\nmake_node Echo marmot-echo\n"
		);

		$entry = Topology_Registry::synthesize_entry( 'marmot-ondemand' );

		$this->assertTrue( $entry['on_demand'] );
		$this->assertSame( self::IDLE_SECONDS, $entry['on_demand_idle'] );
	}

	public function test_a_topology_without_the_flag_stays_resident(): void {
		$this->write_tsl( 'marmot-resident', "make_node Echo marmot-echo\n" );

		$entry = Topology_Registry::synthesize_entry( 'marmot-resident' );

		$this->assertFalse( $entry['on_demand'] );
		$this->assertSame( Worker_Base::DEFAULT_ON_DEMAND_IDLE_S, $entry['on_demand_idle'] );
	}

	public function test_expand_workers_carries_on_demand_onto_every_partition(): void {
		$this->write_tsl(
			'marmot-ondemand',
			"var num_partitions = 2\nvar on_demand = 1\nvar on_demand_idle = " . self::IDLE_SECONDS
			. "\nmake_node Echo marmot-echo\n"
		);
		$entry = Topology_Registry::synthesize_entry( 'marmot-ondemand' );
		\add_filter(
			'newspack_nodes/topologies',
			static fn ( array $t ): array => $t + [ 'marmot-ondemand' => $entry ]
		);
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'marmot-ondemand' ];

		$workers = Bootstrap::expand_workers();

		$this->assertCount( 2, $workers );
		foreach ( $workers as $worker ) {
			$this->assertTrue( $worker['on_demand'] );
			$this->assertSame( self::IDLE_SECONDS, $worker['on_demand_idle'] );
		}
	}

	// ── read site 1: the spawn scan ─────────────────────────────────────────

	public function test_an_absent_on_demand_worker_does_not_need_a_spawn(): void {
		$this->assertFalse(
			( new Spawn_Coordinator( $this->tmp ) )
				->worker_needs_spawn( $this->descriptor( true ), (float) \time() )
		);
	}

	public function test_an_absent_resident_worker_still_needs_a_spawn(): void {
		$this->assertTrue(
			( new Spawn_Coordinator( $this->tmp ) )
				->worker_needs_spawn( $this->descriptor( false ), (float) \time() )
		);
	}

	/** Staleness means a worker died holding the lock — a crash either way. */
	public function test_a_stale_on_demand_lock_still_needs_a_spawn(): void {
		$this->make_lock( 'marmot-ondemand.p0', self::STALE_SECONDS + 1 );

		$this->assertTrue(
			( new Spawn_Coordinator( $this->tmp ) )
				->worker_needs_spawn( $this->descriptor( true ), (float) \time() )
		);
	}

	public function test_a_live_on_demand_lock_needs_no_spawn(): void {
		$this->make_lock( 'marmot-ondemand.p0', 0 );

		$this->assertFalse(
			( new Spawn_Coordinator( $this->tmp ) )
				->worker_needs_spawn( $this->descriptor( true ), (float) \time() )
		);
	}

	// ── read site 2: the alert evaluator ────────────────────────────────────

	public function test_an_absent_on_demand_worker_raises_no_alert(): void {
		$this->activate( true );

		$this->assertSame( [], $this->liveness_alerts() );
	}

	public function test_an_absent_resident_worker_still_raises_an_alert(): void {
		$this->activate( false );

		$keys = \array_column( $this->liveness_alerts(), 'key' );

		$this->assertSame( [ 'worker_missing:marmot-ondemand.p0' ], $keys );
	}

	/** A crashed on-demand worker is still a crash: stale keeps its alert. */
	public function test_a_stale_on_demand_worker_still_raises_an_alert(): void {
		$this->activate( true );
		$this->make_lock( 'marmot-ondemand.p0', self::STALE_SECONDS + 1 );

		$keys = \array_column( $this->liveness_alerts(), 'key' );

		$this->assertSame( [ 'worker_down:marmot-ondemand.p0' ], $keys );
	}

	// ── read site 3: wp nodes status ────────────────────────────────────────

	/** `down` invites an operator to restart by hand and call the feature broken. */
	public function test_status_renders_an_absent_on_demand_worker_as_idle(): void {
		$this->activate( true );

		( new Worker_CLI_Command() )->status( [], [] );

		$this->assertStringContainsString( 'idle', $this->cli_output() );
		$this->assertStringNotContainsString( 'down', $this->cli_output() );
	}

	public function test_status_still_renders_an_absent_resident_worker_as_down(): void {
		$this->activate( false );

		( new Worker_CLI_Command() )->status( [], [] );

		$this->assertStringContainsString( 'down', $this->cli_output() );
	}

	public function test_status_still_renders_a_stale_on_demand_worker_as_stale(): void {
		$this->activate( true );
		$this->make_lock( 'marmot-ondemand.p0', self::STALE_SECONDS + 1 );

		( new Worker_CLI_Command() )->status( [], [] );

		$this->assertStringContainsString( 'stale', $this->cli_output() );
	}

	// ── the flag reaching the worker that reads it ──────────────────────────

	/**
	 * The seam takes the whole descriptor, not a growing parameter list: every
	 * frontmatter var the spawn path has to honour rides for free, and none of
	 * them can be the one a call site quietly stopped short of passing.
	 */
	public function test_spawn_worker_hands_the_runner_the_whole_descriptor(): void {
		$this->activate( true );
		$captured                        = [];
		Topology_Registry::$spawn_runner = static function ( array $descriptor ) use ( &$captured ): void {
			$captured = $descriptor;
		};

		Topology_Registry::spawn_worker( 'marmot-ondemand', 0 );

		$this->assertTrue( $captured['on_demand'] );
		$this->assertSame( self::IDLE_SECONDS, $captured['on_demand_idle'] );
		$this->assertSame( self::STALE_SECONDS, $captured['stale_timeout'] );
		$this->assertSame( 'marmot-ondemand', $captured['topology'] );
	}

	private function cli_output(): string {
		return \implode( "\n", $GLOBALS['_test_wp_cli_logs'] ?? [] );
	}

	/** Activate one single-partition topology, on-demand or not. */
	private function activate( bool $on_demand ): void {
		$entry = [
			'topology'       => 'marmot-ondemand',
			'num_partitions' => 1,
			'stale_timeout'  => self::STALE_SECONDS,
			'on_demand'      => $on_demand,
			'on_demand_idle' => self::IDLE_SECONDS,
		];
		\add_filter(
			'newspack_nodes/topologies',
			static fn ( array $t ): array => $t + [ 'marmot-ondemand' => $entry ]
		);
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'marmot-ondemand' ];
	}

	/** @return array<int,array<string,mixed>> Only the worker-liveness family. */
	private function liveness_alerts(): array {
		return \array_values(
			\array_filter(
				Alerts::evaluate(),
				static fn ( array $a ): bool => Alerts::FAMILY_WORKER_LIVENESS === ( $a['family'] ?? '' )
			)
		);
	}
}
