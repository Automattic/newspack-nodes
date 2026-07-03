<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Offsetlog_Cursor;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversTrait;

/** Minimal node that exercises the Offsetlog_Cursor trait in isolation. */
class Offsetlog_Cursor_Double extends Node {
	use Offsetlog_Cursor;

	public function fill( array &$message ): void {}

	public function build( string $dir, int $segment_size = 1, int $num_segments = 10 ): ?Partition_Node {
		return $this->ensure_offsetlog( $dir, 'double:offsetlog', $segment_size, $num_segments );
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

#[CoversTrait( Offsetlog_Cursor::class )]
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

	public function test_read_returns_null_when_no_offsetlog(): void {
		$d = new Offsetlog_Cursor_Double();
		$this->assertNull( $d->read() );
	}

	public function test_read_falls_back_to_prior_segment_when_tail_empty(): void {
		$d = new Offsetlog_Cursor_Double();
		$d->build( "{$this->tmp}/offsets.p0", 64 * 1024, 4 );
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
		$d->build( "{$this->tmp}/offsets.p0", 64 * 1024, 4 );
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
}
