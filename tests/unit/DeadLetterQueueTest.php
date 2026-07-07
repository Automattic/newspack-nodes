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
		return $this->ensure_deadletter( $dir, 'double:deadletter' );
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

	public function crawl_elapsed(): bool {
		return $this->crawl_interval_elapsed();
	}

	public function leave_crawl(): void {
		$this->exit_crawl();
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
}
