<?php
/**
 * OnDemandWakeTest: enqueue implies spawn.
 *
 * Once `worker_needs_spawn()` stops resurrecting an absent on-demand worker,
 * something else has to bring it back, and cron at minute cadence is the
 * fallback tier rather than the mechanism — a job that waits up to 60s for a
 * tick is worse than the resident worker it replaced. The producer already
 * reaches `Spawn_Coordinator` for the throttle, so it wakes the fleet itself.
 *
 * Fire-and-forget throughout: the blocking enqueue form can wait on a partition
 * lock for longer than `stale_timeout` and get the caller's own lock stolen.
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Core;
use Newspack_Nodes\Job_Intake;
use Newspack_Nodes\Spawn_Coordinator;
use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Spawn_Coordinator::class )]
#[CoversClass( Job_Intake::class )]
class OnDemandWakeTest extends TestCase {

	private string $tmp;

	/** @var array<int,array{url:string,body:array<string,mixed>}> */
	private array $posts = [];

	/** @var \Closure|null */
	private $saved_curl_exec;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp             = $this->make_temp_dir( 'on-demand-wake-' );
		$this->saved_curl_exec = Core::$curl_exec;
		$this->posts           = [];
		\mkdir( "{$this->tmp}/locks", 0755, true );
		\mkdir( "{$this->tmp}/logs", 0755, true );
		$this->use_base_dir( $this->tmp );
		Topology_Registry::reset();
		$posts           = &$this->posts;
		Core::$curl_exec = static function ( \CurlHandle $ch, array $body ) use ( &$posts ) {
			$posts[] = [ 'url' => \curl_getinfo( $ch, \CURLINFO_EFFECTIVE_URL ) ?: '', 'body' => $body ];
			return '';
		};
	}

	protected function tearDown(): void {
		Core::$curl_exec = $this->saved_curl_exec;
		Topology_Registry::reset();
		unset( $GLOBALS['_wp_options']['newspack_nodes_topologies'] );
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** Activate a two-partition topology, on-demand or not. */
	private function activate( string $name, bool $on_demand ): void {
		$entry = [
			'topology'       => $name,
			'num_partitions' => 2,
			'stale_timeout'  => 47,
			'on_demand'      => $on_demand,
			'on_demand_idle' => 23,
		];
		\add_filter(
			'newspack_nodes/topologies',
			static fn ( array $t ): array => $t + [ $name => $entry ]
		);
		$active                                              = $GLOBALS['_wp_options']['newspack_nodes_topologies'] ?? [];
		$active[]                                            = $name;
		$GLOBALS['_wp_options']['newspack_nodes_topologies'] = \array_values( \array_unique( $active ) );
	}

	/** @return list<string> `{type}.p{n}` of every spawn posted. */
	private function woken(): array {
		return \array_map(
			static fn ( array $p ): string => $p['body']['type'] . '.p' . $p['body']['partition'],
			$this->posts
		);
	}

	private function coordinator(): Spawn_Coordinator {
		return new Spawn_Coordinator( $this->tmp );
	}

	public function test_it_wakes_an_absent_on_demand_worker_on_that_partition(): void {
		$this->activate( 'marmot-ondemand', true );

		$this->coordinator()->wake_on_demand( 1, (float) \time() );

		$this->assertSame( [ 'marmot-ondemand.p1' ], $this->woken() );
	}

	public function test_it_leaves_a_resident_topology_to_the_ordinary_spawn_scan(): void {
		$this->activate( 'marmot-resident', false );

		$this->coordinator()->wake_on_demand( 1, (float) \time() );

		$this->assertSame( [], $this->woken() );
	}

	public function test_it_does_not_wake_a_worker_that_is_already_running(): void {
		$this->activate( 'marmot-ondemand', true );
		\mkdir( "{$this->tmp}/locks/marmot-ondemand.p1.lock.d", 0755, true );
		\touch( "{$this->tmp}/locks/marmot-ondemand.p1.lock.d/heartbeat" );

		$this->coordinator()->wake_on_demand( 1, (float) \time() );

		$this->assertSame( [], $this->woken() );
	}

	/** N producers in a burst, one spawn: the 15s throttle is the dedupe. */
	public function test_a_burst_of_enqueues_wakes_the_worker_once(): void {
		$this->activate( 'marmot-ondemand', true );
		$coordinator = $this->coordinator();
		$now         = (float) \time();

		$coordinator->wake_on_demand( 0, $now );
		$coordinator->wake_on_demand( 0, $now + 1.0 );
		$coordinator->wake_on_demand( 0, $now + 2.0 );

		$this->assertSame( [ 'marmot-ondemand.p0' ], $this->woken() );
	}

	/** The producer is the thing that knows work arrived. */
	public function test_writing_a_job_wakes_the_partition_it_landed_on(): void {
		$this->activate( 'marmot-ondemand', true );

		( new Job_Intake( $this->tmp, 2 ) )->partition( 1 )->write_job( 'marmot_handler', [] );

		$this->assertSame( [ 'marmot-ondemand.p1' ], $this->woken() );
	}

	/**
	 * The fleet lookup walks the topology catalog, which globs both topology
	 * dirs and parses every `.tsl`. Doing that per job turns one batch write
	 * into N directory scans, so the coordinator and its fleet are resolved once.
	 */
	public function test_a_batch_resolves_the_fleet_once_not_once_per_job(): void {
		$this->activate( 'marmot-ondemand', true );
		$scans = 0;
		\add_filter(
			'newspack_nodes/topologies',
			static function ( array $t ) use ( &$scans ): array {
				++$scans;
				return $t;
			}
		);

		( new Job_Intake( $this->tmp, 2 ) )->partition( 1 )->queue_many( [
			[ 'handler' => 'marmot_handler', 'parameters' => [] ],
			[ 'handler' => 'marmot_handler', 'parameters' => [] ],
			[ 'handler' => 'marmot_handler', 'parameters' => [] ],
		] );

		$this->assertSame( 1, $scans, 'one catalog walk for the whole batch' );
		$this->assertSame( [ 'marmot-ondemand.p1' ], $this->woken() );
	}

	/** A parked job is not due; Job_Delay circulates it when it is. */
	public function test_a_delayed_job_wakes_nothing_yet(): void {
		$this->activate( 'marmot-ondemand', true );

		( new Job_Intake( $this->tmp, 2 ) )
			->partition( 0 )
			->write_job( 'marmot_handler', [], null, null, [ 'delay' => 3600 ] );

		$this->assertSame( [], $this->woken() );
	}

	public function test_writing_a_job_wakes_nothing_when_no_topology_is_on_demand(): void {
		$this->activate( 'marmot-resident', false );

		( new Job_Intake( $this->tmp, 2 ) )->partition( 1 )->write_job( 'marmot_handler', [] );

		$this->assertSame( [], $this->woken() );
	}
}
