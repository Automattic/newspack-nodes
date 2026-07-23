<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Dead_Letter_Queue;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Worker_Should_Stop;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversTrait;

/** Minimal node that exercises the Dead_Letter_Queue trait in isolation. */
class Dead_Letter_Queue_Double extends Node {
	use Dead_Letter_Queue;

	public function fill( array $message ): void {}

	public function build_dlq( string $dir ): ?Partition_Node {
		$this->deadletter_dir = $dir;
		return $this->ensure_deadletter();
	}

	public function set_dlq( Partition_Node $p ): void {
		$this->deadletter = $p;
	}

	/** @param array<int, mixed> $m */
	public function quarantine( array $m, string $reason, ?\Throwable $e = null ): void {
		$this->dead_letter( $m, $reason, $e );
	}

	/** @return array<int, mixed> */
	public function poison( string $line, int $segment, int $offset ): array {
		return $this->poison_from_line( $line, $segment, $offset );
	}

	public function strike( string $reason ): bool {
		return $this->record_poison_strike( $reason );
	}

	/** @param array<array-key,mixed> $entry */
	public function resume( array $entry ): bool {
		return $this->resume_attempts_from_frame( $entry );
	}

	/** @param array<array-key,mixed> $entry */
	public function arm( array $entry ): bool {
		return $this->arm_skip_head_from_frame( $entry );
	}

	public function armed(): bool {
		return $this->crawl_skip_head;
	}

	public function disposition(): string {
		return $this->skip_head_disposition;
	}

	public function crawl_elapsed(): bool {
		return $this->crawl_interval_elapsed();
	}

	public function leave_crawl(): void {
		$this->exit_crawl();
	}

	/** Requeue seam: the log dl_requeue re-injects into. Null (default) exercises the "no local source" path. */
	public ?Partition_Node $requeue_target = null;

	protected function deadletter_requeue_target(): ?Partition_Node {
		return $this->requeue_target;
	}
}

#[CoversTrait( Dead_Letter_Queue::class )]
class DeadLetterQueueTest extends TestCase {

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	private function count_records( string $dir ): int {
		$count = 0;
		foreach ( (array) \glob( "{$dir}/*.log" ) as $path ) {
			foreach ( \explode( "\n", (string) \file_get_contents( (string) $path ) ) as $line ) {
				if ( '' !== $line ) {
					++$count;
				}
			}
		}
		return $count;
	}

	public function test_ensure_deadletter_returns_null_for_empty_dir(): void {
		$d = new Dead_Letter_Queue_Double();
		$this->assertNull( $d->build_dlq( '' ) );
	}

	public function test_ensure_deadletter_builds_void_warranty_partition(): void {
		$d   = new Dead_Letter_Queue_Double();
		$dlq = $d->build_dlq( "{$this->tmp}/dlq.p0" );
		$this->assertInstanceOf( Partition_Node::class, $dlq );
		// Sole writer: the cap is lifted so poison larger than PIPE_BUF still quarantines.
		$this->assertTrue( $this->read_private( $dlq, 'warranty_voided' ) );
		// Idempotent — a second call returns the same partition.
		$this->assertSame( $dlq, $d->build_dlq( "{$this->tmp}/dlq.p0" ) );
	}

	public function test_deadletter_retention_is_count_based_with_no_time_aging(): void {
		// The DLQ declares ALL FOUR retention axes. Passing a bare count would land
		// it on min_segments and leave the lifetimes to inherit <config:*> — where a
		// min_lifetime of an hour means the quarantine never prunes at all.
		$d   = new Dead_Letter_Queue_Double();
		$dlq = $d->build_dlq( "{$this->tmp}/dlq.p0" );

		$this->assertSame( 2, $this->read_private( $dlq, 'min_segments' ), 'floor, not the retained count' );
		$this->assertSame(
			Dead_Letter_Queue_Double::DEADLETTER_MAX_SEGMENTS,
			$this->read_private( $dlq, 'max_segments' ),
			'the retained count is the COUNT rule'
		);
		$this->assertSame( 0, $this->read_private( $dlq, 'min_lifetime' ), 'no age floor: prune by count alone' );
		$this->assertSame( 0, $this->read_private( $dlq, 'max_lifetime' ), 'poison never ages out on a timer' );
	}

