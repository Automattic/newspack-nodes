<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

class JobWorkerTopologyResolveTest extends TestCase {

	public function test_job_worker_tsl_ships_in_substrate_stock_dir(): void {
		// The substrate's own topologies/ dir is registered as the builtin
		// fallback dir at plugin boot; job-worker.tsl must appear in the catalog union.
		Topology_Registry::register_stock_dir( \dirname( __DIR__, 2 ) . '/topologies' );
		$this->assertContains( 'job-worker', Topology_Registry::list() );
	}

	public function test_job_worker_tsl_resolves_to_a_real_file(): void {
		Topology_Registry::register_stock_dir( \dirname( __DIR__, 2 ) . '/topologies' );
		$path = Topology_Registry::resolve( 'job-worker' );
		$this->assertNotNull( $path );
		$this->assertFileExists( $path );
	}

	public function test_job_worker_tsl_wires_the_jobstats_probe_and_log(): void {
		// The jobstats sweep is declarative now: job-worker.tsl declares the shared
		// jobstats.p0 Partition (1 MiB × 2, min-lifetime 86400, max-lifetime 0), a
		// 15s Job_Probe, and steers the probe at the log via connect_node.
		Topology_Registry::register_stock_dir( \dirname( __DIR__, 2 ) . '/topologies' );
		Topology_Registry::reset_basename_cache();

		$graph   = Topology_Registry::graph_for( 'job-worker' );
		$by_name = [];
		foreach ( $graph['nodes'] as $node ) {
			$by_name[ $node['name'] ] = $node;
		}

		$this->assertArrayHasKey( 'jobstats:log', $by_name, 'the jobstats log Partition must be declared' );
		$this->assertSame( 'partition', $by_name['jobstats:log']['kind'] );
		$this->assertSame( 'jobstats.p0', $by_name['jobstats:log']['writes'] );
		$this->assertSame(
			[ '<config:logs_dir>/jobstats.p0', '1048576', '2', '2', '86400', '0' ],
			$by_name['jobstats:log']['args'],
			'jobstats log must keep the mount geometry: 1 MiB segments, min/max 2, min-lifetime 86400, max-lifetime 0'
		);

		$this->assertArrayHasKey( 'jobstats', $by_name, 'the Job_Probe must be declared' );
		$this->assertSame( 'Job_Probe', $by_name['jobstats']['type'] );
		$this->assertSame( [ '15' ], $by_name['jobstats']['args'], 'Job_Probe sweeps on the 15s cadence' );

		$this->assertContains( [ 'jobstats', 'jobstats:log' ], $graph['edges'], 'the probe must target the log' );
	}
}
