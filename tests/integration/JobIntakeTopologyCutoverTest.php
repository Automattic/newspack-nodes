<?php
/**
 * Cutover test for the stock `job-intake.tsl` topology.
 *
 * Pins the load-bearing invariant of moving Job_Intake to the substrate: a job
 * written through `Job_Intake::queue()` into jobintake.log is drained by the
 * `job-intake` topology's Consumer into jobs.log, and the durable offsetlog
 * frame lands at `jobintake.jobs.p<N>` — the SAME cursor path the old ELN
 * job-router leg used, so a real deploy resumes from the existing cursor with
 * no re-read and no gap.
 */

namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Job_Intake;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Topology_Loader;
use Newspack_Nodes\Topology_Registry;

class JobIntakeTopologyCutoverTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$GLOBALS['_wp_actions'] = [];
		$this->tmp              = $this->make_temp_dir( 'newspack-jobintake-cutover-' );
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => 1 ] );
		// The stock job-intake.tsl ships in the substrate's topologies/ dir; make
		// it resolvable regardless of what an earlier test did to the registry.
		Topology_Registry::register_stock_dir( \dirname( __DIR__, 2 ) . '/topologies' );
	}

	protected function tearDown(): void {
		Topology_Registry::reset();
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** Unpack the newest offsetlog frame from the flat segment dir on disk. */
	private function last_offsetlog_frame( string $dir ): ?array {
		$segment = "{$dir}/0.log";
		if ( ! \file_exists( $segment ) ) {
			return null;
		}
		$bytes = (string) \file_get_contents( $segment );
		$lines = \array_values( \array_filter( \explode( "\n", $bytes ), static fn ( $l ) => '' !== $l ) );
		if ( empty( $lines ) ) {
			return null;
		}
		$message = Message::unpacked( \end( $lines ) );
		$value   = $message[ Message::VALUE ];
		return \is_array( $value ) ? $value : null;
	}

	public function test_job_intake_topology_drains_large_job_and_advances_offsetlog(): void {
		// Mirror the worker graph: nodes sink into _command_interpreter, which
		// forwards TO-addressed messages to _router for path dispatch.
		$router = new Router_Node();
		$router->name( '_router' );
		$interpreter = new Command_Interpreter_Node();
		$interpreter->name( '_command_interpreter' );
		$interpreter->sink( $router );

		Topology_Loader::load( 'job-intake', 0, $interpreter );

		$consumer = Core::node( 'jobintake:consumer' );
		$partition = Core::node( 'jobs:partition' );
		$this->assertInstanceOf( Consumer_Node::class, $consumer );
		$this->assertInstanceOf( Partition_Node::class, $partition );

		// A >4KB payload forces the locked large-write ingress path (ADR-4).
		$big = \str_repeat( 'x', 8000 );
		$this->assertTrue( Job_Intake::queue( 'process_image', [ 'data' => $big ] ) );
		$this->assertFileExists( "{$this->tmp}/logs/jobintake.p0/0.log" );

		// No durable offsetlog frame before the drain.
		// `<topology>` scopes the cursor to the FLEET (job-intake here).
		$offset_dir = "{$this->tmp}/offsets/jobintake.job-intake.p0";
		$this->assertNull( $this->last_offsetlog_frame( $offset_dir ), 'no checkpoint before draining' );

		$this->pump_consumer( $consumer );
		// poll() advances the cursor in memory; checkpoint() makes it durable.
		$consumer->checkpoint();
		$partition->flush();

		// The job landed in jobs.p0 with the same {k, handler, parameters} shape.
		$jobs = $this->read_partition_values( $partition );
		$this->assertCount( 1, $jobs );
		$this->assertSame( 'job', $jobs[0]['k'] );
		$this->assertSame( 'process_image', $jobs[0]['handler'] );
		$this->assertSame( $big, $jobs[0]['parameters']['data'] );

		// The offsetlog frame advanced past 0 on the SAME jobintake.job-intake.p0 path.
		$frame = $this->last_offsetlog_frame( $offset_dir );
		$this->assertNotNull( $frame, 'draining must commit a durable offsetlog frame' );
		$this->assertGreaterThan( 0, Core::num_int( $frame['offset'] ?? 0 ), 'cursor advanced past the consumed job' );
	}
}