	public function test_dead_letter_writes_the_message_to_the_partition(): void {
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$message[ Message::VALUE ] = 'poison';
		$d->quarantine( $message, 'throw' );

		$this->assertSame( 1, $this->count_records( "{$this->tmp}/dlq.p0" ) );
	}

	public function test_dead_letter_without_partition_drops_without_throwing(): void {
		$d                         = new Dead_Letter_Queue_Double();
		$message                   = Message::new_message();
		$message[ Message::VALUE ] = 'poison';
		$d->quarantine( $message, 'throw' );
		$this->addToAssertionCount( 1 );
	}

	public function test_dead_letter_rethrows_worker_should_stop(): void {
		$d = new Dead_Letter_Queue_Double();
		$d->set_dlq( new class() extends Partition_Node {
			public function fill( array $message ): void {
				throw new Worker_Should_Stop();
			}
		} );
		$message                   = Message::new_message();
		$message[ Message::VALUE ] = 'poison';
		$this->expectException( Worker_Should_Stop::class );
		$d->quarantine( $message, 'throw' );
	}

	public function test_dead_letter_swallows_write_failure(): void {
		$d = new Dead_Letter_Queue_Double();
		$d->set_dlq( new class() extends Partition_Node {
			public function fill( array $message ): void {
				throw new \RuntimeException( 'disk full' );
			}
		} );
		$message                   = Message::new_message();
		$message[ Message::VALUE ] = 'poison';
		// A failed quarantine must not escape — the caller advances the cursor regardless.
		$d->quarantine( $message, 'throw' );
		$this->addToAssertionCount( 1 );
	}

	public function test_poison_from_line_unpacks_a_parseable_line(): void {
		$d                         = new Dead_Letter_Queue_Double();
		$original                  = Message::new_message();
		$original[ Message::TYPE ] = Message::TM_STRUCT;
		$original[ Message::VALUE ] = [ 'a' => 1 ];
		$line   = Message::packed( $original );
		$poison = $d->poison( $line, 2, 128 );
		$this->assertSame( [ 'a' => 1 ], $poison[ Message::VALUE ] );
		// ID = segment:offset:length, length = the on-disk span (line + newline).
		$this->assertSame( '2:128:' . ( \strlen( $line ) + 1 ), $poison[ Message::ID ] );
	}

	public function test_poison_from_line_wraps_unparseable_bytes(): void {
		$d      = new Dead_Letter_Queue_Double();
		$poison = $d->poison( 'not a packed message', 3, 64 );
		$this->assertSame( Message::TM_BYTESTREAM, $poison[ Message::TYPE ] );
		$this->assertSame( 'not a packed message', $poison[ Message::VALUE ] );
		$this->assertSame( '3:64:' . ( \strlen( 'not a packed message' ) + 1 ), $poison[ Message::ID ] );
	}

	public function test_record_poison_strike_stamps_reason_and_streak(): void {
		$d = new Dead_Letter_Queue_Double();
		// attempts defaults to the healthy baseline (1); COOP budget is 2, so not yet exhausted.
		$this->assertFalse( $d->strike( 'timeout' ) );
		$this->assertSame( 'timeout', $this->read_private( $d, 'poison_reason' ) );
		$first = $this->read_private( $d, 'first_crash_ts' );
		$this->assertNotNull( $first );

		// A second strike keeps the original streak start, not the latest clock.
		$d->strike( 'timeout' );
		$this->assertSame( $first, $this->read_private( $d, 'first_crash_ts' ) );
	}

	public function test_record_poison_strike_true_when_budget_exhausted(): void {
		$d = new Dead_Letter_Queue_Double();
		( new \ReflectionProperty( Dead_Letter_Queue_Double::class, 'attempts' ) )->setValue( $d, Dead_Letter_Queue_Double::COOP_MAX_ATTEMPTS );
		$this->assertTrue( $d->strike( 'memory' ) );
	}

	// ── resume_attempts_from_frame: shared attempt-climb + crash detection ──

