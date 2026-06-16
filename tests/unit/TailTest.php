<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Tail_Node::class )]
class TailTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** A Tail reads a Log's {file}.{seg} segments; seed one directly. */
	private function write_segment( string $file, int $seg, string $bytes ): void {
		\file_put_contents( "{$file}.{$seg}", $bytes );
	}

	/** poll_active drains-then-reads (one-tick lag), so pump several times to flush. */
	private function pump( Tail_Node $t, int $times = 6 ): void {
		for ( $i = 0; $i < $times; $i++ ) {
			$t->poll();
		}
	}

	private function values( Capture_Sink_Node $cap ): array {
		return \array_map( static fn ( $m ) => $m[ Message::VALUE ], $cap->captured );
	}

	public function test_constructible_via_no_arg_ctor_and_arguments_setter(): void {
		$t = new Tail_Node();
		$t->arguments( "{$this->tmp}/data.log {$this->tmp}/off" );
		$ref = new \ReflectionClass( $t );
		$this->assertSame( "{$this->tmp}/data.log", $ref->getProperty( 'source_file' )->getValue( $t ) );
		$this->assertSame( "{$this->tmp}/off",      $ref->getProperty( 'offsetlog_dir' )->getValue( $t ) );
	}

	public function test_source_is_a_log_reading_file_dot_seg_segments(): void {
		// The Tail's source node is a Log_Node (file layout), not a Partition (dir layout).
		$t = new Tail_Node();
		$t->arguments( "{$this->tmp}/data.log {$this->tmp}/off" );
		$ref    = new \ReflectionClass( \Newspack_Nodes\Consumer_Node::class );
		$source = $ref->getProperty( 'source' )->getValue( $t );
		$this->assertInstanceOf( \Newspack_Nodes\Log_Node::class, $source );
	}

	public function test_default_starts_at_end_then_emits_only_appended_bytes(): void {
		// THE BUG FIX: a fresh Tail with no durable cursor starts at end-of-file —
		// pre-existing content is NOT re-read; only bytes appended after start emit.
		$file = "{$this->tmp}/data.log";
		$this->write_segment( $file, 0, "old1\nold2\n" );
		$t   = new Tail_Node();
		$t->arguments( "{$file} {$this->tmp}/off" );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$this->pump( $t );
		$this->assertCount( 0, $cap->captured, 'default=end must not replay pre-existing content' );

		\file_put_contents( "{$file}.0", "new1\n", \FILE_APPEND );
		$this->pump( $t );
		$this->assertSame( [ "new1\n" ], $this->values( $cap ) );
	}

	public function test_next_offset_start_reads_pre_existing_content_line_buffered(): void {
		$file = "{$this->tmp}/data.log";
		$this->write_segment( $file, 0, "first\nsecond\nthird\n" );
		$t   = new Tail_Node();
		$t->arguments( "{$file} {$this->tmp}/off" );
		$t->next_offset( 'start' ); // explicit seek beats the end default.
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$this->pump( $t );
		$this->assertSame( [ "first\n", "second\n", "third\n" ], $this->values( $cap ) );
	}

	public function test_line_mode_emits_one_line_per_poll(): void {
		// A Tail can opt into line_mode (one line per poll) just like any Consumer —
		// the per-line emit (forward_line) is paced by the shared drain loop.
		$file = "{$this->tmp}/data.log";
		$this->write_segment( $file, 0, "first\nsecond\n" );
		$t = new Tail_Node();
		$t->arguments( "{$file} {$this->tmp}/off" );
		$t->next_offset( 'start' );
		$t->set_line_mode( true );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$this->pump( $t );
		$this->assertSame( [ "first\n", "second\n" ], $this->values( $cap ) );
	}

	public function test_follows_segment_roll(): void {
		// Content split across {file}.0 and {file}.1; the inherited get_batch rolls
		// to the next segment, so the Tail reads across both.
		$file = "{$this->tmp}/data.log";
		$this->write_segment( $file, 0, "a\nb\n" );
		$this->write_segment( $file, 1, "c\nd\n" );
		$t   = new Tail_Node();
		$t->arguments( "{$file} {$this->tmp}/off" );
		$t->next_offset( 'start' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$this->pump( $t, 10 );
		$this->assertSame( [ "a\n", "b\n", "c\n", "d\n" ], $this->values( $cap ) );
	}

	public function test_resumes_from_durable_checkpoint_after_restart(): void {
		// Tail1 reads everything from start and checkpoints; Tail2 (same offsetlog)
		// resumes from the cursor — it does NOT re-read, and picks up only new appends.
		$file = "{$this->tmp}/data.log";
		$off  = "{$this->tmp}/off";
		$this->write_segment( $file, 0, "one\ntwo\n" );

		$t1  = new Tail_Node();
		$t1->arguments( "{$file} {$off}" );
		$t1->next_offset( 'start' );
		$cap1 = new Capture_Sink_Node();
		$t1->sink( $cap1 );
		$this->pump( $t1 );
		$this->assertSame( [ "one\n", "two\n" ], $this->values( $cap1 ) );
		$t1->checkpoint();

		\file_put_contents( "{$file}.0", "three\n", \FILE_APPEND );

		$t2  = new Tail_Node();
		$t2->arguments( "{$file} {$off}" );
		$cap2 = new Capture_Sink_Node();
		$t2->sink( $cap2 );
		$this->pump( $t2 );
		$this->assertSame( [ "three\n" ], $this->values( $cap2 ), 'resume reads only post-checkpoint bytes' );
	}

	public function test_poll_stamps_TO_from_connect_node_target(): void {
		$file = "{$this->tmp}/data.log";
		$this->write_segment( $file, 0, "hello\n" );
		$t = new Tail_Node();
		$t->arguments( "{$file} {$this->tmp}/off" );
		$t->next_offset( 'start' );
		$t->connect_node( 'mysession' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$this->pump( $t );
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'mysession', $cap->captured[0][ Message::TO ] );
		$this->assertSame( $t->name(), $cap->captured[0][ Message::FROM ] ?: $t->name() );
	}

	public function test_emits_TM_BYTESTREAM(): void {
		$file = "{$this->tmp}/data.log";
		$this->write_segment( $file, 0, "x\n" );
		$t = new Tail_Node();
		$t->arguments( "{$file} {$this->tmp}/off" );
		$t->next_offset( 'start' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$this->pump( $t );
		$this->assertCount( 1, $cap->captured );
		$this->assertSame( Message::TM_BYTESTREAM, (int) $cap->captured[0][ Message::TYPE ] );
	}

	public function test_missing_source_does_not_throw(): void {
		$t = new Tail_Node();
		$t->arguments( "{$this->tmp}/missing.log {$this->tmp}/off" );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$this->pump( $t ); // must not throw.
		$this->assertCount( 0, $cap->captured );
	}

	public function test_node_schema_arguments_and_terminal_shape(): void {
		$schema = Tail_Node::node_schema();
		$names  = \array_column( $schema['arguments'], 'name' );
		$this->assertSame( [ 'source_file', 'offsetlog_dir' ], $names );
		// Pure producer: no IN port, has an OUT target. (Inherited from Consumer.)
		$this->assertFalse( $schema['accepts_fill'] ?? true );
		$this->assertTrue( $schema['has_target'] ?? false );
	}
}
