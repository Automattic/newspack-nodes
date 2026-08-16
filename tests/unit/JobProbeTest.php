<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Jobstats_Record;
use Newspack_Nodes\Job_Probe_Node;
use Newspack_Nodes\Job_Worker_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Probe_Node;
use Newspack_Nodes\Topic_Probe_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Job_Probe sweeps this process's Job_Workers (the jobs analog of Topic_Probe's
 * Consumer sweep) and emits ONE lean positional Jobstats_Record snapshot per job
 * identity per tick into its sink (the shared jobstats log). The Message TIMESTAMP
 * is the sweep instant; the cumulative counters are folded downstream into rates.
 */
#[CoversClass( Job_Probe_Node::class )]
#[CoversClass( Probe_Node::class )]
class JobProbeTest extends TestCase {

	/**
	 * Job_Probe and Topic_Probe are ONE mechanism with two filters. The cadence
	 * argument, the timer default, the sweep loop and the clean-shutdown flush
	 * live in `Probe_Node`; a subclass that redeclares any of them is the
	 * copy-paste coming back.
	 */
	public function test_both_probes_inherit_one_sweep_implementation(): void {
		foreach ( [ Job_Probe_Node::class, Topic_Probe_Node::class ] as $probe ) {
			foreach ( [ '__construct', 'arguments', 'fire', 'shutdown_sweep' ] as $method ) {
				$this->assertSame(
					Probe_Node::class,
					( new \ReflectionMethod( $probe, $method ) )->getDeclaringClass()->getName(),
					"{$probe}::{$method}() must not redeclare the shared sweep"
				);
			}
		}
	}

	protected function setUp(): void {
		parent::setUp();
		// A real clock instant so the first fire clears the interval gate.
		Core::$now = 1000;
	}

	/** @return array<int,int|string> A filled 12-slot Jobstats_Record. */
	private function make_record( string $key, string $handler, int $runs ): array {
		$r                                    = [];
		$r[ Jobstats_Record::IDENTITY ]            = $key;
		$r[ Jobstats_Record::HANDLER ]        = $handler;
		$r[ Jobstats_Record::RUNS_DELTA ]     = $runs;
		$r[ Jobstats_Record::ERRORS_DELTA ]   = 0;
		$r[ Jobstats_Record::DURATION_MS_DELTA ] = 12;
		$r[ Jobstats_Record::QUEUE_MS_DELTA ] = 3;
		$r[ Jobstats_Record::ITEMS_OK_DELTA ] = 5;
		$r[ Jobstats_Record::ITEMS_ERR_DELTA ] = 0;
		$r[ Jobstats_Record::LAST_TS ]        = 999;
		$r[ Jobstats_Record::LAST_DURATION_MS ] = 8;
		$r[ Jobstats_Record::LAST_STATUS ]    = 'success';
		$r[ Jobstats_Record::LAST_MESSAGE ]   = 'Job completed successfully';
		$r[ Jobstats_Record::ELAPSED_MS ]     = 15000;
		return $r;
	}

	/** A registered Job_Worker whose probe_stats() returns canned records. */
	private function stub_worker( string $name, array $records ): Job_Worker_Node {
		$w = new class() extends Job_Worker_Node {
			/** @var array<int,array<int,int|string>> */
			public array $canned = [];
			public function probe_stats(): array {
				return $this->canned;
			}
		};
		$w->canned = $records;
		$w->name( $name ); // registers into Core::$nodes_by_name (the sweep set)
		return $w;
	}

