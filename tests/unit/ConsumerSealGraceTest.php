<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * Seal-grace for multi-writer segment rotation.
 *
 * On a multi-writer partition (the firehose) a straggler process can keep
 * appending to segment N for up to DRIFT_RESCAN after a peer created N+1. The
 * default reader advances the instant it is caught up and a newer segment
 * exists, orphaning those late writes (chiefly a request's terminal
 * `process (complete)`). `multi_writer` mode holds the reader on N until
 * SEAL_GRACE has passed since the later of N's mtime plus one second and the
 * TIMESTAMP of N+1's first record, and while N+1 is still empty, so the
 * straggler is consumed in order.
 */
#[CoversClass( Consumer_Node::class )]
class ConsumerSealGraceTest extends TestCase {
	/** The driven clock: later than any file's mtime a fixture sets, earlier than a fresh append's. */
	private const EPOCH = 1700000000.0;

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
		$this->tmp = $this->make_temp_dir();
		Core::$now = self::EPOCH;
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** Append one packed TM_BYTESTREAM line, stamped an hour old, to a segment file (a raw producer append). */
	private function append_line( string $dir, int $segment, string $value ): void {
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		$this->append_stamped( $dir, $segment, $value, self::EPOCH - 3600.0 );
	}

	/** Age a segment file to `$age` whole seconds before the driven clock. */
	private function age_segment( string $dir, int $segment, int $age ): void {
		\touch( "{$dir}/{$segment}.log", (int) self::EPOCH - $age );
	}

	/** Append one record whose TIMESTAMP is `$stamp` to a segment file. */
	private function append_stamped( string $dir, int $segment, string $value, float $stamp ): void {
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		$m                   = Message::new_message();
		$m[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$m[ Message::TIMESTAMP ] = $stamp;
		$m[ Message::VALUE ] = $value;
		\file_put_contents( "{$dir}/{$segment}.log", Message::packed( $m ) . "\n", \FILE_APPEND );
	}

	private function make_consumer( string $dir, bool $multi_writer ): Consumer_Node {
		$c = new Consumer_Node();
		$c->arguments( [ "{$dir}", "{$this->tmp}/offsets" ] );
		$c->set_multi_writer( $multi_writer );
		$c->sink( new Capture_Sink_Node() );
		return $c;
	}

	/** @return array<int, mixed> */
	private function captured_values( Consumer_Node $c ): array {
		$ref     = new \ReflectionProperty( $c->sink(), 'captured' );
		$msgs    = $ref->getValue( $c->sink() );
		return \array_map( static fn ( array $m ): mixed => $m[ Message::VALUE ], Core::arr( $msgs ) );
	}

	private function cursor_segment( Consumer_Node $c ): int {
		return (int) ( new \ReflectionProperty( Consumer_Node::class, 'cursor_segment' ) )->getValue( $c );
	}

	// ---- default (single-writer) path: unchanged, no added latency ----------

	public function test_single_writer_advances_across_boundary_immediately(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->append_line( $dir, 1, 'b' );

		$c = $this->make_consumer( $dir, false );
		$this->pump_consumer( $c ); // no clock advance — default must NOT gate.

		$this->assertSame( [ 'a', 'b' ], $this->captured_values( $c ) );
	}

	public function test_single_writer_orphans_a_late_write_documents_the_bug(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->append_line( $dir, 1, 'b' );

		$c = $this->make_consumer( $dir, false );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'b' ], $this->captured_values( $c ) );

		// A straggler appends to the already-abandoned segment 0.
		$this->append_line( $dir, 0, 'late' );
		$this->pump_consumer( $c );

