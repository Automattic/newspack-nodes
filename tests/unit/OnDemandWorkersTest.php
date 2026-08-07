<?php
/**
 * OnDemandWorkersTest: `var on_demand_idle = <seconds>` from TSL frontmatter
 * to the three places that currently read a worker's absence as death.
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
	private function descriptor( int $on_demand_idle = self::IDLE_SECONDS ): array {
		return [
			'type'           => 'marmot-ondemand',
			'partition'      => 0,
			'topology'       => 'marmot-ondemand',
			'stale_timeout'  => self::STALE_SECONDS,
			'on_demand_idle' => $on_demand_idle,
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
			"var on_demand_idle = " . self::IDLE_SECONDS . "\nmake_node Echo marmot-echo\n"
		);

		$entry = Topology_Registry::synthesize_entry( 'marmot-ondemand' );

		$this->assertSame( self::IDLE_SECONDS, $entry['on_demand_idle'] );
	}

	public function test_a_topology_without_the_flag_stays_resident(): void {
		$this->write_tsl( 'marmot-resident', "make_node Echo marmot-echo\n" );

		$entry = Topology_Registry::synthesize_entry( 'marmot-resident' );

		$this->assertSame( 0, $entry['on_demand_idle'], 'no window declared means resident' );
	}

	/**
	 * The operator knob, `num_partitions`-shaped: a deployment tunes how eagerly
	 * it scales to zero without editing TSL, and a topology that knows its own
	 * work pattern still overrides. Seeded apart from BOTH the 5s constant and
	 * the 23s frontmatter so neither can pass this by accident.
	 */
	public function test_the_config_default_sizes_a_topology_that_declares_no_window(): void {
		$this->use_base_dir( $this->tmp, [ 'on_demand_idle' => 31 ] );
		$this->write_tsl( 'marmot-ondemand', "make_node Echo marmot-echo\n" );

		// The catalog filter is what injects the operator default, exactly as
		// it injects num_partitions'; synthesize_entry never reads Config.
		$catalog = Topology_Registry::publish_catalog( [] );

		$this->assertSame( 31, $catalog['marmot-ondemand']['on_demand_idle'] );
	}

	public function test_frontmatter_overrides_the_config_default(): void {
		$this->use_base_dir( $this->tmp, [ 'on_demand_idle' => 31 ] );
		$this->write_tsl(
			'marmot-ondemand',
			"var on_demand_idle = " . self::IDLE_SECONDS . "\nmake_node Echo marmot-echo\n"
		);

		$this->assertSame(
			self::IDLE_SECONDS,
			Topology_Registry::synthesize_entry( 'marmot-ondemand' )['on_demand_idle']
		);
	}

	/**
	 * The fleet-wide opt-in: config sets the window, a TSL declaring 0 opts back
	 * out. An ACTIVE topology the catalog filter didn't publish is synthesized
	 * on the spot, and that path has to inject the same operator default — or
	 * the same topology is on-demand or not depending on who asked.
	 */
	public function test_a_synthesized_active_topology_still_gets_the_config_default(): void {
		$this->use_base_dir( $this->tmp, [ 'on_demand_idle' => 31 ] );
		$this->write_tsl( 'marmot-ondemand', "make_node Echo marmot-echo\n" );
		// A catalog that publishes nothing: get_topologies() must synthesize.
		\add_filter( 'newspack_nodes/topologies', static fn (): array => [] );
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = [ 'marmot-ondemand' ];

		$workers = Bootstrap::expand_workers();

		$this->assertSame( 31, $workers[0]['on_demand_idle'] );
	}

	/** And a TSL that declares 0 opts back out of a fleet-wide default. */
	public function test_frontmatter_zero_opts_out_of_the_config_default(): void {
		$this->use_base_dir( $this->tmp, [ 'on_demand_idle' => 31 ] );
		$this->write_tsl( 'marmot-resident', "var on_demand_idle = 0\nmake_node Echo marmot-echo\n" );

		$catalog = Topology_Registry::publish_catalog( [] );

		$this->assertSame( 0, $catalog['marmot-resident']['on_demand_idle'] );
	}

	public function test_expand_workers_carries_on_demand_onto_every_partition(): void {
		$this->write_tsl(
			'marmot-ondemand',
			"var num_partitions = 2\nvar on_demand_idle = " . self::IDLE_SECONDS
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
			$this->assertSame( self::IDLE_SECONDS, $worker['on_demand_idle'] );
		}
	}

	// ── read site 1: the spawn scan ─────────────────────────────────────────

	public function test_an_absent_on_demand_worker_does_not_need_a_spawn(): void {
		$this->assertFalse(
			( new Spawn_Coordinator( $this->tmp ) )
				->worker_needs_spawn( $this->descriptor( self::IDLE_SECONDS ), (float) \time() )
		);
	}

	public function test_an_absent_resident_worker_still_needs_a_spawn(): void {
		$this->assertTrue(
			( new Spawn_Coordinator( $this->tmp ) )
				->worker_needs_spawn( $this->descriptor( 0 ), (float) \time() )
		);
	}

	/** Staleness means a worker died holding the lock — a crash either way. */
	public function test_a_stale_on_demand_lock_still_needs_a_spawn(): void {
		$this->make_lock( 'marmot-ondemand.p0', self::STALE_SECONDS + 1 );

		$this->assertTrue(
			( new Spawn_Coordinator( $this->tmp ) )
				->worker_needs_spawn( $this->descriptor( self::IDLE_SECONDS ), (float) \time() )
		);
	}

	public function test_a_live_on_demand_lock_needs_no_spawn(): void {
		$this->make_lock( 'marmot-ondemand.p0', 0 );

		$this->assertFalse(
			( new Spawn_Coordinator( $this->tmp ) )
				->worker_needs_spawn( $this->descriptor( self::IDLE_SECONDS ), (float) \time() )
		);
	}

	// ── read site 2: the alert evaluator ────────────────────────────────────

	public function test_an_absent_on_demand_worker_raises_no_alert(): void {
		$this->activate( self::IDLE_SECONDS );

		$this->assertSame( [], $this->liveness_alerts() );
	}

	public function test_an_absent_resident_worker_still_raises_an_alert(): void {
		$this->activate( 0 );

		$keys = \array_column( $this->liveness_alerts(), 'key' );

		$this->assertSame( [ 'worker_missing:marmot-ondemand.p0' ], $keys );
	}

	/** A crashed on-demand worker is still a crash: stale keeps its alert. */
	public function test_a_stale_on_demand_worker_still_raises_an_alert(): void {
		$this->activate( self::IDLE_SECONDS );
		$this->make_lock( 'marmot-ondemand.p0', self::STALE_SECONDS + 1 );

		$keys = \array_column( $this->liveness_alerts(), 'key' );

		$this->assertSame( [ 'worker_down:marmot-ondemand.p0' ], $keys );
	}

	// ── read site 3: wp nodes status ────────────────────────────────────────

	/** `down` invites an operator to restart by hand and call the feature broken. */
	public function test_status_renders_an_absent_on_demand_worker_as_idle(): void {
		$this->activate( self::IDLE_SECONDS );

		( new Worker_CLI_Command() )->status( [], [] );

		$this->assertStringContainsString( 'idle', $this->cli_output() );
		$this->assertStringNotContainsString( 'down', $this->cli_output() );
	}

	public function test_status_still_renders_an_absent_resident_worker_as_down(): void {
		$this->activate( 0 );

		( new Worker_CLI_Command() )->status( [], [] );

		$this->assertStringContainsString( 'down', $this->cli_output() );
	}

	public function test_status_still_renders_a_stale_on_demand_worker_as_stale(): void {
		$this->activate( self::IDLE_SECONDS );
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
		$this->activate( self::IDLE_SECONDS );
		$captured                        = [];
		Topology_Registry::$spawn_runner = static function ( array $descriptor ) use ( &$captured ): void {
			$captured = $descriptor;
		};

		Topology_Registry::spawn_worker( 'marmot-ondemand', 0 );

		$this->assertSame( self::IDLE_SECONDS, $captured['on_demand_idle'] );
		$this->assertSame( self::STALE_SECONDS, $captured['stale_timeout'] );
		$this->assertSame( 'marmot-ondemand', $captured['topology'] );
	}

	private function cli_output(): string {
		return \implode( "\n", $GLOBALS['_test_wp_cli_logs'] ?? [] );
	}

	/** Activate one single-partition topology, on-demand or not. */
	private function activate( int $on_demand_idle = self::IDLE_SECONDS ): void {
		$entry = [
			'topology'       => 'marmot-ondemand',
			'num_partitions' => 1,
			'stale_timeout'  => self::STALE_SECONDS,
			'on_demand_idle' => $on_demand_idle,
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
