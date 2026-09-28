<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Job_Delay;
use Newspack_Nodes\Job_Intake;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * The jobdelay.p0 sweep: due entries deliver into jobintake with their delay
 * fields stripped and identity preserved; not-due entries circulate back to
 * the tail; the durable cursor makes a second sweep deliver exactly once.
 */
#[CoversClass( Job_Delay::class )]
class JobDelayTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir( 'newspack-jobdelay-test-' );
		mkdir( "{$this->tmp}/locks", 0755, true );
		mkdir( "{$this->tmp}/logs", 0755, true );
		$this->use_base_dir( $this->tmp, [ 'num_partitions' => 2 ] );
	}

	private function seed_delayed( string $handler, float $not_before, ?string $key = null, ?string $id = null, array $extra = [] ): void {
		$intake = new Job_Intake( $this->tmp, 2 );
		$this->assertTrue( $intake->write_job( $handler, $id, [ 'seeded' => 1 ], $key, [ 'not_before' => $not_before ] + $extra ) );
		$intake->close();
	}

	private function read_partition_dir_lines( string $dir_name ): array {
		$lines = [];
		$pdir  = "{$this->tmp}/logs/{$dir_name}";
		if ( ! is_dir( $pdir ) ) {
			return $lines;
		}
		foreach ( scandir( $pdir ) as $f ) {
			if ( ! preg_match( '/^\d+\.log$/', $f ) ) {
				continue;
			}
			foreach ( preg_split( '/\n/', rtrim( (string) file_get_contents( "{$pdir}/{$f}" ), "\n" ) ) as $line ) {
				if ( '' === $line ) {
					continue;
				}
				$decoded = Message::unpacked( $line )[ Message::VALUE ];
				if ( \is_array( $decoded ) ) {
					$lines[] = $decoded;
				}
			}
		}
		return $lines;
	}

	private function read_all_jobintake_lines(): array {
		$lines = [];
		foreach ( scandir( "{$this->tmp}/logs" ) as $entry ) {
			if ( preg_match( '/^jobintake\.p\d+$/', $entry ) ) {
				$lines = array_merge( $lines, $this->read_partition_dir_lines( $entry ) );
			}
		}
		return $lines;
	}

	public function test_sweep_without_delay_dir_is_a_noop(): void {
		$this->assertSame( 0, Job_Delay::sweep() );
		$this->assertDirectoryDoesNotExist( "{$this->tmp}/logs/jobdelay.p0" );
	}

	public function test_sweep_delivers_due_entry_stripped_and_keyed(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'due_h', $now + 30.0, 'affkey', 'id9', [ 'retries' => 4, 'batch' => 'bD' ] );

		$this->assertSame( 1, Job_Delay::sweep( $now + 60.0 ) );

		$expected_p = Partition_Node::hash_to_partition( 'affkey', 2 );
		$lines      = $this->read_partition_dir_lines( "jobintake.p{$expected_p}" );
		$this->assertCount( 1, $lines, 'delivery must honor the original partition key' );
		$this->assertSame( 'due_h', $lines[0]['handler'] );
		$this->assertSame( 'id9', $lines[0]['id'] );
		$this->assertSame( 4, $lines[0]['retries'] );
		$this->assertSame( 'bD', $lines[0]['batch'], 'batch identity survives the delay hop' );
		$this->assertSame( 'affkey', $lines[0]['key'], 'delivered entries keep their key so a later retry re-parks correctly' );
		$this->assertArrayNotHasKey( 'not_before', $lines[0] );
	}

	public function test_sweep_circulates_not_due_and_delivers_exactly_once_later(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'later_h', $now + 3600.0 );

		$this->assertSame( 0, Job_Delay::sweep( $now ) );
		$this->assertSame( [], $this->read_all_jobintake_lines() );

		// The durable cursor + the circulated copy: a later sweep delivers ONE.
		$this->assertSame( 1, Job_Delay::sweep( $now + 7200.0 ) );
		$this->assertCount( 1, $this->read_all_jobintake_lines(), 'circulation must never duplicate a pending job' );

		// And a third sweep finds nothing left.
		$this->assertSame( 0, Job_Delay::sweep( $now + 9000.0 ) );
		$this->assertCount( 1, $this->read_all_jobintake_lines() );
	}

	public function test_failed_circulation_never_loses_a_pending_entry(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'survivor_h', $now + 3600.0 );

		// Wedge the re-append: the delay dir refuses writes mid-sweep.
		chmod( "{$this->tmp}/logs/jobdelay.p0", 0555 );
		try {
			Job_Delay::sweep( $now );
		} catch ( \RuntimeException $e ) {
			// The aborted sweep may throw; what matters is what survives.
		} finally {
			chmod( "{$this->tmp}/logs/jobdelay.p0", 0755 );
		}

		$this->assertSame(
			1,
			Job_Delay::sweep( $now + 7200.0 ),
			'an aborted circulation must leave the cursor behind the entry, never checkpoint past it'
		);
	}

	public function test_a_delivery_failing_for_a_reason_other_than_contention_propagates(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'refused_h', $now + 30.0, 'refkey-4471' );
		$p = Partition_Node::hash_to_partition( 'refkey-4471', 2 );
		// A file where the intake partition directory belongs refuses the write.
		\file_put_contents( "{$this->tmp}/logs/jobintake.p{$p}", 'not a directory' );

		$caught = null;
		try {
			Job_Delay::sweep( $now + 60.0 );
		} catch ( \RuntimeException $e ) {
			$caught = $e;
		}

		$this->assertNotNull( $caught, 'only lock contention circulates; this failure escapes' );
		$this->assertNotInstanceOf( \Newspack_Nodes\Write_Lock_Held::class, $caught );
		\unlink( "{$this->tmp}/logs/jobintake.p{$p}" );
		$this->assertSame( 1, Job_Delay::sweep( $now + 60.0 ), 'the cursor stayed behind the entry' );
	}

	public function test_a_close_failure_escapes_beside_the_drain_failure(): void {
		$now = \microtime( true );
		[ $kept, $refused ] = $this->keys_on_distinct_partitions();
		$this->seed_delayed( 'kept_h', $now + 30.0, $kept );
		$this->seed_delayed( 'refused_h', $now + 30.0, $refused );
		$refused_p = Partition_Node::hash_to_partition( $refused, 2 );
		// A file where one intake partition belongs refuses that delivery.
		\file_put_contents( "{$this->tmp}/logs/jobintake.p{$refused_p}", 'not a directory' );
		// The other delivery buffers, and its flush at close lands nothing.
		$saved                  = Partition_Node::$fwrite;
		Partition_Node::$fwrite = static fn ( $fh, string $bytes ): int|false => \str_contains( \stream_get_meta_data( $fh )['uri'], '/logs/jobintake.p' ) ? false : \fwrite( $fh, $bytes );

		$caught = null;
		try {
			Job_Delay::sweep( $now + 60.0 );
		} catch ( \Throwable $e ) {
			$caught = $e;
		} finally {
			Partition_Node::$fwrite = $saved;
		}

		$this->assertInstanceOf( \Newspack_Nodes\Failures::class, $caught, 'the close failure joins the drain failure' );
		$this->assertCount( 2, $caught->all() );
		$this->assertStringContainsString( 'short write to segment', $caught->all()[1]->getMessage() );
	}

	/** @return array{0:string,1:string} Two keys hashing to different intake partitions. */
	private function keys_on_distinct_partitions(): array {
		$first = 'keep-5510';
		for ( $i = 5511; ; $i++ ) {
			if ( Partition_Node::hash_to_partition( "refuse-{$i}", 2 ) !== Partition_Node::hash_to_partition( $first, 2 ) ) {
				return [ $first, "refuse-{$i}" ];
			}
		}
	}

	public function test_undeliverable_due_entry_drops_loud_not_forever(): void {
		// Hand-pack an entry whose handler fails validation at delivery time.
		$p = new \Newspack_Nodes\Partition_Node();
		$p->name( 'seed:jobdelay' );
		$p->arguments( [ "{$this->tmp}/logs/jobdelay.p0" ] );
		$p->allow_large_writes();
		$m                                        = \Newspack_Nodes\Message::new_message();
		$m[ \Newspack_Nodes\Message::TYPE ]      = \Newspack_Nodes\Message::TM_STRUCT;
		$m[ \Newspack_Nodes\Message::TIMESTAMP ] = \microtime( true );
		$m[ \Newspack_Nodes\Message::VALUE ]     = [ 'k' => 'job', 'handler' => 'Bad Name!', 'parameters' => [], 'ts' => \microtime( true ), 'not_before' => \microtime( true ) - 5.0 ];
		$p->fill( $m );
		$p->remove_node();

		// A second invalid entry that is NOT yet due: its circulation also
		// fails validation and drops loud instead of wedging the sweep.
		$p2 = new \Newspack_Nodes\Partition_Node();
		$p2->name( 'seed:jobdelay2' );
		$p2->arguments( [ "{$this->tmp}/logs/jobdelay.p0" ] );
		$p2->allow_large_writes();
		$m2                                        = \Newspack_Nodes\Message::new_message();
		$m2[ \Newspack_Nodes\Message::TYPE ]      = \Newspack_Nodes\Message::TM_STRUCT;
		$m2[ \Newspack_Nodes\Message::TIMESTAMP ] = \microtime( true );
		$m2[ \Newspack_Nodes\Message::VALUE ]     = [ 'k' => 'alert', 'm' => 'not a job at all' ];
		$p2->fill( $m2 );
		$m3                                    = \Newspack_Nodes\Message::new_message();
		$m3[ \Newspack_Nodes\Message::TYPE ]  = \Newspack_Nodes\Message::TM_STRUCT;
		$m3[ \Newspack_Nodes\Message::TIMESTAMP ] = \microtime( true );
		$m3[ \Newspack_Nodes\Message::VALUE ] = [ 'k' => 'job', 'handler' => 'Also Bad!', 'parameters' => [], 'ts' => \microtime( true ), 'not_before' => \microtime( true ) + 3600.0 ];
		$p2->fill( $m3 );
		$p2->remove_node();

		$this->assertSame( 0, Job_Delay::sweep( \microtime( true ) ) );
		$this->assertSame( [], $this->read_all_jobintake_lines() );
		// Dropped for good: a later sweep does not resurrect it.
		$this->assertSame( 0, Job_Delay::sweep( \microtime( true ) + 60.0 ) );
	}

	public function test_entry_coming_due_mid_sweep_delivers_on_reappend(): void {
		$real = \microtime( true );
		// Hand-pack an already-due entry (write_job would route it live): due
		// by the wall clock, not yet due by the sweep's (older) clock.
		$p = new \Newspack_Nodes\Partition_Node();
		$p->name( 'seed:midsweep' );
		$p->arguments( [ "{$this->tmp}/logs/jobdelay.p0" ] );
		$p->allow_large_writes();
		$m                                       = \Newspack_Nodes\Message::new_message();
		$m[ \Newspack_Nodes\Message::TYPE ]      = \Newspack_Nodes\Message::TM_STRUCT;
		$m[ \Newspack_Nodes\Message::TIMESTAMP ] = $real;
		$m[ \Newspack_Nodes\Message::VALUE ]     = [ 'k' => 'job', 'handler' => 'midsweep_h', 'parameters' => [], 'ts' => $real, 'not_before' => $real - 50.0 ];
		$p->fill( $m );
		$p->remove_node();

		$this->assertSame( 1, Job_Delay::sweep( $real - 100.0 ) );
		$this->assertSame( [ 'midsweep_h' ], array_column( $this->read_all_jobintake_lines(), 'handler' ) );
	}

	/**
	 * ADR-14: Worker_Should_Stop extends RuntimeException, so the delivery
	 * catch that circulates on lock contention must let a cooperative stop
	 * through — Job_Intake::queue()'s identical construct carves it out.
	 */
	public function test_a_cooperative_stop_is_not_treated_as_lock_contention(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'stop_probe_h', $now + 30.0 );

		\Newspack_Nodes\Event_Framework::reset();
		// The intake's write lock arms a heartbeat Timer, which hitchhikes _router.
		( new \Newspack_Nodes\Router_Node() )->name( \Newspack_Nodes\Node_Names::ROUTER );

		$this->assertNotNull( $this->with_stop_due( static fn () => Job_Delay::sweep( $now + 60.0 ) ) );
	}

	/**
	 * Every dispatch field Job_Worker reads back must survive the delay hop.
	 * Driven off the constant so a fifth field fails here rather than being
	 * silently shorn off every delayed job.
	 */
	public function test_every_dispatch_field_survives_the_delay_hop(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'dispatch_h', $now + 30.0, 'affkey-Z', 'id-7', [ 'retries' => 6, 'attempt' => 3, 'batch' => 'bZ' ] );

		$this->assertSame( 1, Job_Delay::sweep( $now + 60.0 ) );

		$delivered = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $delivered );
		$expected = [ 'retries' => 6, 'attempt' => 3, 'batch' => 'bZ', 'key' => 'affkey-Z' ];
		foreach ( Job_Intake::DISPATCH_FIELDS as $field ) {
			$this->assertArrayHasKey( $field, $expected, "seed this test for the new dispatch field '{$field}'" );
			$this->assertSame( $expected[ $field ], $delivered[0][ $field ] ?? null, "dispatch field '{$field}' was shorn off" );
		}
	}

	/**
	 * ADR-12: one torn line in the delay log is poison for its own reader, so
	 * it lands in the sweep's quarantine — where the dead-letters alert family
	 * counts it — and the jobs on either side of it still deliver.
	 */
	public function test_a_torn_line_is_quarantined_and_the_jobs_around_it_deliver(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'torn_before_h', $now + 20.0 );
		$segments = \glob( "{$this->tmp}/logs/jobdelay.p0/*.log" );
		$this->assertCount( 1, $segments );
		\file_put_contents( $segments[0], "torn-7731{\"k\":\"job\n", \FILE_APPEND );
		$this->seed_delayed( 'torn_after_h', $now + 40.0 );

		$this->assertSame( 2, Job_Delay::sweep( $now + 90.0 ) );

		$handlers = array_column( $this->read_all_jobintake_lines(), 'handler' );
		sort( $handlers );
		$this->assertSame( [ 'torn_after_h', 'torn_before_h' ], $handlers );
		$quarantine = \glob( "{$this->tmp}/deadletter/" . Job_Delay::READER . '.p0/*.log' );
		$this->assertCount( 1, $quarantine, 'the torn line is dead-lettered where dl_list and the alerts find it' );
		$this->assertStringContainsString( 'torn-7731', (string) \file_get_contents( $quarantine[0] ) );
		$this->assertSame( 0, Job_Delay::sweep( $now + 120.0 ), 'the cursor moved past the torn line' );
	}

	public function test_short_delay_is_not_blocked_by_long_delay_ahead_of_it(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'later_h', $now + 3600.0 );
		$this->seed_delayed( 'soon_h', $now + 5.0 );

		$this->assertSame( 1, Job_Delay::sweep( $now + 10.0 ) );

		$delivered = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $delivered );
		$this->assertSame( 'soon_h', $delivered[0]['handler'], 'a long delay at the head must not block a due job behind it' );

		$this->assertSame( 1, Job_Delay::sweep( $now + 7200.0 ) );
		$handlers = array_column( $this->read_all_jobintake_lines(), 'handler' );
		sort( $handlers );
		$this->assertSame( [ 'later_h', 'soon_h' ], $handlers );
	}
}