	public function test_resume_attempts_from_frame_climbs_and_carries_streak(): void {
		\Newspack_Nodes\Core::$now = 5000.0;
		$d = new Dead_Letter_Queue_Double();
		// A caught-throw lineage (reason stamped) below the crash budget: climb, no crawl.
		$entered_crawl = $d->resume( [ 'attempts' => 1, 'reason' => 'throw', 'first_crash_ts' => 4000.0 ] );
		$this->assertFalse( $entered_crawl );
		$this->assertSame( 2, $this->read_private( $d, 'attempts' ) );
		$this->assertFalse( $this->read_private( $d, 'crawl' ) );
		// The streak start is carried forward from the frame, not reset to now.
		$this->assertSame( 4000.0, $this->read_private( $d, 'first_crash_ts' ) );
	}

	public function test_resume_attempts_from_frame_graceful_frame_is_virgin(): void {
		$d = new Dead_Letter_Queue_Double();
		// A graceful handoff stamped attempts=0 → resume at the virgin baseline (1), no streak.
		$this->assertFalse( $d->resume( [ 'attempts' => 0, 'reason' => '' ] ) );
		$this->assertSame( 1, $this->read_private( $d, 'attempts' ) );
		$this->assertNull( $this->read_private( $d, 'first_crash_ts' ) );
		$this->assertFalse( $this->read_private( $d, 'crawl' ) );
	}

	public function test_resume_attempts_from_frame_detects_hard_crash_enters_crawl(): void {
		\Newspack_Nodes\Core::$now = 7000.0;
		$d = new Dead_Letter_Queue_Double();
		// An uncatchable-death lineage (NO reason) that exhausted the crash budget → crawl.
		$entered_crawl = $d->resume( [ 'attempts' => Dead_Letter_Queue_Double::CRASH_MAX_ATTEMPTS, 'reason' => '' ] );
		$this->assertTrue( $entered_crawl );
		$this->assertTrue( $this->read_private( $d, 'crawl' ) );
		// attempts pins at the threshold; crawl_started stamps now.
		$this->assertSame( Dead_Letter_Queue_Double::CRASH_MAX_ATTEMPTS, $this->read_private( $d, 'attempts' ) );
		$this->assertSame( 7000.0, $this->read_private( $d, 'crawl_started' ) );
	}

	// ── arm_skip_head_from_frame: boot head-skip disposition (quarantine marker) ──

	public function test_arm_skip_head_from_frame_arms_crash_on_hard_crash_lineage(): void {
		\Newspack_Nodes\Core::$now = 7000.0;
		$d = new Dead_Letter_Queue_Double();
		// A hard-crash lineage with no marker → arm the DLQ 'crash' sacrifice (existing behavior).
		$this->assertTrue( $d->arm( [ 'attempts' => Dead_Letter_Queue_Double::CRASH_MAX_ATTEMPTS, 'reason' => '' ] ) );
		$this->assertTrue( $d->armed() );
		$this->assertSame( 'crash', $d->disposition() );
	}

	public function test_arm_skip_head_from_frame_arms_drop_on_quarantine_marker(): void {
		$d = new Dead_Letter_Queue_Double();
		// A strike-out marker frame: graceful (attempts=0) + quarantined → arm the silent DROP
		// (the head is already in the DLQ), no crawl.
		$this->assertTrue( $d->arm( [ 'attempts' => 0, 'reason' => '', 'quarantined' => true ] ) );
		$this->assertTrue( $d->armed() );
		$this->assertSame( 'drop', $d->disposition() );
		$this->assertFalse( $this->read_private( $d, 'crawl' ), 'a strike-out marker hands off at the virgin baseline, not crawl' );
	}

	public function test_arm_skip_head_from_frame_marker_drop_wins_over_crash_lineage(): void {
		\Newspack_Nodes\Core::$now = 7000.0;
		$d = new Dead_Letter_Queue_Double();
		// A post-crash-sacrifice marker keeps the crawl lineage (attempts pinned, no reason) AND
		// carries the marker. The marker's DROP must win so the already-quarantined head isn't
		// re-dead-lettered, while crawl still continues.
		$this->assertTrue( $d->arm( [ 'attempts' => Dead_Letter_Queue_Double::CRASH_MAX_ATTEMPTS, 'reason' => '', 'quarantined' => true ] ) );
		$this->assertTrue( $d->armed() );
		$this->assertSame( 'drop', $d->disposition(), 'the marker DROP wins over the crash-lineage sacrifice' );
		$this->assertTrue( $this->read_private( $d, 'crawl' ), 'the crawl lineage still continues' );
	}

