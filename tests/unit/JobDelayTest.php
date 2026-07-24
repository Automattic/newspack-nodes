<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Job_Delay;
use Newspack_Nodes\Job_Intake;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

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
		$this->assertTrue( $intake->write_job( $handler, [ 'seeded' => 1 ], $key, $id, [ 'not_before' => $not_before ] + $extra ) );
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
		$this->assertSame( 0, Job_Delay::sweep( $this->tmp, 2 ) );
		$this->assertDirectoryDoesNotExist( "{$this->tmp}/logs/jobdelay.p0" );
	}

	public function test_sweep_delivers_due_entry_stripped_and_keyed(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'due_h', $now + 30.0, 'affkey', 'id9', [ 'retries' => 4 ] );

		$this->assertSame( 1, Job_Delay::sweep( $this->tmp, 2, $now + 60.0 ) );

		$expected_p = Partition_Node::hash_to_partition( 'affkey', 2 );
		$lines      = $this->read_partition_dir_lines( "jobintake.p{$expected_p}" );
		$this->assertCount( 1, $lines, 'delivery must honor the original partition key' );
		$this->assertSame( 'due_h', $lines[0]['handler'] );
		$this->assertSame( 'id9', $lines[0]['id'] );
		$this->assertSame( 4, $lines[0]['retries'] );
		$this->assertSame( 'affkey', $lines[0]['key'], 'delivered entries keep their key so a later retry re-parks correctly' );
		$this->assertArrayNotHasKey( 'not_before', $lines[0] );
	}

	public function test_sweep_circulates_not_due_and_delivers_exactly_once_later(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'later_h', $now + 3600.0 );

		$this->assertSame( 0, Job_Delay::sweep( $this->tmp, 2, $now ) );
		$this->assertSame( [], $this->read_all_jobintake_lines() );

		// The durable cursor + the circulated copy: a later sweep delivers ONE.
		$this->assertSame( 1, Job_Delay::sweep( $this->tmp, 2, $now + 7200.0 ) );
		$this->assertCount( 1, $this->read_all_jobintake_lines(), 'circulation must never duplicate a pending job' );

		// And a third sweep finds nothing left.
		$this->assertSame( 0, Job_Delay::sweep( $this->tmp, 2, $now + 9000.0 ) );
		$this->assertCount( 1, $this->read_all_jobintake_lines() );
	}

	public function test_failed_circulation_never_loses_a_pending_entry(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'survivor_h', $now + 3600.0 );

		// Wedge the re-append: the delay dir refuses writes mid-sweep.
		chmod( "{$this->tmp}/logs/jobdelay.p0", 0555 );
		try {
			Job_Delay::sweep( $this->tmp, 2, $now );
		} catch ( \RuntimeException $e ) {
			// The aborted sweep may throw; what matters is what survives.
		} finally {
			chmod( "{$this->tmp}/logs/jobdelay.p0", 0755 );
		}

		$this->assertSame(
			1,
			Job_Delay::sweep( $this->tmp, 2, $now + 7200.0 ),
			'an aborted circulation must leave the cursor behind the entry, never checkpoint past it'
		);
	}

	public function test_short_delay_is_not_blocked_by_long_delay_ahead_of_it(): void {
		$now = \microtime( true );
		$this->seed_delayed( 'later_h', $now + 3600.0 );
		$this->seed_delayed( 'soon_h', $now + 5.0 );

		$this->assertSame( 1, Job_Delay::sweep( $this->tmp, 2, $now + 10.0 ) );

		$delivered = $this->read_all_jobintake_lines();
		$this->assertCount( 1, $delivered );
		$this->assertSame( 'soon_h', $delivered[0]['handler'], 'a long delay at the head must not block a due job behind it' );

		$this->assertSame( 1, Job_Delay::sweep( $this->tmp, 2, $now + 7200.0 ) );
		$handlers = array_column( $this->read_all_jobintake_lines(), 'handler' );
		sort( $handlers );
		$this->assertSame( [ 'later_h', 'soon_h' ], $handlers );
	}
}