		// Default mode never rereads seg 0 → 'late' is orphaned forever.
		$this->assertSame( [ 'a', 'b' ], $this->captured_values( $c ) );
	}

	// ---- multi_writer path: seal-grace holds the segment ---------------------

	public function test_multi_writer_holds_segment_until_sealed_and_captures_late_write(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->append_line( $dir, 1, 'b' );

		$c = $this->make_consumer( $dir, true );

		// Caught up to seg 0; seg 1 exists — but multi_writer holds (unsealed).
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a' ], $this->captured_values( $c ), 'held on seg 0, did not jump to b' );
		$this->assertSame( 0, $this->cursor_segment( $c ) );

		// Straggler lands on seg 0 within the grace window; it is consumed in order.
		$this->append_line( $dir, 0, 'late' );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'late' ], $this->captured_values( $c ) );
		$this->assertSame( 0, $this->cursor_segment( $c ) );

		// Segment now untouched past SEAL_GRACE plus the mtime second → advance.
		$this->age_segment( $dir, 0, 3 );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'late', 'b' ], $this->captured_values( $c ) );
	}

	public function test_multi_writer_append_moves_the_seal_boundary(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->append_line( $dir, 1, 'b' );

		$c = $this->make_consumer( $dir, true );
		$this->pump_consumer( $c );

		// Aged to the edge of the window: whole-second mtime holds it at 2.
		$this->age_segment( $dir, 0, 2 );
		$this->pump_consumer( $c );
		$this->assertSame( 0, $this->cursor_segment( $c ), 'two seconds old is still held' );

		// A straggler appends: the mtime moves, so the window restarts.
		$this->append_line( $dir, 0, 'late' );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'late' ], $this->captured_values( $c ) );
		$this->assertSame( 0, $this->cursor_segment( $c ), 'growth restarted the window' );

		$this->age_segment( $dir, 0, 3 );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'late', 'b' ], $this->captured_values( $c ) );
	}

	public function test_multi_writer_holds_while_the_next_segment_is_younger_than_the_grace(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->age_segment( $dir, 0, 10 );
		$this->append_stamped( $dir, 1, 'b', self::EPOCH - 0.5 );

		$c = $this->make_consumer( $dir, true );
		$this->pump_consumer( $c );

		$this->assertSame( [ 'a' ], $this->captured_values( $c ) );
		$this->assertSame( 0, $this->cursor_segment( $c ), 'a peer may still flush into 0 after 1 appeared' );
	}

	public function test_multi_writer_crosses_once_the_next_segment_is_older_than_the_grace(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->age_segment( $dir, 0, 10 );
		$this->append_stamped( $dir, 1, 'b', self::EPOCH - 3.4 );

		$c = $this->make_consumer( $dir, true );
		$this->pump_consumer( $c );

		$this->assertSame( [ 'a', 'b' ], $this->captured_values( $c ) );
	}

	public function test_multi_writer_reads_no_head_while_the_mtime_already_holds(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->append_line( $dir, 1, 'b' );

		$c = $this->make_consumer( $dir, true );
		$this->pump_consumer( $c );
		$source = $this->read_private( $c, 'source' );
		$before = $source->bytes_read();
		$this->pump_consumer( $c );

		$this->assertSame( 0, $this->cursor_segment( $c ) );
		$this->assertSame( $before, $source->bytes_read(), 'a segment held by its mtime needs no look at its successor' );
	}

	public function test_multi_writer_holds_while_the_next_segment_is_still_empty(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->age_segment( $dir, 0, 10 );
		\file_put_contents( "{$dir}/1.log", '' );

		$c = $this->make_consumer( $dir, true );
		$this->pump_consumer( $c );

		$this->assertSame( [ 'a' ], $this->captured_values( $c ) );
		$this->assertSame( 0, $this->cursor_segment( $c ), 'a rotation just created 1; its first record has not landed' );
	}

	public function test_multi_writer_reads_a_stamp_just_ahead_of_the_cached_clock(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->age_segment( $dir, 0, 10 );
		$this->append_stamped( $dir, 1, 'b', self::EPOCH + 0.05 );

		$c = $this->make_consumer( $dir, true );
		$this->pump_consumer( $c );

		$this->assertSame( 0, $this->cursor_segment( $c ), 'a fresh peer stamp is not a forged future one' );
	}

	public function test_multi_writer_ignores_a_future_stamp_on_the_next_segment(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->age_segment( $dir, 0, 10 );
		$this->append_stamped( $dir, 1, 'b', self::EPOCH + 600.0 );

		$c = $this->make_consumer( $dir, true );
		$this->pump_consumer( $c );

		$this->assertSame( [ 'a', 'b' ], $this->captured_values( $c ), 'a forged future stamp cannot pin the reader' );
	}

	public function test_multi_writer_ignores_an_unparseable_head_on_the_next_segment(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->age_segment( $dir, 0, 10 );
		\file_put_contents( "{$dir}/1.log", "torn-5521\n" );

		$c      = $this->make_consumer( $dir, true );
		$raised = null;
		try {
			$this->pump_consumer( $c );
		} catch ( \InvalidArgumentException $e ) {
			$raised = $e;
		}

		$this->assertNotNull( $raised, 'the torn head raises once the reader is on segment 1' );
		$this->assertStringContainsString( 'torn-5521', $raised->getMessage() );
		$this->assertSame( 1, $this->cursor_segment( $c ), 'the mtime alone decides' );
	}

	public function test_multi_writer_tail_over_a_log_reads_no_stamp_from_values(): void {
		$base = "{$this->tmp}/gate.log";
		\file_put_contents( "{$base}.0", "alpha\n" );
		\touch( "{$base}.0", (int) self::EPOCH - 10 );
		// A Log holds bare VALUEs; this one only looks like a packed head stamped now.
		\file_put_contents( "{$base}.1", "[1,1700000000.0,\"x\"]\n" );
		$tail = new Tail_Node();
		$tail->arguments( [ $base ] );
		$tail->set_multi_writer( true );
		$tail->sink( new Capture_Sink_Node() );
		$tail->next_offset( 'start' );

		$this->pump_consumer( $tail );

		$this->assertCount( 2, $this->captured_values( $tail ), 'a Log segment has no stamp, so the mtime decides' );
	}

	public function test_multi_writer_quiescent_segment_advances_after_grace(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->append_line( $dir, 1, 'b' );

		$c = $this->make_consumer( $dir, true );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a' ], $this->captured_values( $c ), 'grace applies even with no straggler' );

		$this->age_segment( $dir, 0, 3 );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'b' ], $this->captured_values( $c ), 'no permanent stall on a quiet segment' );
	}

	public function test_multi_writer_advances_immediately_off_ancient_segments(): void {
		// Only the second-newest segment can still receive a straggler (bounded by
		// DRIFT_RESCAN). A segment many rotations back is definitely sealed, so a
		// consumer catching up on a backlog must NOT pay the grace crossing it.
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->append_line( $dir, 1, 'b' );
		$this->append_line( $dir, 2, 'c' );

		$c = $this->make_consumer( $dir, true );
		// No clock advance: ancient seg 0 (newest-2) advances at once; only the
		// live-boundary seg 1 (newest-1) holds for the grace.
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'b' ], $this->captured_values( $c ) );
		$this->assertSame( 1, $this->cursor_segment( $c ), 'sat on the live-boundary segment, not stalled on the ancient one' );

		$this->age_segment( $dir, 1, 3 );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'b', 'c' ], $this->captured_values( $c ) );
	}

	public function test_multi_writer_newest_segment_never_gates(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );

		$c = $this->make_consumer( $dir, true );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a' ], $this->captured_values( $c ) );

		// Newest/only segment is live-tailed with no grace (nothing to advance to).
		$this->append_line( $dir, 0, 'b' );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'b' ], $this->captured_values( $c ) );
	}

	public function test_multi_writer_defaults_off_and_setter_toggles_it(): void {
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/d", "{$this->tmp}/o" ] );
		$prop = new \ReflectionProperty( Consumer_Node::class, 'multi_writer' );
		$this->assertFalse( $prop->getValue( $c ), 'default is single-writer (immediate advance)' );

		$c->set_multi_writer( true );
		$this->assertTrue( $prop->getValue( $c ) );
	}

	public function test_set_multi_writer_verb_enables_only_on_truthy_arg(): void {
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/d", "{$this->tmp}/o" ] );
		$interp = $this->read_private( $c, 'interpreter' );
		$this->assertSame( "ok\n", $interp->dispatch( 'set_multi_writer', [ 'true' ] ) );
		$prop = new \ReflectionProperty( Consumer_Node::class, 'multi_writer' );
		$this->assertTrue( $prop->getValue( $c ) );

		$interp->dispatch( 'set_multi_writer', [ 'off' ] );
		$this->assertFalse( $prop->getValue( $c ), 'a falsy word disables' );

		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessage( 'enabled wants a bool' );
		$interp->dispatch( 'set_multi_writer', [ 'nope' ] );
	}
}