	public function test_arm_skip_head_from_frame_unarmed_on_a_clean_frame(): void {
		$d = new Dead_Letter_Queue_Double();
		// A plain graceful frame with no marker and no crash lineage arms nothing.
		$this->assertFalse( $d->arm( [ 'attempts' => 0, 'reason' => '' ] ) );
		$this->assertFalse( $d->armed() );
		$this->assertSame( 'crash', $d->disposition(), 'the disposition stays at its default when unarmed' );
	}

	// ── crawl_interval_elapsed / exit_crawl ──

	public function test_crawl_interval_elapsed_only_after_the_interval_while_crawling(): void {
		$d = new Dead_Letter_Queue_Double();
		( new \ReflectionProperty( Dead_Letter_Queue_Double::class, 'crawl' ) )->setValue( $d, true );
		( new \ReflectionProperty( Dead_Letter_Queue_Double::class, 'crawl_started' ) )->setValue( $d, 1000.0 );

		\Newspack_Nodes\Core::$now = 1000.0 + Dead_Letter_Queue_Double::CHECKPOINT_INTERVAL_S - 1.0;
		$this->assertFalse( $d->crawl_elapsed(), 'within the interval' );

		\Newspack_Nodes\Core::$now = 1000.0 + Dead_Letter_Queue_Double::CHECKPOINT_INTERVAL_S + 1.0;
		$this->assertTrue( $d->crawl_elapsed(), 'past the interval' );
	}

	public function test_crawl_interval_elapsed_false_when_not_crawling(): void {
		$d = new Dead_Letter_Queue_Double();
		\Newspack_Nodes\Core::$now = 999999.0;
		$this->assertFalse( $d->crawl_elapsed() );
	}

	public function test_exit_crawl_resets_to_healthy_baseline(): void {
		$d = new Dead_Letter_Queue_Double();
		( new \ReflectionProperty( Dead_Letter_Queue_Double::class, 'crawl' ) )->setValue( $d, true );
		( new \ReflectionProperty( Dead_Letter_Queue_Double::class, 'attempts' ) )->setValue( $d, 5 );
		( new \ReflectionProperty( Dead_Letter_Queue_Double::class, 'first_crash_ts' ) )->setValue( $d, 1.0 );
		( new \ReflectionProperty( Dead_Letter_Queue_Double::class, 'poison_reason' ) )->setValue( $d, 'throw' );

		$d->leave_crawl();

		$this->assertFalse( $this->read_private( $d, 'crawl' ) );
		$this->assertSame( 1, $this->read_private( $d, 'attempts' ) );
		$this->assertNull( $this->read_private( $d, 'first_crash_ts' ) );
		$this->assertSame( '', $this->read_private( $d, 'poison_reason' ) );
	}

	// ── Triage backend: reason/attempts .idx sidecar + list / requeue / purge ──

