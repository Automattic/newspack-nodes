<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Message;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Single-file follow mode (`tail -F` with logrotate semantics): the SECOND source
 * shape of Tail_Node. Follows one filename across rotation/truncation, tracking the
 * generation identity by inode. Segmented `{file}.{seg}` mode is exercised by TailTest.
 */
#[CoversClass( Tail_Node::class )]
class TailFileFollowTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	/** poll_active drains-then-reads and get_batch reads one block per tick, so pump generously. */
	private function pump( Tail_Node $t, int $times = 12 ): void {
		for ( $i = 0; $i < $times; $i++ ) {
			$t->poll();
		}
	}

	private function values( Capture_Sink_Node $cap ): array {
		return \array_map( static fn ( $m ) => $m[ Message::VALUE ], $cap->captured );
	}

	/** File-mode Tail following $path, with an optional offsetlog dir for durable-resume tests. */
	private function follow( string $path, string $offsetlog = '' ): Tail_Node {
		$t = new Tail_Node();
		$t->arguments( [ $path, $offsetlog, '', Tail_Node::MODE_FILE ] );
		return $t;
	}

	public function test_file_mode_defaults_to_end_then_emits_only_appended_bytes(): void {
		$path = "{$this->tmp}/debug.log";
		\file_put_contents( $path, "seedline\n" );

		$t   = $this->follow( $path );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$this->pump( $t );
		$this->assertCount( 0, $cap->captured, 'a fresh file-mode Tail starts at END; pre-existing content is not replayed' );

		\file_put_contents( $path, "alpha\nbeta\n", \FILE_APPEND );
		$this->pump( $t );
		$this->assertSame( [ "alpha\n", "beta\n" ], $this->values( $cap ) );
	}

	public function test_file_mode_buffers_partial_trailing_line_until_newline_arrives(): void {
		$path = "{$this->tmp}/debug.log";
		\file_put_contents( $path, '' );

		$t   = $this->follow( $path );
		$t->next_offset( 'start' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		\file_put_contents( $path, 'partia', \FILE_APPEND ); // No newline yet.
		$this->pump( $t );
		$this->assertCount( 0, $cap->captured, 'a partial trailing line stays buffered until its newline arrives' );

		\file_put_contents( $path, "l-line\n", \FILE_APPEND );
		$this->pump( $t );
		$this->assertSame( [ "partial-line\n" ], $this->values( $cap ) );
	}

	public function test_file_mode_logrotate_drains_old_generation_before_new(): void {
		$path = "{$this->tmp}/debug.log";
		\file_put_contents( $path, "old1\nold2\n" );

		$t   = $this->follow( $path );
		$t->next_offset( 'start' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$this->pump( $t );
		$this->assertSame( [ "old1\n", "old2\n" ], $this->values( $cap ) );

		// Leave an UNREAD line in the current generation, then logrotate it away
		// (rename the old inode aside, create a fresh inode at the path).
		\file_put_contents( $path, "old3\n", \FILE_APPEND );
		\rename( $path, "{$path}.1" );
		\file_put_contents( $path, "new1\n" );

		$this->pump( $t );
		$this->assertSame(
			[ "old1\n", "old2\n", "old3\n", "new1\n" ],
			$this->values( $cap ),
			'the still-open old generation drains to EOF before the new file emits — no lost tail-end'
		);
	}

	public function test_file_mode_truncation_resets_to_zero(): void {
		$path = "{$this->tmp}/debug.log";
		\file_put_contents( $path, "aaaa\nbbbb\n" );

		$t   = $this->follow( $path );
		$t->next_offset( 'start' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$this->pump( $t );
		$this->assertSame( [ "aaaa\n", "bbbb\n" ], $this->values( $cap ) );

		// copytruncate: same inode, truncated in place then rewritten smaller.
		\file_put_contents( $path, "cc\n" );
		$this->pump( $t );
		$this->assertSame( [ "aaaa\n", "bbbb\n", "cc\n" ], $this->values( $cap ), 'a shrunk same-inode file resets the read cursor to 0' );
	}

	public function test_file_mode_missing_file_is_not_an_error_and_reopens(): void {
		$path = "{$this->tmp}/not-yet.log";

		$t   = $this->follow( $path ); // File does not exist at construction.
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$this->pump( $t ); // Must not throw while the file is absent.
		$this->assertCount( 0, $cap->captured );

		\file_put_contents( $path, "appeared\n" );
		$this->pump( $t );
		$this->assertSame( [ "appeared\n" ], $this->values( $cap ), 'the Tail reopens the path once it reappears' );
	}

	/** t1 reads $seed from start and checkpoints; returns the offsetlog dir for a t2 resume. */
	private function seed_and_checkpoint( string $path, string $seed ): string {
		$off = "{$this->tmp}/off";
		\file_put_contents( $path, $seed );
		$t1 = $this->follow( $path, $off );
		$t1->next_offset( 'start' );
		$cap1 = new Capture_Sink_Node();
		$t1->sink( $cap1 );
		$this->pump( $t1 );
		$t1->checkpoint();
		return $off;
	}

	public function test_file_mode_resume_at_valid_line_boundary_emits_no_duplicates(): void {
		// Cursor within size AND byte-before-cursor is "\n": resume, no re-read.
		$path = "{$this->tmp}/debug.log";
		$off  = $this->seed_and_checkpoint( $path, "one\ntwo\n" ); // cursor lands at 8, byte[7]="\n".

		\file_put_contents( $path, "three\n", \FILE_APPEND );

		$t2  = $this->follow( $path, $off );
		$cap = new Capture_Sink_Node();
		$t2->sink( $cap );
		$this->pump( $t2 );
		$this->assertSame( [ "three\n" ], $this->values( $cap ), 'a valid line-boundary cursor resumes without re-reading' );
	}

	public function test_file_mode_resume_after_shrink_restarts_from_zero(): void {
		// size < cursor (file replaced by something shorter): restart from 0.
		$path = "{$this->tmp}/debug.log";
		$off  = $this->seed_and_checkpoint( $path, "alpha\nbravo\n" ); // cursor lands at 12.

		\file_put_contents( $path, "x\n" ); // 2 bytes < 12.

		$t2  = $this->follow( $path, $off );
		$cap = new Capture_Sink_Node();
		$t2->sink( $cap );
		$this->pump( $t2 );
		$this->assertSame( [ "x\n" ], $this->values( $cap ), 'a shrunk file (size < cursor) restarts from offset 0' );
	}

	public function test_file_mode_resume_rotated_away_different_inode_restarts_from_zero(): void {
		// The checkpointed inode was rotated aside; a DIFFERENT inode now sits at the path. Restart from 0.
		$path = "{$this->tmp}/debug.log";
		$off  = $this->seed_and_checkpoint( $path, "one\ntwo\n" ); // cursor lands at 8, inode X.

		\rename( $path, "{$path}.1" );
		\file_put_contents( $path, "fresh1\nfresh2\n" ); // New inode Y != X.

		$t2  = $this->follow( $path, $off );
		$cap = new Capture_Sink_Node();
		$t2->sink( $cap );
		$this->pump( $t2 );
		$this->assertSame( [ "fresh1\n", "fresh2\n" ], $this->values( $cap ), 'an inode mismatch restarts from offset 0 of the current file' );
	}

	public function test_file_mode_resume_same_inode_bad_line_boundary_restarts_from_zero(): void {
		// Same inode (copytruncate-in-place regrow) but byte-before-cursor is NOT "\n": restart from 0.
		$path = "{$this->tmp}/debug.log";
		$off  = $this->seed_and_checkpoint( $path, "one\ntwo\n" ); // cursor lands at 8, byte[7]="\n".

		// Truncate + rewrite IN PLACE (same inode): 12 bytes >= cursor 8, but byte[7]='A', not "\n".
		\file_put_contents( $path, "AAAAAAAAAAA\n" );

		$t2  = $this->follow( $path, $off );
		$cap = new Capture_Sink_Node();
		$t2->sink( $cap );
		$this->pump( $t2 );
		$this->assertSame( [ "AAAAAAAAAAA\n" ], $this->values( $cap ), 'a same-inode cursor whose preceding byte is not a newline restarts from 0' );
	}

	public function test_file_mode_offsetlog_frame_stores_the_inode_in_the_container_slot(): void {
		// The persisted cursor reuses the segment slot for the inode: {segment: <inode>, offset: 8}.
		$path  = "{$this->tmp}/debug.log";
		$off   = "{$this->tmp}/off";
		\file_put_contents( $path, "one\ntwo\n" );
		$inode = (int) \stat( $path )['ino'];

		$t   = $this->follow( $path, $off );
		$t->next_offset( 'start' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$this->pump( $t );
		$t->checkpoint();

		$frame = $this->read_offsetlog_frame( $off );
		$this->assertSame( $inode, (int) $frame['segment'], 'the inode sits where the segment id sits in segmented mode' );
		$this->assertSame( 8, (int) $frame['offset'] );
		// The frame labels its source by the followed filename (source_dir is unset in file mode).
		$this->assertSame( 'debug.log', $frame['source_log'], 'file-mode frames label the source by basename( source_file )' );
	}

	public function test_file_mode_durable_frame_beats_a_build_time_next_offset_hint(): void {
		// Precedence must match Consumer: a durable checkpoint wins over an explicit build-time
		// next_offset('start') hint — else every respawn under idiomatic TSL re-reads the whole file.
		$path = "{$this->tmp}/debug.log";
		$off  = $this->seed_and_checkpoint( $path, "one\ntwo\n" ); // durable frame at offset 8.
		\file_put_contents( $path, "three\n", \FILE_APPEND );

		$t2 = $this->follow( $path, $off );
		$t2->next_offset( 'start' ); // The losing hint: 'start' would re-read one/two.
		$cap = new Capture_Sink_Node();
		$t2->sink( $cap );
		$this->pump( $t2 );
		$this->assertSame( [ "three\n" ], $this->values( $cap ), 'the durable checkpoint wins over the build-time next_offset hint' );
	}

	public function test_file_mode_explicit_array_seek_is_validated_like_a_durable_frame(): void {
		// An explicit {segment: inode, offset} seek routes through the SAME validity check as a
		// durable frame: a live inode + newline boundary seats the offset; a stale inode restarts at 0.
		$path  = "{$this->tmp}/debug.log";
		\file_put_contents( $path, "one\ntwo\n" ); // byte[3]="\n", so offset 4 is a valid boundary.
		$inode = (int) \stat( $path )['ino'];

		$live = $this->follow( $path );
		$live->next_offset( [ 'segment' => $inode, 'offset' => 4 ] );
		$cap_live = new Capture_Sink_Node();
		$live->sink( $cap_live );
		$this->pump( $live );
		$this->assertSame( [ "two\n" ], $this->values( $cap_live ), 'a live-inode seek at a newline boundary seats the offset' );

		$stale = $this->follow( $path );
		$stale->next_offset( [ 'segment' => $inode + 987654, 'offset' => 4 ] );
		$cap_stale = new Capture_Sink_Node();
		$stale->sink( $cap_stale );
		$this->pump( $stale );
		$this->assertSame( [ "one\n", "two\n" ], $this->values( $cap_stale ), 'a stale-inode seek restarts from offset 0' );
	}

	/** Read the newest committed offsetlog frame VALUE (the {segment,offset,...} struct) from $dir. */
	private function read_offsetlog_frame( string $dir ): array {
		$segments = \glob( "{$dir}/*.log" ) ?: [];
		\natsort( $segments );
		$last = [];
		foreach ( $segments as $file ) {
			foreach ( \explode( "\n", (string) \file_get_contents( $file ) ) as $line ) {
				if ( '' === $line ) {
					continue;
				}
				$value = Message::unpacked( $line )[ Message::VALUE ];
				if ( \is_array( $value ) ) {
					$last = $value;
				}
			}
		}
		return $last;
	}

	public function test_file_mode_resume_at_cursor_equal_size_reads_nothing_then_only_appended(): void {
		// cursor == size exactly (file ends on the last emitted newline): valid EOF, reads nothing.
		$path = "{$this->tmp}/debug.log";
		$off  = $this->seed_and_checkpoint( $path, "red\ngreen\n" ); // cursor lands at 10 == size.

		$t2  = $this->follow( $path, $off );
		$cap = new Capture_Sink_Node();
		$t2->sink( $cap );
		$this->pump( $t2 );
		$this->assertCount( 0, $cap->captured, 'cursor == size is a valid EOF and re-reads nothing' );

		\file_put_contents( $path, "blue\n", \FILE_APPEND );
		$this->pump( $t2 );
		$this->assertSame( [ "blue\n" ], $this->values( $cap ), 'only bytes appended after the resume emit' );
	}

	public function test_unknown_source_mode_throws_errors_as_docs(): void {
		$t = new Tail_Node();
		$this->expectException( \InvalidArgumentException::class );
		$this->expectExceptionMessageMatches( '/segmented.*file|file.*segmented/s' );
		$t->arguments( [ "{$this->tmp}/x.log", '', '', 'bogus' ] );
	}

	public function test_dump_config_round_trips_mode_and_path(): void {
		$path = "{$this->tmp}/debug.log";
		$t    = $this->follow( $path );
		$t->name( 'debugtail' );

		$dump = $t->dump_config();
		$this->assertStringContainsString( 'make_node Tail debugtail', $dump );
		$this->assertStringContainsString( $path, $dump );
		$this->assertStringContainsString( Tail_Node::MODE_FILE, $dump );

		// Replaying the serialized args reconstructs a file-mode Tail.
		$t2 = new Tail_Node();
		$t2->arguments( $t->arguments() );
		$ref = new \ReflectionObject( $t2 );
		$this->assertSame( Tail_Node::MODE_FILE, $ref->getProperty( 'source_mode' )->getValue( $t2 ) );
	}

	public function test_segmented_mode_is_the_default_when_mode_omitted(): void {
		$t = new Tail_Node();
		$t->arguments( [ "{$this->tmp}/data.log", "{$this->tmp}/off" ] );
		$ref = new \ReflectionObject( $t );
		$this->assertSame( Tail_Node::MODE_SEGMENTED, $ref->getProperty( 'source_mode' )->getValue( $t ) );
		$src = ( new \ReflectionClass( \Newspack_Nodes\Consumer_Node::class ) )->getProperty( 'source' )->getValue( $t );
		$this->assertInstanceOf( \Newspack_Nodes\Log_Node::class, $src, 'omitted mode keeps the segmented Log source' );
	}
}
