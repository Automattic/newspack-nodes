<?php
/**
 * Sibling-node contract for Job_Intake's internally-created Partition.
 *
 * The Partition materialized in `partition_handle()` is a SIBLING: a utility
 * node created inside a helper as internal plumbing. Per the make_node
 * discipline (Rule 2 / Rule 4) it MUST be named, have its patron set (so
 * dump_metadata hides it from the canvas), and be sunk into the
 * `_command_interpreter` when one is in scope (Rule 4 skips the sink when no
 * interpreter is registered — request-scope helper with no graph).
 */

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Job_Intake;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Job_Intake::class )]
class JobIntakePatronTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'newspack-jobintake-patron-' );
		\mkdir( "{$this->tmp}/locks", 0755, true );
		\mkdir( "{$this->tmp}/logs", 0755, true );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** Locate the materialized jobintake Partition in Core's registry. */
	private function find_jobintake_partition(): ?Partition_Node {
		foreach ( Core::$nodes_by_name as $name => $node ) {
			if ( $node instanceof Partition_Node && 0 === \strpos( $name, 'jobintake.' ) ) {
				return $node;
			}
		}
		return null;
	}

	public function test_partition_is_named(): void {
		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );
		$intake->write_job( 'a', null, [] );

		$p = $this->find_jobintake_partition();
		$this->assertNotNull( $p, 'jobintake Partition must be registered by name' );
		$this->assertStringStartsWith( 'jobintake.', $p->name() );
		$this->assertStringEndsWith( '.p0', $p->name() );

		$intake->close();
	}

	public function test_partition_has_patron_set(): void {
		// The sibling Partition is plumbing — its patron must be non-null so
		// dump_metadata hides it from the topology console canvas.
		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );
		$intake->write_job( 'a', null, [] );

		$p = $this->find_jobintake_partition();
		$this->assertNotNull( $p );
		$this->assertNotNull( $p->patron(), 'sibling Partition must have a patron (marks it as plumbing)' );

		$intake->close();
	}

	public function test_partition_sunk_into_command_interpreter_when_present(): void {
		// Rule 4: an in-scope `_command_interpreter` becomes the sibling's sink.
		$ci = new Command_Interpreter_Node();
		$ci->name( Node_Names::COMMAND_INTERPRETER );

		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );
		$intake->write_job( 'a', null, [] );

		$p = $this->find_jobintake_partition();
		$this->assertNotNull( $p );
		$this->assertSame( $ci, $p->sink(), 'sibling Partition must sink into the interpreter when one is registered' );

		$intake->close();
	}

	public function test_partition_named_and_patron_set_without_interpreter(): void {
		// Rule 4 exception: no `_command_interpreter` in scope — still NAME +
		// set patron, but skip the interpreter sink (no fatal, sink stays null).
		$this->assertNull( Core::node( Node_Names::COMMAND_INTERPRETER ) );

		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );
		$intake->write_job( 'a', null, [] );

		$p = $this->find_jobintake_partition();
		$this->assertNotNull( $p );
		$this->assertStringStartsWith( 'jobintake.', $p->name() );
		$this->assertNotNull( $p->patron() );
		$this->assertNull( $p->sink(), 'with no interpreter in scope the sibling sink stays null (Rule 4)' );

		$intake->close();
	}
}