	/** @return array<int, mixed> */
	private function dl_message( string $value, string $id = '' ): array {
		$m                     = Message::new_message();
		$m[ Message::TYPE ]    = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ]   = $value;
		$m[ Message::ID ]      = $id;
		return $m;
	}

	public function test_dead_letter_writes_triage_metadata_beside_the_record(): void {
		\Newspack_Nodes\Core::$now = 9999.0;
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );
		// Distinct-from-default fair-shot state so a hard-coded default can't pass.
		( new \ReflectionProperty( Dead_Letter_Queue_Double::class, 'attempts' ) )->setValue( $d, 3 );
		( new \ReflectionProperty( Dead_Letter_Queue_Double::class, 'first_crash_ts' ) )->setValue( $d, 4242.5 );

		$d->quarantine( $this->dl_message( 'poison', '5:128:64' ), 'timeout' );

		$page = $d->list_deadletter( 50 );
		$this->assertSame( 1, $page['total'] );
		$row = $page['rows'][0];
		$this->assertSame( 'timeout', $row['reason'], 'the quarantine reason is durable, not just logged' );
		$this->assertSame( 3, $row['attempts'] );
		$this->assertSame( 4242.5, $row['first_crash_ts'] );
		$this->assertSame( 9999, $row['ts'] );
		$this->assertSame( '5:128:64', $row['source'], 'the record\'s source breadcrumb (Message::ID)' );
		// ONE pasteable sidecar locator (first record: segment 0, offset 0, length > 0).
		$this->assertMatchesRegularExpression( '/^0:0:[1-9][0-9]*$/', $row['locator'] );
	}

	public function test_a_stray_sidecar_fill_does_not_reuse_a_stale_reason(): void {
		// The reason is staged per dead_letter() call; a fill that bypasses
		// dead_letter() (nothing does this today) must index '' — never the
		// previous quarantine's reason.
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );
		$d->quarantine( $this->dl_message( 'poison', '5:128:64' ), 'timeout' );

		$sidecar = $this->read_private( $d, 'deadletter' );
		\assert( $sidecar instanceof Partition_Node );
		$sidecar->fill( $this->dl_message( 'stray', '6:0:10' ) );
		$sidecar->flush();

		$rows = $d->list_deadletter( 50 )['rows'];
		$this->assertSame( '', $rows[0]['reason'], 'the stray (newest) row must not inherit "timeout"' );
		$this->assertSame( 'timeout', $rows[1]['reason'] );
	}

	public function test_the_dlq_record_stays_byte_verbatim_replayable(): void {
		// The .idx rides BESIDE the record; the .log record itself is the original,
		// unwrapped message so `wp nodes ingest` replays it verbatim.
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );
		$original                    = Message::new_message();
		$original[ Message::TYPE ]   = Message::TM_STRUCT;
		$original[ Message::VALUE ]  = [ 'k' => 'verbatim' ];
		$d->quarantine( $original, 'throw' );

		$log   = (string) \file_get_contents( "{$this->tmp}/dlq.p0/0.log" );
		$first = \explode( "\n", $log )[0];
		$this->assertSame( [ 'k' => 'verbatim' ], Message::unpacked( $first )[ Message::VALUE ] );
	}

	public function test_list_is_newest_first_and_capped_by_limit(): void {
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );
		$d->quarantine( $this->dl_message( 'a', '1:0:10' ), 'throw' );
		$d->quarantine( $this->dl_message( 'b', '2:0:10' ), 'throw' );
		$d->quarantine( $this->dl_message( 'c', '3:0:10' ), 'unparseable' );

		$page = $d->list_deadletter( 2 );
		$this->assertCount( 2, $page['rows'], 'the limit caps the returned rows' );
		$this->assertSame( 3, $page['total'], 'total counts ALL indexed records, not the page' );
		$this->assertSame( '3:0:10', $page['rows'][0]['source'], 'newest first' );
		$this->assertSame( '2:0:10', $page['rows'][1]['source'] );
	}

	public function test_requeue_reads_the_sidecar_and_writes_to_the_target(): void {
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );
		$d->quarantine( $this->dl_message( 'reinject-me', '2:64:40' ), 'throw' );

		$row = $d->list_deadletter( 50 )['rows'][0];
		$loc = $row['locator'];

		$target = new Partition_Node();
		$target->arguments( [ "{$this->tmp}/source.p0" ] );
		$d->requeue_target = $target;

		$result = $d->requeue_deadletter( $loc );
		$this->assertStringStartsWith( 'ok', $result );

		$target->flush();
		$log    = (string) \file_get_contents( "{$this->tmp}/source.p0/0.log" );
		$values = \array_map(
			static fn ( string $l ) => Message::unpacked( $l )[ Message::VALUE ],
			\array_filter( \explode( "\n", $log ), static fn ( string $l ) => '' !== $l )
		);
		$this->assertSame( [ 'reinject-me' ], \array_values( $values ) );
	}

	public function test_requeue_without_a_target_reports_unavailable(): void {
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );
		// No requeue_target → the "no local source" branch, before any read.
		$result = $d->requeue_deadletter( '0:0:10' );
		$this->assertStringContainsString( 'unavailable', $result );
	}

	public function test_requeue_rejects_a_malformed_locator(): void {
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );
		$d->requeue_target = ( new Partition_Node() );
		$d->requeue_target->arguments( [ "{$this->tmp}/source.p0" ] );
		$this->assertStringContainsString( 'malformed', $d->requeue_deadletter( 'not-a-locator' ) );
	}

	public function test_purge_removes_all_dead_letter_segments_and_indexes(): void {
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );
		$d->quarantine( $this->dl_message( 'poison', '1:0:10' ), 'throw' );
		$this->assertSame( 1, $this->count_records( "{$this->tmp}/dlq.p0" ) );

		$result = $d->purge_deadletter();
		$this->assertSame( 'ok: purged 1 of 1 dead-letter segment(s)', $result );
		$this->assertSame( 0, $this->count_records( "{$this->tmp}/dlq.p0" ) );
		$this->assertSame( [], \glob( "{$this->tmp}/dlq.p0/*.idx" ) ?: [], 'the .idx companions are purged too' );
	}

	public function test_list_reports_unindexed_segments_for_pre_feature_records(): void {
		// Two PRE-feature .log segments already on disk (no .idx companions) — the
		// state after an upgrade. The newest (segment 1) gets adopted + partially
		// indexed by the feature-era quarantine; segment 0 stays fully unindexed.
		$dir = "{$this->tmp}/dlq.p0";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/0.log", Message::packed( $this->dl_message( 'old-a' ) ) . "\n" );
		\file_put_contents( "{$dir}/1.log", Message::packed( $this->dl_message( 'old-b' ) ) . "\n" );

		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( $dir );
		$d->quarantine( $this->dl_message( 'new-c', '9:0:10' ), 'throw' );

		$page = $d->list_deadletter( 50 );
		$this->assertSame( 1, $page['total'], 'only the feature-era record carries an .idx row' );
		$this->assertSame( 1, $page['unindexed_segments'], 'segment 0 predates the feature and has no .idx' );
	}

	public function test_list_is_empty_without_a_configured_queue(): void {
		$d    = new Dead_Letter_Queue_Double();
		$page = $d->list_deadletter( 50 );
		$this->assertSame( 0, $page['total'] );
		$this->assertSame( [], $page['rows'] );
	}

	public function test_show_returns_the_decoded_record_at_a_locator(): void {
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );
		$m                        = Message::new_message();
		$m[ Message::TYPE ]       = Message::TM_STRUCT;
		$m[ Message::TIMESTAMP ]  = 7777.25;
		$m[ Message::FROM ]       = 'origin-node';
		$m[ Message::TO ]         = 'dest-node';
		$m[ Message::ID ]         = '4:96:33';
		$m[ Message::KEY ]        = 'poison-key-909';
		$m[ Message::VALUE ]      = [ 'k' => 'job', 'payload' => 'unparseable-blob-909' ];
		$d->quarantine( $m, 'unparseable' );

		$locator = $d->list_deadletter( 1 )['rows'][0]['locator'];
		$shown   = \json_decode( $d->show_deadletter( $locator ), true );

		$this->assertSame( Message::TM_STRUCT, $shown['type'] );
		$this->assertSame( 'TM_STRUCT', $shown['type_flags'] );
		$this->assertSame( 7777.25, $shown['timestamp'] );
		$this->assertSame( 'origin-node', $shown['from'] );
		$this->assertSame( 'dest-node', $shown['to'] );
		$this->assertSame( '4:96:33', $shown['id'] );
		$this->assertSame( 'poison-key-909', $shown['key'] );
		$this->assertSame( [ 'k' => 'job', 'payload' => 'unparseable-blob-909' ], $shown['value'] );
		$this->assertGreaterThan( 0, $shown['size'], 'packed byte size rides along' );
	}

	public function test_show_rejects_a_malformed_locator(): void {
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );
		$this->assertStringContainsString( 'malformed', $d->show_deadletter( 'not-a-locator' ) );
	}

	public function test_show_reports_a_missing_record(): void {
		$d = new Dead_Letter_Queue_Double();
		$d->build_dlq( "{$this->tmp}/dlq.p0" );
		$this->assertStringContainsString( 'no dead-letter record', $d->show_deadletter( '9:0:10' ) );
	}

	public function test_show_errors_without_a_configured_queue(): void {
		$d = new Dead_Letter_Queue_Double();
		$this->assertStringContainsString( 'no dead-letter queue', $d->show_deadletter( '0:0:10' ) );
	}

	public function test_dl_show_is_in_the_shared_verb_table(): void {
		$names = \array_column( Dead_Letter_Queue_Double::deadletter_verbs(), 'name' );
		$this->assertContains( 'dl_show', $names );
	}
}
