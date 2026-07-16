<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Job_Intake;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Job_Intake::class )]
class JobIntakeTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'newspack-jobintake-test-' );
		mkdir( "{$this->tmp}/locks", 0755, true );
		mkdir( "{$this->tmp}/logs", 0755, true );
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function read_all_jobintake_lines(): array {
		$lines    = [];
		$logs_dir = "{$this->tmp}/logs";
		if ( ! is_dir( $logs_dir ) ) {
			return $lines;
		}
		// Walk every flat jobintake.p* partition dir + every segment. Each line
		// on disk is a packed Tachikoma Message carrying the envelope in VALUE.
		foreach ( scandir( $logs_dir ) as $entry ) {
			if ( ! preg_match( '/^jobintake\.p\d+$/', $entry ) ) {
				continue;
			}
			$pdir = "{$logs_dir}/{$entry}";
			if ( ! is_dir( $pdir ) ) {
				continue;
			}
			foreach ( scandir( $pdir ) as $f ) {
				if ( ! preg_match( '/^\d+\.log$/', $f ) ) {
					continue;
				}
				$content = file_get_contents( "{$pdir}/{$f}" );
				if ( '' === $content ) {
					continue;
				}
				foreach ( preg_split( '/\n/', rtrim( $content, "\n" ) ) as $line ) {
					if ( '' === $line ) {
						continue;
					}
					$message     = Message::unpacked( $line );
					$decoded = $message[ Message::VALUE ];
					if ( \is_array( $decoded ) ) {
						$lines[] = $decoded;
					}
				}
			}
		}
		return $lines;
	}

	// --- Validation ---------------------------------------------------------

	public function test_rejects_invalid_handler_name(): void {
		$intake = new Job_Intake( $this->tmp );
		$this->assertFalse( $intake->write_job( 'Bad-Name!', [] ) );
		$intake->close();
	}

	public function test_accepts_alphanumeric_underscore_handler(): void {
		$intake = new Job_Intake( $this->tmp );
		$this->assertTrue( $intake->write_job( 'good_handler', [ 'x' => 1 ] ) );
		$intake->close();
	}

	public function test_accepts_dashed_handler(): void {
		// HANDLER_NAME_PATTERN matches upstream — permissive at intake.
		$intake = new Job_Intake( $this->tmp );
		$this->assertTrue( $intake->write_job( 'sync-settings', [ 'x' => 1 ] ) );
		$intake->close();
	}

	public function test_static_queue_validates_before_lock(): void {
		// Fail-fast: invalid handler name MUST return false without ever touching
		// the filesystem (validate before entering the retry loop).
		$this->assertFalse( Job_Intake::queue( '!bad', [], null, $this->tmp ) );
		$this->assertFalse( is_dir( "{$this->tmp}/locks/jobintake.lock.d" ) );
	}

	// --- Write semantics ----------------------------------------------------

	public function test_write_job_writes_envelope_to_partition_log(): void {
		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );
		$this->assertTrue( $intake->write_job( 'sync', [ 'opt' => 'log_urls' ] ) );
		$intake->close();

		$lines = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $lines );
		$this->assertSame( 'job', $lines[0]['k'] );
		$this->assertSame( 'sync', $lines[0]['handler'] );
		$this->assertSame( [ 'opt' => 'log_urls' ], $lines[0]['parameters'] );
		$this->assertArrayHasKey( 'ts', $lines[0] );
	}

	public function test_pinned_partition_routes_all_writes_to_one_dir(): void {
		$intake = new Job_Intake( $this->tmp, num_partitions: 4 );
		$intake->partition( 2 );

		$this->assertTrue( $intake->write_job( 'a', [] ) );
		$this->assertTrue( $intake->write_job( 'a', [] ) );
		$intake->close();

		$this->assertTrue( is_dir( "{$this->tmp}/logs/jobintake.p2" ) );
		// Other partitions should not have segments materialized.
		$this->assertFalse( is_dir( "{$this->tmp}/logs/jobintake.p0" ) );
		$this->assertFalse( is_dir( "{$this->tmp}/logs/jobintake.p1" ) );
		$this->assertFalse( is_dir( "{$this->tmp}/logs/jobintake.p3" ) );
	}

	public function test_keyed_routing_uses_hash_to_partition(): void {
		// Same key → same partition every time. Guaranteed by Partition::hash_to_partition.
		$intake = new Job_Intake( $this->tmp, num_partitions: 4 );
		$expected = Partition_Node::hash_to_partition( 'event_42', 4 );
		$this->assertTrue( $intake->write_job( 'sync', [ 'eid' => 42 ], 'event_42' ) );
		$this->assertTrue( $intake->write_job( 'sync', [ 'eid' => 42 ], 'event_42' ) );
		$intake->close();

		$this->assertTrue( is_dir( "{$this->tmp}/logs/jobintake.p{$expected}" ) );
	}

	public function test_round_robin_distribution(): void {
		$intake = new Job_Intake( $this->tmp, num_partitions: 4 );
		// Issue 8 writes; the round-robin counter advances monotonically.
		for ( $i = 0; $i < 8; $i++ ) {
			$this->assertTrue( $intake->write_job( 'noop', [ 'i' => $i ] ) );
		}
		$intake->close();

		// At least two distinct partition dirs must exist (round-robin actually
		// distributed). With 8 writes over 4 partitions every dir should appear.
		$pdirs = array_filter(
			scandir( "{$this->tmp}/logs" ),
			static fn ( $f ) => preg_match( '/^jobintake\.p\d+$/', $f )
		);
		$this->assertGreaterThanOrEqual( 2, count( $pdirs ) );
	}

	public function test_oversized_payload_rejected(): void {
		// 33MB JSON > MAX_JOB_SIZE 32MB.
		$intake = new Job_Intake( $this->tmp );
		$big    = str_repeat( 'x', 33 * 1024 * 1024 );
		$this->assertFalse( $intake->write_job( 'big', [ 'data' => $big ] ) );
		$intake->close();
	}

	// --- queue_many batching ------------------------------------------------

	public function test_queue_many_writes_a_batch(): void {
		// Batch API: multiple writes under the open intake, all land on disk.
		$jobs = [
			[ 'handler' => 'a', 'parameters' => [ 1 ] ],
			[ 'handler' => 'b', 'parameters' => [ 2 ] ],
			[ 'handler' => 'c', 'parameters' => [ 3 ] ],
		];

		$intake = new Job_Intake( $this->tmp );
		$this->assertSame( 3, $intake->queue_many( $jobs ) );
		$intake->close();

		$lines = $this->read_all_jobintake_lines();
		$this->assertCount( 3, $lines );
		$handlers = array_column( $lines, 'handler' );
		$this->assertContains( 'a', $handlers );
		$this->assertContains( 'b', $handlers );
		$this->assertContains( 'c', $handlers );
	}

	public function test_queue_many_skips_malformed_entries(): void {
		$jobs = [
			[ 'handler' => 'good', 'parameters' => [ 'x' => 1 ] ],
			[ 'handler' => 123, 'parameters' => [] ],          // non-string handler
			[ 'handler' => 'good2', 'parameters' => 'not-array' ], // non-array parameters
			[ 'handler' => 'good3', 'parameters' => [] ],
		];
		$intake = new Job_Intake( $this->tmp );
		$this->assertSame( 2, $intake->queue_many( $jobs ) );
		$intake->close();
	}

	// --- Lock semantics -----------------------------------------------------
	//
	// Locking is per-Partition (in `Partition::allow_large_writes()` at
	// `{partition_dir}/write.lock.d/`). No intake-level host-wide lock.

	public function test_write_job_acquires_partition_lock(): void {
		// Writing materializes the Partition + its per-partition write lock.
		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$this->assertTrue( $intake->write_job( 'a', [] ) );
		$this->assertTrue( is_dir( "{$this->tmp}/logs/jobintake.p0/write.lock.d" ) );
		// No host-wide intake lock created.
		$this->assertFalse( is_dir( "{$this->tmp}/locks/jobintake.lock.d" ) );
		$intake->close();
		// close() removes the Partition node which releases the lock dir.
		$this->assertFalse( is_dir( "{$this->tmp}/logs/jobintake.p0/write.lock.d" ) );
	}

	public function test_destruct_releases_partition_lock(): void {
		// __destruct calls close(); per-partition lock should be released even
		// if the caller forgets to call close() explicitly.
		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->write_job( 'a', [] );
		$this->assertTrue( is_dir( "{$this->tmp}/logs/jobintake.p0/write.lock.d" ) );
		unset( $intake );
		$this->assertFalse( is_dir( "{$this->tmp}/logs/jobintake.p0/write.lock.d" ) );
	}

	public function test_writes_to_different_partitions_do_not_contend(): void {
		// Per-Partition locking means a writer on p0 doesn't block a writer
		// on p1 — the legacy host-wide intake lock used to gate both.
		$first = new Job_Intake( $this->tmp, num_partitions: 4 );
		$first->partition( 0 );
		$this->assertTrue( $first->write_job( 'a', [] ) );

		$second = new Job_Intake( $this->tmp, num_partitions: 4 );
		$second->partition( 1 );
		$this->assertTrue( $second->write_job( 'b', [] ) );

		$first->close();
		$second->close();
	}

	// --- Static queue() helper ----------------------------------------------

	public function test_static_queue_writes_single_job(): void {
		$this->assertTrue( Job_Intake::queue( 'a_handler', [ 'x' => 1 ], null, $this->tmp ) );
		$lines = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $lines );
		$this->assertSame( 'a_handler', $lines[0]['handler'] );
	}

	public function test_static_queue_with_key_routes_consistently(): void {
		$expected = Partition_Node::hash_to_partition( 'k', 4 );
		$this->assertTrue( Job_Intake::queue( 'a', [], 'k', $this->tmp, 4 ) );
		$this->assertTrue( is_dir( "{$this->tmp}/logs/jobintake.p{$expected}" ) );
	}

	public function test_static_queue_releases_lock_after_call(): void {
		// Single-shot calls must release the per-Partition lock so another
		// caller can immediately queue another job.
		Job_Intake::queue( 'a', [], null, $this->tmp, 1 );
		$this->assertFalse( is_dir( "{$this->tmp}/logs/jobintake.p0/write.lock.d" ) );

		// Second call succeeds without contention.
		$this->assertTrue( Job_Intake::queue( 'b', [], null, $this->tmp, 1 ) );
	}

	// --- Config fail-loud (no silent /tmp/newspack-nodes default) -----------

	public function test_constructor_propagates_throw_when_base_directory_unconfigured(): void {
		// With no explicit base_dir AND base_directory unconfigured, the
		// constructor's config fallback must propagate the strict accessor's
		// RuntimeException — NOT silently default to `/tmp/newspack-nodes`.
		$prev_env = \getenv( 'LOCAL_NEWSPACK_NODES_CONF' );
		$conf     = "{$this->tmp}/empty-base.php";
		\file_put_contents( $conf, "<?php\nreturn [ 'base_directory' => '' ];\n" );
		\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . $conf );
		\update_option( 'newspack_nodes_base_directory', '' );
		\Newspack_Nodes\Config::reset();

		try {
			$this->expectException( \RuntimeException::class );
			$this->expectExceptionMessageMatches( '/base_directory not configured/' );
			new Job_Intake();
		} finally {
			\putenv( 'LOCAL_NEWSPACK_NODES_CONF=' . ( false === $prev_env ? '' : $prev_env ) );
			\Newspack_Nodes\Config::reset();
		}
	}

	/**
	 * A leak the router shouted about once per job:
	 *   `_router: WARNING: jobintake.<pid>-<n>.p0:heartbeat forgot to unregister`
	 *
	 * A locked Partition arms a `:heartbeat` Timer that REGISTERS with _router for
	 * TIMER (only when the Event_Framework is draining — i.e. in a worker, which
	 * is why no unit test caught it). Tearing the Partition down left that
	 * registration behind, pointing at a name that no longer resolves, so every
	 * tick the router walked a dangling entry and shouted. The Partition owns the
	 * sibling; remove_node() must remove it (Timer::remove_node() unregisters).
	 */
	public function test_removing_a_locked_partition_unregisters_its_heartbeat(): void {
		$router = new Router_Node();
		$router->name( Node_Names::ROUTER );
		// Arm the heartbeat the way a worker does: the EF is draining.
		$ef       = \Newspack_Nodes\Event_Framework::instance();
		$draining = new \ReflectionProperty( $ef, 'draining' );
		$draining->setValue( $ef, true );

		$p = new Partition_Node();
		$p->name( 'zebra:partition' );
		$p->sink( new \Newspack_Nodes\Tests\Capture_Sink_Node() );
		$p->arguments( [ "{$this->tmp}/zebra.p0" ] );
		$p->allow_large_writes();

		$armed = \array_keys( $this->read_private( $router, 'registrations' )['TIMER'] ?? [] );
		$this->assertContains( 'zebra:partition:heartbeat', $armed );

		$p->remove_node();

		$left = \array_keys( $this->read_private( $router, 'registrations' )['TIMER'] ?? [] );
		$this->assertNotContains(
			'zebra:partition:heartbeat',
			$left,
			'removing the Partition must unregister its heartbeat, not orphan it'
		);
		$draining->setValue( $ef, false );
	}
}