	public function test_fire_emits_one_positional_record_per_job_identity(): void {
		$this->stub_worker( 'combined', [
			$this->make_record( 'evtemplate', 'evtemplate', 4 ),
			$this->make_record( 'cron:films', 'cron', 2 ),
		] );

		$capture = new Capture_Sink_Node();
		$probe   = new Job_Probe_Node();
		$probe->name( '_jobstats' );
		$probe->target( '_jobstats:log' );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 2, $capture->captured, 'one record per identity' );
		foreach ( $capture->captured as $msg ) {
			$this->assertSame( Message::TM_STRUCT, $msg[ Message::TYPE ] );
			$this->assertSame( Core::$now, $msg[ Message::TIMESTAMP ] );
			$this->assertSame( '_jobstats:log', $msg[ Message::TO ] );
			$this->assertCount( 13, $msg[ Message::VALUE ] );
		}
		$keys = \array_map( static fn ( $m ) => $m[ Message::VALUE ][ Jobstats_Record::IDENTITY ], $capture->captured );
		\sort( $keys );
		$this->assertSame( [ 'cron:films', 'evtemplate' ], $keys );
	}

	public function test_shutdown_sweep_emits_the_final_partial_interval(): void {
		// Same opt-in as Topic_Probe: the window since the last tick is real work
		// a ~595s recycle would otherwise drop on the floor.
		$this->stub_worker( 'combined', [ $this->make_record( 'evtemplate', 'evtemplate', 4 ) ] );
		$capture = new Capture_Sink_Node();
		$probe   = new Job_Probe_Node();
		$probe->name( '_jobstats' );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertInstanceOf( \Newspack_Nodes\Shutdown_Sweeper::class, $probe );
		$probe->shutdown_sweep();
		$this->assertCount( 2, $capture->captured );
	}

	public function test_fire_emits_nothing_when_no_job_workers(): void {
		$capture = new Capture_Sink_Node();
		$probe   = new Job_Probe_Node();
		$probe->name( '_jobstats' );
		$probe->sink( $capture );
		$probe->fire_cb();
		$this->assertCount( 0, $capture->captured );
	}

	public function test_fire_emits_nothing_for_a_worker_with_no_recorded_jobs(): void {
		// A live worker that hasn't run a job yet has an empty accumulator → silent.
		$this->stub_worker( 'idle', [] );
		$capture = new Capture_Sink_Node();
		$probe   = new Job_Probe_Node();
		$probe->name( '_jobstats' );
		$probe->sink( $capture );
		$probe->fire_cb();
		$this->assertCount( 0, $capture->captured );
	}

	public function test_does_not_probe_non_worker_nodes(): void {
		$capture = new Capture_Sink_Node();
		$capture->name( '_sink_in_registry' );
		$this->stub_worker( 'combined', [ $this->make_record( 'a', 'a', 1 ) ] );

		$probe = new Job_Probe_Node();
		$probe->name( '_jobstats' );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 1, $capture->captured );
	}

	public function test_fire_skips_a_worker_whose_probe_stats_throws(): void {
		$bad = new class() extends Job_Worker_Node {
			public function probe_stats(): array {
				throw new \RuntimeException( 'boom' );
			}
		};
		$bad->name( 'broken' );
		$this->stub_worker( 'healthy', [ $this->make_record( 'ok', 'ok', 1 ) ] );

		$capture = new Capture_Sink_Node();
		$probe   = new Job_Probe_Node();
		$probe->name( '_jobstats' );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 1, $capture->captured );
		$this->assertSame( 'ok', $capture->captured[0][ Message::VALUE ][ Jobstats_Record::IDENTITY ] );
	}

	public function test_fire_truncates_an_oversize_last_message_to_fit_pipe_buf(): void {
		// 900 CJK chars pack to ~5.4 KB of \uXXXX escapes — chars are a proxy;
		// the physical boundary is the PACKED line, which must stay writable.
		$record                                  = $this->make_record( 'burst', 'burst', 1 );
		$record[ Jobstats_Record::LAST_MESSAGE ] = \str_repeat( '错', 900 );
		$this->stub_worker( 'combined', [ $record ] );

		$capture = new Capture_Sink_Node();
		$probe   = new Job_Probe_Node();
		$probe->name( '_jobstats' );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 1, $capture->captured, 'the record must land, truncated — never dropped' );
		$msg = $capture->captured[0];
		$this->assertLessThanOrEqual(
			\Newspack_Nodes\Partition_Node::MAX_LINE_SIZE,
			Message::packed_size( $msg ) + 1,
			'the packed line (with newline) fits the PIPE_BUF cap'
		);
		$last = $msg[ Message::VALUE ][ Jobstats_Record::LAST_MESSAGE ];
		$this->assertNotSame( '', $last, 'a truncated tail of the message survives' );
		$this->assertLessThan( 900, \mb_strlen( $last ) );
		$this->assertSame( 'burst', $msg[ Message::VALUE ][ Jobstats_Record::IDENTITY ] );
	}

	public function test_fire_drops_a_record_no_truncation_can_fit(): void {
		// A pathological identity key alone overflows the cap with nothing left
		// to truncate — drop that record, keep sweeping, never throw.
		$record = $this->make_record( \str_repeat( 'k', 5000 ), 'burst', 1 );
		$this->stub_worker( 'combined', [ $record, $this->make_record( 'ok', 'ok', 2 ) ] );

		$capture = new Capture_Sink_Node();
		$probe   = new Job_Probe_Node();
		$probe->name( '_jobstats' );
		$probe->sink( $capture );
		$probe->fire_cb();

		$this->assertCount( 1, $capture->captured, 'only the fittable record lands' );
		$this->assertSame( 'ok', $capture->captured[0][ Message::VALUE ][ Jobstats_Record::IDENTITY ] );
	}

	public function test_arguments_sets_interval_and_returns_raw_string(): void {
		( new \Newspack_Nodes\Router_Node() )->name( '_router' );
		$probe = new Job_Probe_Node();
		$probe->name( '_jobstats' );
		$this->assertSame( [ '30' ], $probe->arguments( [ '30' ] ) );
		$ref = new \ReflectionProperty( $probe, 'interval_ms' );
		$this->assertSame( 30000, $ref->getValue( $probe ) );
	}

	public function test_arguments_empty_keeps_default_interval(): void {
		( new \Newspack_Nodes\Router_Node() )->name( '_router' );
		$probe = new Job_Probe_Node();
		$probe->name( '_jobstats' );
		$probe->arguments( [] );
		$ref = new \ReflectionProperty( $probe, 'interval_ms' );
		$this->assertSame( 15000, $ref->getValue( $probe ) );
	}
}
