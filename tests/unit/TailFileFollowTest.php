<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use Newspack_Nodes\File_Tail_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tail_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

/**
 * `File_Tail_Node` — single-file follow (`tail -F` with logrotate semantics), the
 * sibling of segmented `Tail_Node`. Follows one filename across
 * rotation/truncation, tracking the generation identity by inode. Segmented
 * `{file}.{seg}` reading is exercised by TailTest.
 */
#[CoversClass( File_Tail_Node::class )]
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

	/** File_Tail following $path, with an optional offsetlog dir for durable-resume tests. */
	private function follow( string $path, string $offsetlog = '' ): File_Tail_Node {
		$t = new File_Tail_Node();
		$t->arguments( [ $path, $offsetlog ] );
		return $t;
	}

	/**
	 * Rule 1: `end` on a live log lands mid-line. That is not a resume point,
	 * so the partial is DISCARDED, not emitted as though it were a line — the
	 * tail syncs on the newline that completes it and buffers normally after.
	 */
	public function test_file_mode_end_mid_line_syncs_on_the_next_newline(): void {
		$path = "{$this->tmp}/midline.log";
		\file_put_contents( $path, "line-one\nline-two\npartial-no" );
		$t   = $this->follow( $path );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$t->next_offset( 'end' );
		$this->pump( $t );

		$this->assertSame( [], $this->values( $cap ), 'mid-line seat must emit nothing' );

		// The line completes and a whole one follows: only the WHOLE one ships.
		\file_put_contents( $path, "-newline\nline-four\n", \FILE_APPEND );
		$this->pump( $t );

		$this->assertSame( [ "line-four\n" ], $this->values( $cap ) );
	}

	/** Rule 1: the advertised id names the generation even when mid-line. */
	public function test_file_mode_end_advertises_the_generation_even_mid_line(): void {
		$path = "{$this->tmp}/midline-id.log";
		\file_put_contents( $path, "line-one\npartial" );
		$t = $this->follow( $path );
		$t->next_offset( 'end' );

		$this->assertSame(
			\fileinode( $path ) . ':' . \filesize( $path ),
			$t->cursor_position()
		);
	}

	/**
	 * Rule 2: a CORRECT inode with a mid-line offset syncs forward onto the
	 * next newline — the remainder of the split line is not a line.
	 */
	public function test_file_mode_correct_inode_mid_line_offset_syncs_forward(): void {
		$path = "{$this->tmp}/resume-mid.log";
		\file_put_contents( $path, "alpha\nbravo\ncharlie\n" );
		$t   = $this->follow( $path );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		// Offset 8 is inside "bravo\n" (which spans 6..11).
		$t->next_offset( [ 'segment' => \fileinode( $path ), 'offset' => 8 ] );
		$this->pump( $t );

		$this->assertSame( [ "charlie\n" ], $this->values( $cap ) );
	}

	/**
	 * Rule 3: a wrong, zero or absent generation reads the CURRENT file from
	 * the beginning — the offset belonged to something else.
	 */
	public function test_file_mode_foreign_generation_reads_from_the_beginning(): void {
		$path = "{$this->tmp}/foreign.log";
		\file_put_contents( $path, "alpha\nbravo\n" );

		foreach ( [ 999999999, 0, null ] as $inode ) {
			$t   = $this->follow( $path );
			$cap = new Capture_Sink_Node();
			$t->sink( $cap );
			$t->next_offset( [ 'segment' => $inode, 'offset' => 6 ] );
			$this->pump( $t );

			$this->assertSame(
				[ "alpha\n", "bravo\n" ],
				$this->values( $cap ),
				'generation ' . \var_export( $inode, true ) . ' must restart'
			);
		}
	}

	public function test_file_mode_seek_without_a_container_reads_from_the_beginning(): void {
		$path = "{$this->tmp}/resume.log";
		\file_put_contents( $path, "alpha-7788\nbeta-991122\n" );

		$cap = new Capture_Sink_Node();
		$t   = $this->follow( $path );
		$t->sink( $cap );
		// No 'segment' key names no generation, and an offset without one says
		// nothing about THIS file: read it whole rather than guess.
		$t->next_offset( [ 'offset' => 11 ] );
		$this->pump( $t );

		$this->assertSame(
			[ "alpha-7788\n", "beta-991122\n" ],
			$this->values( $cap )
		);
	}

	public function test_file_mode_idle_since_reports_when_the_followed_file_last_grew(): void {
		$path = "{$this->tmp}/quiet.log";
		\file_put_contents( $path, "one\n" );
		$stamp = \time() - 617;
		\touch( $path, $stamp );
		$cap = new Capture_Sink_Node();
		$t   = $this->follow( $path );
		$t->sink( $cap );
		$t->next_offset( 'start' );
		$this->pump( $t );

		$this->assertSame( (float) $stamp, $t->idle_since(), 'a caught-up file-mode Tail reports its own mtime' );
	}

	/**
	 * The seek a resume queues IS the position — `cursor_position()` says so —
	 * so the lag read must honour it too. Reading the raw cursor makes a Tail
	 * that resumed AT EOF look maximally behind, which reads as busy and hands
	 * SSE_Out a null idle seed: every resuming stream then holds a child for
	 * the whole idle window instead of closing on the first tick.
	 */
	public function test_file_mode_idle_since_honours_a_pending_resume_seek(): void {
		$path = "{$this->tmp}/resumed.log";
		\file_put_contents( $path, "alpha-7788\nbeta-991122\n" );
		$size  = \filesize( $path );
		$stamp = \time() - 617;
		\touch( $path, $stamp );
		$t = $this->follow( $path );
		// Resume at EOF before any poll: the seek is queued, not yet applied.
		$t->next_offset( [ 'segment' => \fileinode( $path ), 'offset' => $size ] );

		$this->assertSame(
			(float) $stamp,
			$t->idle_since(),
			'a Tail resuming at EOF is caught up, however the seek is queued'
		);
	}

	/**
	 * A queued seek is a CANDIDATE — `validate_resume_offset()` still rejects one
	 * naming a dead generation. Trusting it for the lag read lets a client echo a
	 * pre-rotation position and have the new, smaller generation declared caught
	 * up: SSE_Out then closes on the first tick and those bytes never ship.
	 */
	public function test_file_mode_idle_since_distrusts_a_seek_from_a_dead_generation(): void {
		$path = "{$this->tmp}/rotated.log";
		\file_put_contents( $path, "fresh-generation-4471\n" );
		\touch( $path, \time() - 617 );
		$t = $this->follow( $path );
		// Pre-rotation position: another inode, far past this file's end.
		$t->next_offset( [ 'segment' => \fileinode( $path ) + 1, 'offset' => 500000 ] );

		$this->assertNull(
			$t->idle_since(),
			'a resume naming a dead generation must not read as caught up'
		);
	}

	public function test_file_mode_idle_since_distrusts_a_seek_past_the_end(): void {
		$path = "{$this->tmp}/truncated.log";
		\file_put_contents( $path, "after-truncate-8823\n" );
		\touch( $path, \time() - 617 );
		$t = $this->follow( $path );
		$t->next_offset( [ 'segment' => \fileinode( $path ), 'offset' => 500000 ] );

		$this->assertNull(
			$t->idle_since(),
			'an offset past the end means the file shrank; unread bytes remain'
		);
	}

	public function test_file_mode_idle_since_is_null_while_bytes_are_still_owed(): void {
		$path = "{$this->tmp}/owed.log";
		\file_put_contents( $path, "one\ntwo\n" );
		\touch( $path, \time() - 617 );
		$t = $this->follow( $path );
		$t->next_offset( 'start' );

		$this->assertNull( $t->idle_since(), 'unread bytes must never read as idle, however stale the mtime' );
	}

	public function test_file_mode_stamps_the_inode_offset_length_breadcrumb(): void {
		// The seek tracker's Replay->Live flip reads Message::ID; a minted line
		// must carry inode:offset:length (the empty default breaks the flip).
		$path = "{$this->tmp}/debug.log";
		\file_put_contents( $path, "alpha-7788\nbeta-991122\n" );
		$inode = \fileinode( $path );

		$cap = new Capture_Sink_Node();
		$t   = $this->follow( $path );
		$t->sink( $cap );
		$t->next_offset( 'start' );
		$this->pump( $t );

		$this->assertCount( 2, $cap->captured );
		$this->assertSame( "{$inode}:0:11", $cap->captured[0][ Message::ID ] );
		$this->assertSame( "{$inode}:11:12", $cap->captured[1][ Message::ID ] );
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

	/**
	 * A same-inode cursor whose preceding byte is not a newline is a MID-LINE
	 * offset, and syncs forward like any other — so a copytruncate that regrows
	 * past the old cursor skips to the next newline instead of replaying.
	 */
	public function test_file_mode_resume_same_inode_mid_line_syncs_forward(): void {
		$path = "{$this->tmp}/debug.log";
		$off  = $this->seed_and_checkpoint( $path, "one\ntwo\n" ); // cursor 8, byte[7]="\n".

		// Truncate + rewrite IN PLACE (same inode): 12 bytes >= cursor 8, but byte[7]='A'.
		\file_put_contents( $path, "AAAAAAAAAAA\n" );

		$t2  = $this->follow( $path, $off );
		$cap = new Capture_Sink_Node();
		$t2->sink( $cap );
		$this->pump( $t2 );

		// Resumes at 8, syncs past the newline at 11, and finds nothing after.
		$this->assertSame( [], $this->values( $cap ) );
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

	public function test_dump_config_round_trips_the_followed_path(): void {
		$path = "{$this->tmp}/debug.log";
		$t    = $this->follow( $path );
		$t->name( 'debugtail' );

		$dump = $t->dump_config();
		$this->assertStringContainsString( 'make_node File_Tail debugtail', $dump );
		$this->assertStringContainsString( $path, $dump );

		// Replaying the serialized args reconstructs the same follower.
		$t2 = new File_Tail_Node();
		$t2->arguments( $t->arguments() );
		$this->assertSame( $path, $t2->arguments()[0] );
	}

	/**
	 * The two source shapes are two CLASSES, not one class with a mode flag —
	 * so a File_Tail owns no source Partition and says so by name. The parent's
	 * bare "not initialized" sent a reader hunting for a missing arguments()
	 * call; worse, nothing enforced the invariant at all, so the next
	 * Consumer_Node method to read source() would have fataled in a worker.
	 */
	public function test_a_file_follower_has_no_source_partition_and_refuses_by_name(): void {
		$t = $this->follow( "{$this->tmp}/debug.log" );

		$source = ( new \ReflectionClass( \Newspack_Nodes\Consumer_Node::class ) )
			->getProperty( 'source' )->getValue( $t );
		$this->assertNull( $source, 'a single inode is not a segment list' );

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessageMatches( '/File_Tail.*no source Partition/' );
		( new \ReflectionMethod( $t, 'source' ) )->invoke( $t );
	}

	public function test_the_segmented_sibling_keeps_its_log_source(): void {
		$t = new Tail_Node();
		$t->arguments( [ "{$this->tmp}/data.log", "{$this->tmp}/off" ] );
		$src = ( new \ReflectionClass( \Newspack_Nodes\Consumer_Node::class ) )->getProperty( 'source' )->getValue( $t );
		$this->assertInstanceOf( \Newspack_Nodes\Log_Node::class, $src, 'segmented Tail reads a Log' );
	}

	public function test_file_mode_GET_LAG_reports_bytes_behind_from_live_file_size(): void {
		// File mode has no segmented source, so it answers GET_LAG from the live
		// file size here instead of deferring to Consumer. next_offset('start')
		// leaves the whole file unread, so every byte is behind.
		$path = "{$this->tmp}/debug.log";
		\file_put_contents( $path, "eleven-byte\n" ); // 12 bytes, distinct from any default.

		$t = $this->follow( $path );
		$t->next_offset( 'start' );
		$t->name( 'debugtail' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'lag-asker';
		$req[ Message::ID ]    = 'req-77';
		$req[ Message::KEY ]   = 'kk';
		$req[ Message::VALUE ] = 'GET_LAG';
		$t->fill( $req );

		$this->assertCount( 1, $cap->captured, 'a GET_LAG request yields exactly one reply' );
		$reply = $cap->captured[0];
		$this->assertSame( Message::TM_STRUCT | Message::TM_RESPONSE, $reply[ Message::TYPE ] );
		$this->assertSame( 'debugtail', $reply[ Message::FROM ], 'reply FROM is the Tail name' );
		$this->assertSame( 'lag-asker', $reply[ Message::TO ], 'reply TO walks the breadcrumb back' );
		$this->assertSame( 'req-77', $reply[ Message::ID ] );
		$this->assertSame( 'kk', $reply[ Message::KEY ] );
		$this->assertSame( 'GET_LAG', $reply[ Message::VALUE ]['verb'] );
		$data = $reply[ Message::VALUE ]['data'];
		$this->assertSame( 12, $data['bytes_behind'], 'the whole unread file is behind' );
		$this->assertSame( 0, $data['segments_behind'], 'a single file has no segment backlog' );
		$this->assertFalse( $data['caught_up'] );
		$this->assertSame( 12, $data['end_size'] );
		$this->assertSame( 12, $data['end_bytes'] );
	}

	public function test_file_mode_GET_LAG_reports_caught_up_after_draining(): void {
		$path = "{$this->tmp}/debug.log";
		\file_put_contents( $path, "seven-7\n" ); // 8 bytes.

		$t = $this->follow( $path );
		$t->next_offset( 'start' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$this->pump( $t ); // Drain to EOF so nothing is behind.

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';
		$t->fill( $req );

		$reply = \end( $cap->captured );
		$data  = $reply[ Message::VALUE ]['data'];
		$this->assertSame( 0, $data['bytes_behind'] );
		$this->assertTrue( $data['caught_up'], 'a fully-drained file reports caught_up' );
	}

	public function test_file_mode_unknown_request_verb_replies_with_error_payload(): void {
		$path = "{$this->tmp}/debug.log";
		\file_put_contents( $path, "x\n" );

		$t = $this->follow( $path );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'FROBNICATE now';
		$t->fill( $req );

		$this->assertCount( 1, $cap->captured );
		$data = $cap->captured[0][ Message::VALUE ]['data'];
		$this->assertSame( 'unknown request verb: FROBNICATE', $data['error'], 'only the first token is the verb, upper-cased' );
	}

	public function test_file_mode_request_without_a_sink_throws(): void {
		$path = "{$this->tmp}/debug.log";
		\file_put_contents( $path, "x\n" );

		$t = $this->follow( $path ); // No sink wired.

		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = 'GET_LAG';

		$this->expectException( \RuntimeException::class );
		$this->expectExceptionMessage( 'fill requires a wired sink' );
		$t->fill( $req );
	}

	public function test_file_mode_non_request_message_passes_through_to_the_sink(): void {
		// A non-TM_REQUEST message in file mode delegates to the parent producer
		// fill, which forwards to the sink — the interpreter/routing path.
		$path = "{$this->tmp}/debug.log";
		\file_put_contents( $path, "x\n" );

		$t = $this->follow( $path );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::VALUE ] = 'passthrough-payload';
		$t->fill( $msg );

		$this->assertCount( 1, $cap->captured );
		$this->assertSame( 'passthrough-payload', $cap->captured[0][ Message::VALUE ] );
	}

	public function test_file_mode_probe_stats_reports_file_size_and_basenames(): void {
		$path = "{$this->tmp}/debug.log";
		$off  = "{$this->tmp}/off";
		\file_put_contents( $path, "one\ntwo\n" ); // 8 bytes.

		$t = $this->follow( $path, $off );
		$t->next_offset( 'start' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$this->pump( $t );

		$stats = $t->probe_stats();
		$this->assertSame( 'debug.log', $stats[ \Newspack_Nodes\Probe_Record::SOURCE ], 'source is the followed filename basename' );
		$this->assertSame( 'off', $stats[ \Newspack_Nodes\Probe_Record::READER ], 'reader is the offsetlog dir basename' );
		$this->assertSame( 8, $stats[ \Newspack_Nodes\Probe_Record::END_SIZE ], 'end size is the live file size' );
		$this->assertSame( 8, $stats[ \Newspack_Nodes\Probe_Record::END_BYTES ] );
		$this->assertSame( 0, $stats[ \Newspack_Nodes\Probe_Record::DISTANCE ], 'a fully-read file has no distance' );
		$this->assertSame( 0, $stats[ \Newspack_Nodes\Probe_Record::CACHE_SIZE ] );
	}

	public function test_file_mode_probe_stats_blank_source_and_reader_when_unset(): void {
		// No offsetlog dir and a missing path: both basenames collapse to ''.
		$t = $this->follow( "{$this->tmp}/never-created.log" ); // offsetlog '' by default.
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );

		$stats = $t->probe_stats();
		$this->assertSame( '', $stats[ \Newspack_Nodes\Probe_Record::READER ], 'no offsetlog dir means a blank reader' );
		$this->assertSame( 0, $stats[ \Newspack_Nodes\Probe_Record::END_SIZE ], 'a missing file has size 0' );
	}

	public function test_file_mode_remove_node_closes_the_follow_handle(): void {
		$path = "{$this->tmp}/debug.log";
		\file_put_contents( $path, "held-open\n" );

		$t = $this->follow( $path );
		$t->next_offset( 'start' );
		$cap = new Capture_Sink_Node();
		$t->sink( $cap );
		$this->pump( $t ); // First poll opens the follow handle (no I/O at construction, ADR-5).
		$ref    = new \ReflectionObject( $t );
		$handle = $ref->getProperty( 'follow_handle' );
		$this->assertIsResource( $handle->getValue( $t ), 'a polled file-mode Tail holds an open follow handle' );

		$t->remove_node();
		$this->assertNull( $handle->getValue( $t ), 'remove_node closes and clears the follow handle' );
	}
}
