<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Job_Intake;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\Helpers\InMemoryMemcached;
use Newspack_Nodes\Tests\TestCase;

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

	private function read_all_jobintake_lines( string $dir_pattern = '/^jobintake\.p\d+$/' ): array {
		$lines    = [];
		$logs_dir = "{$this->tmp}/logs";
		if ( ! is_dir( $logs_dir ) ) {
			return $lines;
		}
		// Walk every flat jobintake.p* partition dir + every segment. Each line
		// on disk is a packed Tachikoma Message carrying the envelope in VALUE.
		foreach ( scandir( $logs_dir ) as $entry ) {
			if ( ! preg_match( $dir_pattern, $entry ) ) {
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
		$this->assertFalse( Job_Intake::queue( '!bad', [], null, null, $this->tmp ) );
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

	/**
	 * feed() is the small-job ingress: the same envelope write_job() produces,
	 * on its own log, so a spoke's job-router can tail jobs alone instead of
	 * the whole firehose.
	 */
	public function test_feed_writes_the_job_envelope_to_the_jobfeed_log(): void {
		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );

		$this->assertTrue( $intake->write_feed( 'zarquon', [ 'site' => 7391 ] ) );
		$intake->close();

		$lines = $this->read_all_jobintake_lines( '/^jobfeed\.p\d+$/' );
		$this->assertCount( 1, $lines );
		$this->assertSame( 'job', $lines[0]['k'] );
		$this->assertSame( 'zarquon', $lines[0]['handler'] );
		$this->assertSame( [ 'site' => 7391 ], $lines[0]['parameters'] );
		$this->assertSame( [], $this->read_all_jobintake_lines(), 'jobintake is the large-write log; feed() must not touch it' );
	}

	/**
	 * feed() takes no write lock, so it is bound by PIPE_BUF. An entry that
	 * only fits under the lifted cap has to be refused — loudly, so the caller
	 * routes it to queue() instead of losing it.
	 */
	public function test_feed_refuses_an_entry_that_needs_the_lifted_cap(): void {
		$oversized = [ 'blob' => str_repeat( 'z', Partition_Node::MAX_LINE_SIZE ) ];

		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );
		$this->assertFalse( $intake->write_feed( 'zarquon', $oversized ), 'over PIPE_BUF: refused' );
		$this->assertTrue( $intake->write_job( 'zarquon', $oversized ), 'the locked path still takes it' );
		$intake->close();

		$this->assertSame( [], $this->read_all_jobintake_lines( '/^jobfeed\.p\d+$/' ) );
		$this->assertCount( 1, $this->read_all_jobintake_lines() );
	}

	/**
	 * jobfeed rotates at 1 MiB, not the 64 MiB Partition default: it is a
	 * high-rate log every logged request can write to, and a job-router only
	 * ever wants the recent tail of it.
	 */
	public function test_feed_rotates_segments_at_its_own_threshold(): void {
		$entry = [ 'blob' => str_repeat( 'z', 3000 ) ];
		$writes = (int) ceil( ( Job_Intake::FEED_SEGMENT_SIZE * 1.2 ) / 3000 );

		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );
		for ( $i = 0; $i < $writes; $i++ ) {
			$this->assertTrue( $intake->write_feed( 'zarquon', $entry ) );
		}
		$intake->close();

		$segments = glob( "{$this->tmp}/logs/jobfeed.p0/*.log" ) ?: [];
		sort( $segments );
		$this->assertGreaterThan( 1, count( $segments ), 'past 1 MiB, jobfeed has rotated' );
		// A closed segment lands within one record of the threshold. Pins the
		// size itself, not merely that it rotated at some point.
		$closed = filesize( $segments[0] );
		$this->assertLessThan(
			3200,
			abs( $closed - Job_Intake::FEED_SEGMENT_SIZE ),
			"closed segment {$closed} should sit within one record of the threshold"
		);
	}

	/**
	 * The static entry point, mirroring queue(): it validates before touching
	 * the filesystem, and a valid call writes the envelope and closes up.
	 */
	public function test_static_feed_validates_then_writes_the_jobfeed_envelope(): void {
		$this->assertFalse( Job_Intake::feed( '!bad', [], null, null, $this->tmp, 1 ) );
		$this->assertSame( [], glob( "{$this->tmp}/logs/jobfeed.p*" ) ?: [] );

		$this->assertTrue( Job_Intake::feed( 'zarquon', [ 'site' => 7391 ], null, 'run-8812', $this->tmp, 1 ) );

		$lines = $this->read_all_jobintake_lines( '/^jobfeed\.p\d+$/' );
		$this->assertCount( 1, $lines );
		$this->assertSame( 'zarquon', $lines[0]['handler'] );
		$this->assertSame( [ 'site' => 7391 ], $lines[0]['parameters'] );
		$this->assertSame( 'run-8812', $lines[0]['id'] );
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

	public function test_write_job_stamps_top_level_id_when_given(): void {
		// Optional identity for durable jobstats — key stats per "handler:id".
		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );
		$this->assertTrue( $intake->write_job( 'cron', [ 'opt' => 1 ], null, 'import-films' ) );
		$intake->close();

		$lines = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $lines );
		$this->assertSame( 'import-films', $lines[0]['id'] );
	}

	public function test_static_queue_carries_the_id_through_to_the_entry(): void {
		// The large-write counterpart of feed()'s id, and the same position in
		// the signature. It used to be hardwired null here, so a job over
		// PIPE_BUF lost the identity its jobstats are keyed by while the small
		// one beside it kept it.
		$this->assertTrue(
			Job_Intake::queue( 'cron', [ 'opt' => 1 ], null, 'films-seed-5501', $this->tmp, 1 )
		);

		$lines = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $lines );
		$this->assertSame( 'films-seed-5501', $lines[0]['id'] );
	}

	public function test_write_job_rejects_an_overlong_id(): void {
		// The id rides in every jobstats record KEY — bound it at the producer
		// boundary so a runaway id can't bloat records toward the PIPE_BUF cap.
		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );
		$this->assertFalse( $intake->write_job( 'cron', [], null, str_repeat( 'z', 129 ) ) );
		$this->assertTrue( $intake->write_job( 'cron', [], null, str_repeat( 'z', 128 ) ) );
		$intake->close();

		$lines = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $lines, 'the overlong-id job was never written' );
		$this->assertSame( str_repeat( 'z', 128 ), $lines[0]['id'] );
	}

	public function test_write_job_omits_id_key_when_not_given(): void {
		// Wire consumers pass nothing → today's behavior (no `id` key at all).
		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );
		$this->assertTrue( $intake->write_job( 'cron', [ 'opt' => 1 ] ) );
		$intake->close();

		$lines = $this->read_all_jobintake_lines();
		$this->assertArrayNotHasKey( 'id', $lines[0] );
	}

	public function test_queue_many_threads_per_job_id(): void {
		$intake = new Job_Intake( $this->tmp, num_partitions: 1 );
		$intake->partition( 0 );
		$this->assertSame( 1, $intake->queue_many( [
			[ 'handler' => 'cron', 'parameters' => [], 'id' => 'nightly' ],
		] ) );
		$intake->close();

		$lines = $this->read_all_jobintake_lines();
		$this->assertSame( 'nightly', $lines[0]['id'] );
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
		$this->assertTrue( Job_Intake::queue( 'a_handler', [ 'x' => 1 ], null, null, $this->tmp ) );
		$lines = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $lines );
		$this->assertSame( 'a_handler', $lines[0]['handler'] );
	}

	public function test_static_queue_with_key_routes_consistently(): void {
		$expected = Partition_Node::hash_to_partition( 'k', 4 );
		$this->assertTrue( Job_Intake::queue( 'a', [], 'k', null, $this->tmp, 4 ) );
		$this->assertTrue( is_dir( "{$this->tmp}/logs/jobintake.p{$expected}" ) );
	}

	public function test_static_queue_releases_lock_after_call(): void {
		// Single-shot calls must release the per-Partition lock so another
		// caller can immediately queue another job.
		Job_Intake::queue( 'a', [], null, null, $this->tmp, 1 );
		$this->assertFalse( is_dir( "{$this->tmp}/logs/jobintake.p0/write.lock.d" ) );

		// Second call succeeds without contention.
		$this->assertTrue( Job_Intake::queue( 'b', [], null, null, $this->tmp, 1 ) );
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

	// --- Options: delayed / retries / unique / batch ------------------------

	private function read_all_jobdelay_lines(): array {
		return $this->read_all_jobintake_lines( '/^jobdelay\.p0$/' );
	}

	public function test_not_before_future_routes_to_jobdelay(): void {
		$intake = new Job_Intake( $this->tmp, 4 );
		$due    = \microtime( true ) + 500.0;
		$this->assertTrue( $intake->write_job( 'delayed_h', [ 'z' => 9 ], 'affkey', 'id7', [ 'not_before' => $due ] ) );
		$intake->close();

		$this->assertSame( [], $this->read_all_jobintake_lines(), 'a future job must not enter jobintake' );
		$lines = $this->read_all_jobdelay_lines();
		$this->assertCount( 1, $lines );
		$this->assertSame( 'delayed_h', $lines[0]['handler'] );
		$this->assertSame( 'affkey', $lines[0]['key'], 'partition key must ride the delayed entry for delivery-time hashing' );
		$this->assertSame( 'id7', $lines[0]['id'] );
		$this->assertEqualsWithDelta( $due, $lines[0]['not_before'], 0.001 );
	}

	public function test_log_dir_templates_name_every_dir_the_writer_creates(): void {
		// The templates ARE what Bootstrap registers with the log GC, so a writer
		// that drifts from them writes dirs the sweep will not declare. 3 partitions
		// so a fan-out template must expand and a pinned one must not.
		$intake = new Job_Intake( $this->tmp, 3 );
		for ( $i = 0; $i < 40; $i++ ) {
			$intake->write_job( 'probe_h', [ 'i' => $i ], "key-{$i}" );
			$intake->feed( 'probe_h', [ 'i' => $i ], "key-{$i}" );
		}
		$intake->write_job( 'late_h', [], null, null, [ 'not_before' => \microtime( true ) + 500.0 ] );
		$intake->close();

		$declared = [];
		foreach ( Job_Intake::log_dir_templates( "{$this->tmp}/logs" ) as $template ) {
			for ( $p = 0; $p < 3; $p++ ) {
				$declared[ \basename( Core::resolve_partition_template( $template, $p ) ) ] = true;
			}
		}
		$written = \array_map( 'basename', (array) \glob( "{$this->tmp}/logs/*", GLOB_ONLYDIR ) );

		$this->assertContains( 'jobdelay.p0', $written, 'the probe must have written the pinned delay log' );
		$this->assertSame( [], \array_diff( $written, \array_keys( $declared ) ) );
		$this->assertArrayNotHasKey( 'jobdelay.p1', $declared, 'the delay log is pinned to p0' );
	}

	public function test_not_before_past_routes_to_jobintake_without_delay_fields(): void {
		$intake = new Job_Intake( $this->tmp, 4 );
		$this->assertTrue( $intake->write_job( 'prompt_h', [], 'affkey', null, [ 'not_before' => \microtime( true ) - 5.0 ] ) );
		$intake->close();

		$this->assertSame( [], $this->read_all_jobdelay_lines() );
		$lines = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $lines );
		$this->assertArrayNotHasKey( 'not_before', $lines[0] );
	}

	public function test_keyed_live_entry_carries_its_key_for_retry_affinity(): void {
		$intake = new Job_Intake( $this->tmp, 4 );
		$this->assertTrue( $intake->write_job( 'keyed_h', [], 'affkey' ) );
		$this->assertTrue( $intake->write_job( 'unkeyed_h', [] ) );
		$intake->close();

		$lines = array_column( $this->read_all_jobintake_lines(), null, 'handler' );
		$this->assertSame( 'affkey', $lines['keyed_h']['key'], 'a keyed entry must remember its key so a retry re-parks on the same partition' );
		$this->assertArrayNotHasKey( 'key', $lines['unkeyed_h'] );
	}

	public function test_delay_option_converts_to_not_before(): void {
		$intake = new Job_Intake( $this->tmp, 4 );
		$before = \microtime( true );
		$this->assertTrue( $intake->write_job( 'delayed_h', [], null, null, [ 'delay' => 120 ] ) );
		$intake->close();

		$lines = $this->read_all_jobdelay_lines();
		$this->assertCount( 1, $lines );
		$this->assertGreaterThanOrEqual( $before + 119.0, $lines[0]['not_before'] );
		$this->assertLessThanOrEqual( \microtime( true ) + 121.0, $lines[0]['not_before'] );
	}

	public function test_retries_option_rides_the_entry(): void {
		$intake = new Job_Intake( $this->tmp, 4 );
		$this->assertTrue( $intake->write_job( 'retry_h', [], null, null, [ 'retries' => 4 ] ) );
		$intake->close();

		$lines = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $lines );
		$this->assertSame( 4, $lines[0]['retries'] );
		$this->assertArrayNotHasKey( 'attempt', $lines[0] );
	}

	public function test_unknown_option_throws(): void {
		$intake = new Job_Intake( $this->tmp, 4 );
		try {
			$this->expectException( \InvalidArgumentException::class );
			$this->expectExceptionMessageMatches( '/retrys/' );
			$intake->write_job( 'typo_h', [], null, null, [ 'retrys' => 3 ] );
		} finally {
			$intake->close();
		}
	}

	public function test_unique_without_memcached_throws(): void {
		$prev       = Core::$memd;
		Core::$memd = null;
		$intake     = new Job_Intake( $this->tmp, 4 );
		try {
			// LogicException so the static queue()'s RuntimeException→false
			// lock-contention catch can never silently swallow the misconfig.
			$this->expectException( \LogicException::class );
			$this->expectExceptionMessageMatches( '/memcached/' );
			$intake->write_job( 'uniq_h', [], null, null, [ 'unique' => 'u1', 'unique_ttl' => 77 ] );
		} finally {
			$intake->close();
			Core::$memd = $prev;
		}
	}

	public function test_unique_without_ttl_throws(): void {
		$prev       = Core::$memd;
		Core::$memd = new InMemoryMemcached();
		$intake     = new Job_Intake( $this->tmp, 4 );
		try {
			$this->expectException( \InvalidArgumentException::class );
			$this->expectExceptionMessageMatches( '/unique_ttl/' );
			$intake->write_job( 'uniq_h', [], null, null, [ 'unique' => 'u1' ] );
		} finally {
			$intake->close();
			Core::$memd = $prev;
		}
	}

	public function test_unique_second_enqueue_in_window_is_dropped(): void {
		$prev       = Core::$memd;
		Core::$memd = new InMemoryMemcached();
		$intake     = new Job_Intake( $this->tmp, 4 );
		try {
			$this->assertTrue( $intake->write_job( 'uniq_h', [ 'a' => 1 ], null, null, [ 'unique' => 'warm', 'unique_ttl' => 77 ] ) );
			$this->assertFalse( $intake->write_job( 'uniq_h', [ 'a' => 2 ], null, null, [ 'unique' => 'warm', 'unique_ttl' => 77 ] ) );
			$this->assertTrue( $intake->write_job( 'uniq_h', [ 'a' => 3 ], null, null, [ 'unique' => 'other', 'unique_ttl' => 77 ] ) );
		} finally {
			$intake->close();
			Core::$memd = $prev;
		}
		$this->assertCount( 2, $this->read_all_jobintake_lines(), 'the duplicate enqueue must write nothing' );
	}

	public function test_queue_many_batch_seeds_counter_and_tags_entries(): void {
		$prev       = Core::$memd;
		$memd       = new InMemoryMemcached();
		Core::$memd = $memd;
		$intake     = new Job_Intake( $this->tmp, 4 );
		try {
			$jobs = [
				[ 'handler' => 'batch_h', 'parameters' => [ 'i' => 1 ] ],
				[ 'handler' => 'batch_h', 'parameters' => [ 'i' => 2 ] ],
				[ 'handler' => 'batch_h', 'parameters' => [ 'i' => 3 ] ],
			];
			$this->assertSame( 3, $intake->queue_many( $jobs, null, 'b42' ) );
		} finally {
			$intake->close();
			Core::$memd = $prev;
		}

		$this->assertSame( 3, $memd->get( Job_Intake::batch_count_key( 'b42' ) ) );
		$this->assertSame( 0, $memd->get( Job_Intake::batch_err_key( 'b42' ) ) );
		$lines = $this->read_all_jobintake_lines();
		$this->assertCount( 3, $lines );
		foreach ( $lines as $line ) {
			$this->assertSame( 'b42', $line['batch'] );
		}
	}

	public function test_queue_many_batch_without_memcached_throws(): void {
		$prev       = Core::$memd;
		Core::$memd = null;
		$intake     = new Job_Intake( $this->tmp, 4 );
		try {
			$this->expectException( \LogicException::class );
			$this->expectExceptionMessageMatches( '/memcached/' );
			$intake->queue_many( [ [ 'handler' => 'batch_h', 'parameters' => [] ] ], null, 'b43' );
		} finally {
			$intake->close();
			Core::$memd = $prev;
		}
	}

	public function test_static_queue_passes_options_through(): void {
		$this->assertTrue( Job_Intake::queue( 'opt_h', [], null, null, $this->tmp, 4, [ 'retries' => 2 ] ) );
		$lines = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $lines );
		$this->assertSame( 2, $lines[0]['retries'] );
	}
}
