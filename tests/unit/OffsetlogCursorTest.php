<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversTrait;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Durable_Reader;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;

/** Minimal node exercising Durable_Reader's cursor slice; pump seams stubbed. */
class Offsetlog_Cursor_Double extends Node {
	use Durable_Reader;

	public function fill( array $message ): void {}

	/** @param array<array-key,mixed> $entry */
	public function arm( array $entry ): bool {
		return $this->arm_skip_head_from_frame( $entry );
	}

	public function armed(): bool {
		return $this->crawl_skip_head;
	}

	protected function get_batch(): void {}
	protected function init_position(): void {}
	protected function checkpoint( bool $graceful = false ): void {}
	protected function write_checkpoint_frame( bool $graceful, bool $with_state, array $extra = [] ): void {}
	protected function checkpoint_frame_extra(): array {
		return [];
	}
	public function next_offset( $position ): void {}
	protected function advance_one_message(): array {
		return [];
	}
	protected function time_travel_resume(): void {}

	public function build( string $dir ): ?Partition_Node {
		$this->offsetlog_dir = $dir;
		return $this->ensure_offsetlog();
	}

	/** @return array<array-key, mixed>|null */
	public function read(): ?array {
		return $this->read_last_offsetlog_frame();
	}

	/** @param array<array-key, mixed> $value */
	public function commit( array $value ): void {
		$this->commit_offsetlog_frame( $value );
	}
}

#[CoversTrait( Durable_Reader::class )]
class OffsetlogCursorTest extends TestCase {

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

	public function test_ensure_offsetlog_returns_null_for_empty_dir(): void {
		$d = new Offsetlog_Cursor_Double();
		$this->assertNull( $d->build( '' ) );
		$this->assertNull( $this->read_private( $d, 'offsetlog' ) );
	}

	public function test_ensure_offsetlog_builds_and_is_idempotent(): void {
		$d     = new Offsetlog_Cursor_Double();
		$first = $d->build( "{$this->tmp}/offsets.p0" );
		$this->assertInstanceOf( Partition_Node::class, $first );
		// A second call returns the SAME partition (idempotent), never a fresh build.
		$this->assertSame( $first, $d->build( "{$this->tmp}/offsets.p0" ) );
	}

	/**
	 * A squatted `{name}:offsetlog` slot refuses the sidecar's name. The refusal
	 * must leave the slot EMPTY: a cached unnamed offsetlog keeps committing the
	 * cursor to disk while being unreachable from the registry, `ls` and
	 * `command_node` — a live node nobody can address.
	 */
	public function test_a_refused_offsetlog_name_leaves_no_cached_sidecar(): void {
		$squatter = new Offsetlog_Cursor_Double();
		$squatter->name( 'sextant:offsetlog' );
		$d = new Offsetlog_Cursor_Double();
		$d->name( 'sextant' );

		try {
			$d->build( "{$this->tmp}/cursors.p5" );
			$this->fail( 'expected the squatted offsetlog slot to be refused' );
		} catch ( \RuntimeException $e ) {
			$this->assertStringContainsString( 'sextant:offsetlog already registered', $e->getMessage() );
		}

		$this->assertNull( $this->read_private( $d, 'offsetlog' ), 'the refused sidecar is not cached' );
		$this->expectException( \RuntimeException::class );
		$d->build( "{$this->tmp}/cursors.p5" );
	}

	public function test_commit_then_read_round_trips_the_value(): void {
		$d = new Offsetlog_Cursor_Double();
		$d->build( "{$this->tmp}/offsets.p0" );
		$d->commit( [ 'segment' => 3, 'offset' => 7, 'foo' => 'bar' ] );

		$value = $d->read();
		$this->assertIsArray( $value );
		$this->assertSame( 3, $value['segment'] );
		$this->assertSame( 7, $value['offset'] );
		$this->assertSame( 'bar', $value['foo'] );
	}

	public function test_read_returns_newest_frame_when_segment_holds_many_lines(): void {
		$d = new Offsetlog_Cursor_Double();
		// A big segment so both frames append as two lines in the same segment.
		$d->build( "{$this->tmp}/offsets.p0" );
		$d->commit( [ 'segment' => 1, 'offset' => 10 ] );
		$d->commit( [ 'segment' => 2, 'offset' => 20 ] );

		$value = $d->read();
		$this->assertIsArray( $value );
		$this->assertSame( 2, $value['segment'] );
		$this->assertSame( 20, $value['offset'] );
	}

	public function test_read_returns_null_when_no_offsetlog(): void {
		$d = new Offsetlog_Cursor_Double();
		$this->assertNull( $d->read() );
	}

	public function test_read_falls_back_to_prior_segment_when_tail_empty(): void {
		$d = new Offsetlog_Cursor_Double();
		$d->build( "{$this->tmp}/offsets.p0" );
		\mkdir( "{$this->tmp}/offsets.p0", 0755, true );

		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'segment' => 4, 'offset' => 256 ];
		// Newest segment empty (rotated-but-unwritten tail); the committed frame
		// lives in the prior segment — read must fall back to it.
		\file_put_contents( "{$this->tmp}/offsets.p0/0.log", Message::packed( $message ) . "\n" );
		\file_put_contents( "{$this->tmp}/offsets.p0/1.log", '' );

		$value = $d->read();
		$this->assertIsArray( $value );
		$this->assertSame( 4, $value['segment'] );
		$this->assertSame( 256, $value['offset'] );
	}

	public function test_read_returns_null_for_unparseable_entry(): void {
		$d = new Offsetlog_Cursor_Double();
		$d->build( "{$this->tmp}/offsets.p0" );
		\mkdir( "{$this->tmp}/offsets.p0", 0755, true );
		\file_put_contents( "{$this->tmp}/offsets.p0/0.log", "this is not a packed message\n" );
		$this->assertNull( $d->read() );
	}

	public function test_read_returns_null_for_non_array_value(): void {
		$d = new Offsetlog_Cursor_Double();
		$d->build( "{$this->tmp}/offsets.p0", 64 * 1024, 4 );
		\mkdir( "{$this->tmp}/offsets.p0", 0755, true );
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = 'scalar-not-a-cursor';
		\file_put_contents( "{$this->tmp}/offsets.p0/0.log", Message::packed( $message ) . "\n" );
		$this->assertNull( $d->read() );
	}
	// ── arm_skip_head_from_frame: the crash-lineage boot head-skip ──

	public function test_arm_skip_head_from_frame_arms_crash_on_hard_crash_lineage(): void {
		\Newspack_Nodes\Core::$now = 7000.0;
		$d = new Offsetlog_Cursor_Double();
		// A hard-crash lineage arms the DLQ sacrifice of the resumed head.
		$this->assertTrue( $d->arm( [ 'attempts' => Offsetlog_Cursor_Double::CRASH_MAX_ATTEMPTS, 'reason' => '' ] ) );
		$this->assertTrue( $d->armed() );
	}

	public function test_arm_skip_head_from_frame_unarmed_on_a_clean_frame(): void {
		$d = new Offsetlog_Cursor_Double();
		// A graceful frame — what a disposal commits — has no lineage to arm.
		$this->assertFalse( $d->arm( [ 'attempts' => 0, 'reason' => '' ] ) );
		$this->assertFalse( $d->armed() );
	}

}
