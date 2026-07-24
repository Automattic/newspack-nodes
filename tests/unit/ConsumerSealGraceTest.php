<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Seal-grace for multi-writer segment rotation.
 *
 * On a multi-writer partition (the firehose) a straggler process can keep
 * appending to segment N for up to DRIFT_RESCAN after a peer created N+1. The
 * default reader advances the instant it is caught up and a newer segment
 * exists, orphaning those late writes (chiefly a request's terminal
 * `process (complete)`). `multi_writer` mode holds the reader on N until N's
 * size has been stable for >= SEAL_GRACE, so the straggler is consumed in order.
 */
#[CoversClass( Consumer_Node::class )]
class ConsumerSealGraceTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		Event_Framework::reset();
		$this->tmp = $this->make_temp_dir();
		Core::$now = 1000.0;
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** Append one packed TM_BYTESTREAM line directly to a segment file (simulates a raw producer append). */
	private function append_line( string $dir, int $segment, string $value ): void {
		if ( ! \is_dir( $dir ) ) {
			\mkdir( $dir, 0755, true );
		}
		$m                    = Message::new_message();
		$m[ Message::TYPE ]   = Message::TM_BYTESTREAM;
		$m[ Message::VALUE ]  = $value;
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

		// Segment now quiescent for >= SEAL_GRACE → advance to seg 1.
		Core::$now += Consumer_Node::SEAL_GRACE_SECONDS + 0.1;
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'late', 'b' ], $this->captured_values( $c ) );
	}

	public function test_multi_writer_growth_resets_the_seal_timer(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->append_line( $dir, 1, 'b' );

		$c = $this->make_consumer( $dir, true );
		$this->pump_consumer( $c );

		// Almost sealed, then a straggler arrives → timer must reset.
		Core::$now += Consumer_Node::SEAL_GRACE_SECONDS - 0.1;
		$this->append_line( $dir, 0, 'late' );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'late' ], $this->captured_values( $c ) );

		// Original-window would have elapsed, but the reset means seg 0 is not yet
		// sealed → still held.
		Core::$now += 0.2;
		$this->pump_consumer( $c );
		$this->assertSame( 0, $this->cursor_segment( $c ), 'growth reset the seal timer' );
		$this->assertSame( [ 'a', 'late' ], $this->captured_values( $c ) );

		// A fresh full grace of quiescence → advance.
		Core::$now += Consumer_Node::SEAL_GRACE_SECONDS + 0.1;
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a', 'late', 'b' ], $this->captured_values( $c ) );
	}

	public function test_multi_writer_quiescent_segment_advances_after_grace(): void {
		$dir = "{$this->tmp}/data.p0";
		$this->append_line( $dir, 0, 'a' );
		$this->append_line( $dir, 1, 'b' );

		$c = $this->make_consumer( $dir, true );
		$this->pump_consumer( $c );
		$this->assertSame( [ 'a' ], $this->captured_values( $c ), 'grace applies even with no straggler' );

		Core::$now += Consumer_Node::SEAL_GRACE_SECONDS + 0.1;
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

		Core::$now += Consumer_Node::SEAL_GRACE_SECONDS + 0.1;
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
		$interp = new \Newspack_Nodes\Command_Interpreter_Node();
		$interp->patron( $c );

		$set = $this->read_private( $c, 'interpreter' )->commands()['set_multi_writer'];
		$this->assertSame( 'ok', $set( $interp, [ 'true' ] ) );
		$prop = new \ReflectionProperty( Consumer_Node::class, 'multi_writer' );
		$this->assertTrue( $prop->getValue( $c ) );

		$set( $interp, [ 'nope' ] );
		$this->assertFalse( $prop->getValue( $c ), 'non-truthy disables' );
	}
}
