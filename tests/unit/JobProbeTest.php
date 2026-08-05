<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Core;
use Newspack_Nodes\Jobstats_Record;
use Newspack_Nodes\Job_Probe_Node;
use Newspack_Nodes\Job_Worker_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Job_Probe sweeps this process's Job_Workers (the jobs analog of TopicProbe's
 * Consumer sweep) and emits ONE lean positional Jobstats_Record snapshot per job
 * identity per tick into its sink (the shared jobstats log). The Message TIMESTAMP
 * is the sweep instant; the cumulative counters are folded downstream into rates.
 */
#[CoversClass( Job_Probe_Node::class )]
class JobProbeTest extends TestCase {

	protected function setUp(): void {
		parent::setUp();
		// A real clock instant so the first fire clears the interval gate.
		Core::$now = 1000;
	}

	/** @return array<int,int|string> A filled 12-slot Jobstats_Record. */
	private function make_record( string $key, string $handler, int $runs ): array {
		$r                                    = [];
		$r[ Jobstats_Record::KEY ]            = $key;
		$r[ Jobstats_Record::HANDLER ]        = $handler;
		$r[ Jobstats_Record::RUNS ]           = $runs;
		$r[ Jobstats_Record::ERRORS ]         = 0;
		$r[ Jobstats_Record::DURATION_MS ]    = 12;
		$r[ Jobstats_Record::QUEUE_MS ]       = 3;
		$r[ Jobstats_Record::ITEMS_OK ]       = 5;
		$r[ Jobstats_Record::ITEMS_ERR ]      = 0;
		$r[ Jobstats_Record::LAST_TS ]        = 999;
		$r[ Jobstats_Record::LAST_DURATION_MS ] = 8;
		$r[ Jobstats_Record::LAST_STATUS ]    = 'success';
		$r[ Jobstats_Record::LAST_MESSAGE ]   = 'Job completed successfully';
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
			$this->assertCount( 12, $msg[ Message::VALUE ] );
		}
		$keys = \array_map( static fn ( $m ) => $m[ Message::VALUE ][ Jobstats_Record::KEY ], $capture->captured );
		\sort( $keys );
		$this->assertSame( [ 'cron:films', 'evtemplate' ], $keys );
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
		$this->assertSame( 'ok', $capture->captured[0][ Message::VALUE ][ Jobstats_Record::KEY ] );
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
		$this->assertSame( 'burst', $msg[ Message::VALUE ][ Jobstats_Record::KEY ] );
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
		$this->assertSame( 'ok', $capture->captured[0][ Message::VALUE ][ Jobstats_Record::KEY ] );
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
