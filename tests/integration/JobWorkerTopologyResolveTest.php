<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Topology_Registry;
use Newspack_Nodes\Tests\TestCase;

class JobWorkerTopologyResolveTest extends TestCase {

	public function test_job_worker_tsl_ships_in_substrate_stock_dir(): void {
		// The substrate's own topologies/ dir is registered as a stock dir at
		// plugin boot; job-worker.tsl must appear in the catalog union.
		Topology_Registry::register_stock_dir( \dirname( __DIR__, 2 ) . '/topologies' );
		$this->assertContains( 'job-worker', Topology_Registry::list() );
	}

	public function test_job_worker_tsl_resolves_to_a_real_file(): void {
		Topology_Registry::register_stock_dir( \dirname( __DIR__, 2 ) . '/topologies' );
		$path = Topology_Registry::resolve( 'job-worker' );
		$this->assertNotNull( $path );
		$this->assertFileExists( $path );
	}
}
