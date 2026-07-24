<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

/**
 * Time-travel transport verbs on Consumer_Node: SEEK_FRAME, PAUSE, STEP, PLAY.
 * These back a debugger UI that pauses a consumer, seeks it to an offsetlog
 * checkpoint (restoring the co-committed snapshot), and single-steps it
 * message-by-message. The READ surface (frame list + cursor) moved off bespoke
 * verbs into Consumer_Node::dump_metadata().
 */
#[CoversClass( Consumer_Node::class )]
class ConsumerTimeTravelTest extends TestCase {
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

	/**
	 * Fire a TM_REQUEST verb at the Consumer and return the reply's data payload.
	 * STEP also emits the stepped data line, so the reply is whatever lands LAST.
	 */
	private function request( Consumer_Node $c, Capture_Sink_Node $cap, string $verb ): mixed {
		$req                   = Message::new_message();
		$req[ Message::TYPE ]  = Message::TM_REQUEST;
		$req[ Message::FROM ]  = 'asker';
		$req[ Message::VALUE ] = $verb;
		$c->fill( $req );
		$reply = $cap->captured[ \count( $cap->captured ) - 1 ];
		$this->assertSame( $verb, $reply[ Message::VALUE ]['verb'], 'reply must be the verb response' );
		return $reply[ Message::VALUE ]['data'];
	}

	/** Drive a checkpoint at the given cursor by setting it then committing. */
	private function checkpoint_at( Consumer_Node $c, int $segment, int $offset ): void {
		$c->next_offset( [ 'segment' => $segment, 'offset' => $offset ] );
		Core::$now = Core::$now + 1.0;
		$c->checkpoint();
	}

	// ============================================================================
	// dump_metadata: the consolidated time-travel READ surface (frames + cursor)
	// ============================================================================

	public function test_dump_metadata_returns_frames_and_cursor(): void {
		// One checkpoint = one offsetlog segment; the keyframe list is the segment
		// list (id + size) and the cursor is the live source position.
		Core::$now = 1000.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );

		$this->checkpoint_at( $c, 0, 10 );
		$this->checkpoint_at( $c, 0, 20 );
		$this->checkpoint_at( $c, 1, 5 );

		$extra = $c->dump_metadata();

		$offsetlog = $this->read_private( $c, 'offsetlog' );
		$this->assertSame( $offsetlog->get_segments(), $extra['frames'], 'frames are the offsetlog segment list (id+size)' );
		$this->assertSame( [ 'segment' => 1, 'offset' => 5 ], $extra['cursor'], 'cursor is the live source position' );
	}

	public function test_dump_metadata_reports_at_frame_and_on_frame_across_the_transport_lifecycle(): void {
		// The cursor's POSITION is a single pair describing where it sits relative to
		// the offsetlog keyframes — used for BOTH live status and time-travel, and
		// reported so the panel survives a remount. `at_frame` = rewound_to when
		// seeked, else the newest offsetlog frame id (the cursor's current
		// checkpoint); `on_frame` = the cursor is exactly on that frame's committed
		// position vs advanced past it.
		Core::$now = 2000.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );

		$this->checkpoint_at( $c, 0, 10 );
		$older = $this->newest_segment_id( $c );
		$this->checkpoint_at( $c, 0, 20 );
		$newer = $this->newest_segment_id( $c );

		// Live + quiet: checkpoint_at left cursor == checkpoint, so the cursor sits ON
		// its last checkpoint — at_frame is the NEWEST frame, on_frame is true.
		$meta = $c->dump_metadata();
		$this->assertSame( $newer, $meta['at_frame'], 'a live consumer reports the newest offsetlog frame' );
		$this->assertTrue( $meta['on_frame'], 'a quiet live consumer (cursor == checkpoint) sits ON its last checkpoint' );

		// Live + read-ahead: advance the cursor past the committed checkpoint without
		// re-checkpointing — the cursor has read forward, so on_frame is false.
		$c->next_offset( [ 'segment' => 0, 'offset' => 99 ] );
		$meta = $c->dump_metadata();
		$this->assertSame( $newer, $meta['at_frame'], 'still the newest frame while live' );
		$this->assertFalse( $meta['on_frame'], 'a live consumer that read past its checkpoint is no longer on the frame' );

		// Rewound to the older frame: at_frame is that segment id, on_frame is true.
		$c->pause();
		$c->seek_frame( $older );
		$meta = $c->dump_metadata();
		$this->assertSame( $older, $meta['at_frame'], 'a seek puts the cursor at the seeked offsetlog segment id' );
		$this->assertTrue( $meta['on_frame'], 'a fresh seek sits ON the keyframe' );

		// A STEP past the seeked frame: at_frame unchanged, on_frame flips false.
		$c->step();
		$meta = $c->dump_metadata();
		$this->assertSame( $older, $meta['at_frame'], 'at_frame survives a step' );
		$this->assertFalse( $meta['on_frame'], 'stepping past the seeked frame is no longer on it' );

		// A second seek (a fresh park) puts on_frame back to true and re-parks.
		$c->seek_frame( $newer );
		$meta = $c->dump_metadata();
		$this->assertSame( $newer, $meta['at_frame'], 'a re-seek puts the cursor at the new segment id' );
		$this->assertTrue( $meta['on_frame'], 'a re-seek sits ON the new keyframe' );

		// PLAY (go live): at_frame back to the newest, on_frame per the cursor.
		// seek_frame($newer) put the cursor on the newest keyframe's committed source
		// position, which equals the last checkpoint — so the live cursor reads as ON.
		$c->play();
		$meta = $c->dump_metadata();
		$this->assertSame( $newer, $meta['at_frame'], 'PLAY reports the newest frame (live)' );
		$this->assertTrue( $meta['on_frame'], 'cursor sits on the newest checkpoint after seek(newest)+play' );

		// Live read-ahead after PLAY: advance the cursor past the checkpoint; on_frame
		// flips false, mirroring the live read-ahead case above.
		$c->next_offset( [ 'segment' => 1, 'offset' => 7 ] );
		$meta = $c->dump_metadata();
		$this->assertSame( $newer, $meta['at_frame'], 'still the newest frame while live' );
		$this->assertFalse( $meta['on_frame'], 'a live consumer reading ahead after PLAY is off the frame' );
	}

	public function test_dump_metadata_at_frame_is_null_when_no_frames(): void {
		// No checkpoints yet: there is no offsetlog frame to be at, so at_frame is null
		// and the cursor can't be on a (nonexistent) frame.
		Core::$now = 2100.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );

		$meta = $c->dump_metadata();
		$this->assertNull( $meta['at_frame'], 'no frames yet → at_frame null' );
		$this->assertFalse( $meta['on_frame'], 'no checkpoint to sit on → on_frame false' );
	}

	public function test_dump_metadata_empty_frames_when_no_offsetlog(): void {
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0" ] );
		$c->sink( new Capture_Sink_Node() );

		$extra = $c->dump_metadata();
		$this->assertSame( [], $extra['frames'], 'ephemeral consumer (no offsetlog) has no frames' );
		$this->assertSame( [ 'segment' => 0, 'offset' => 0 ], $extra['cursor'] );
	}

	public function test_dump_metadata_reads_only_the_warm_cache(): void {
		// Cheap: dump_metadata must read the warm segments_cache, never
		// rescan the directory. Warm the cache, then add a segment file on disk by
		// hand — the extra must still report the cached (stale) list, proving it
		// did NOT scandir on the poll path.
		Core::$now = 1500.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );

		$this->checkpoint_at( $c, 0, 10 );

		$offsetlog = $this->read_private( $c, 'offsetlog' );
		$warm      = $offsetlog->get_segments(); // warm the cache.
		$this->assertCount( 1, $warm );

		// A new segment lands on disk; only a rescan (scandir) would see it.
		$dir = "{$this->tmp}/offsets/r/p0";
		\file_put_contents( "{$dir}/99.log", $this->offset_record( 9, 99, 999 ) );

		$extra = $c->dump_metadata();
		$this->assertSame( $warm, $extra['frames'], 'frames come from the warm cache — no scandir on the poll path' );
	}

	public function test_offsetlog_is_one_segment_per_checkpoint_keyframe(): void {
		// The offsetlog is tuned (segment_size=1) so each commit = one segment =
		// one keyframe: do_rotate() adopts the still-empty newest segment on the
		// first commit, then rotates to a fresh segment on every commit after.
		Core::$now = 7000.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$offsetlog = $this->read_private( $c, 'offsetlog' );

		$this->checkpoint_at( $c, 0, 10 );
		$this->assertCount( 1, $offsetlog->get_segments( true ), 'first checkpoint = one segment' );

		$this->checkpoint_at( $c, 0, 20 );
		$this->assertCount( 2, $offsetlog->get_segments( true ), 'second checkpoint = a fresh segment' );

		$this->checkpoint_at( $c, 0, 30 );
		$this->assertCount( 3, $offsetlog->get_segments( true ), 'each checkpoint adds exactly one segment' );
	}

	/**
	 * Age every offsetlog segment on disk. Retention reads the real clock
	 * (filemtime vs time()), NOT Core::$now — freshly written segments are age 0,
	 * so a test that doesn't backdate them can never observe a prune.
	 */
	private function age_offsetlog_segments( Partition_Node $offsetlog, int $seconds ): void {
		foreach ( \glob( "{$this->tmp}/offsets/r/p0/*.log" ) as $path ) {
			\touch( $path, \time() - $seconds );
		}
		$offsetlog->get_segments( true );
		$offsetlog->cleanup_segments();
	}

	public function test_offsetlog_count_rule_prunes_back_to_max_segments(): void {
		// Over max_segments AND past min_lifetime: the count rule prunes the oldest
		// back to max_segments. One keyframe = one offsetlog segment.
		Core::$now = 8000.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );

		$total = Consumer_Node::OFFSETLOG_MAX_SEGMENTS + 5;
		for ( $i = 1; $i <= $total; $i++ ) {
			$this->checkpoint_at( $c, 0, $i * 10 );
		}
		$offsetlog = $this->read_private( $c, 'offsetlog' );
		$this->assertCount( $total, $offsetlog->get_segments( true ), 'nothing is younger than min_lifetime yet' );

		// Older than min_lifetime (300s), younger than max_lifetime (900s).
		$this->age_offsetlog_segments( $offsetlog, 400 );

		$this->assertCount(
			Consumer_Node::OFFSETLOG_MAX_SEGMENTS,
			$offsetlog->get_segments( true ),
			'count rule prunes to exactly max_segments keyframes'
		);
	}

	public function test_offsetlog_age_rule_prunes_down_to_min_segments(): void {
		// Under max_segments, so only the age rule can fire: segments older than
		// max_lifetime are pruned down to the min_segments floor.
		Core::$now = 8000.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );

		$total = Consumer_Node::OFFSETLOG_MIN_SEGMENTS + 5;
		for ( $i = 1; $i <= $total; $i++ ) {
			$this->checkpoint_at( $c, 0, $i * 10 );
		}
		$offsetlog = $this->read_private( $c, 'offsetlog' );

		// Older than max_lifetime (900s).
		$this->age_offsetlog_segments( $offsetlog, 1000 );

		$this->assertCount(
			Consumer_Node::OFFSETLOG_MIN_SEGMENTS,
			$offsetlog->get_segments( true ),
			'age rule prunes down to the min_segments floor, no further'
		);
	}

	public function test_load_offsetlog_resumes_from_newest_keyframe_after_pruning(): void {
		// Crash-resume still seeds the cursor from the newest retained frame even
		// after older keyframes are pruned (load_offsetlog reads the newest segment).
		Core::$now = 8500.0;
		$c1 = new Consumer_Node();
		$c1->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c1->name( 'firehose:consumer' );
		$c1->sink( new Capture_Sink_Node() );

		$total = Consumer_Node::OFFSETLOG_MAX_SEGMENTS + 5;
		for ( $i = 1; $i <= $total; $i++ ) {
			$this->checkpoint_at( $c1, 2, $i * 100 );
		}
		// Age them past min_lifetime so the count rule actually drops the oldest.
		$offsetlog = $this->read_private( $c1, 'offsetlog' );
		$this->age_offsetlog_segments( $offsetlog, 400 );
		$this->assertCount( Consumer_Node::OFFSETLOG_MAX_SEGMENTS, $offsetlog->get_segments( true ) );

		// Old worker process dies; the offsetlog files persist on disk.
		Core::reset();

		// New worker: poll_init → load_offsetlog seeds from the newest frame (2:$total*100).
		$c2 = new Consumer_Node();
		$c2->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c2->name( 'firehose:consumer' );
		$c2->sink( new Capture_Sink_Node() );
		$c2->poll();

		$this->assertTrue( $c2->has_checkpoint() );
		$this->assertSame( 2, $this->read_private( $c2, 'cursor_segment' ) );
		$this->assertSame( $total * 100, $this->read_private( $c2, 'cursor_offset' ), 'resumes from the newest retained keyframe' );
	}

	// ============================================================================
	// SEEK_FRAME (now keyed by offsetlog segment id, from dump_metadata frames[].id)
	// ============================================================================

	public function test_seek_frame_restores_state_and_moves_cursor(): void {
		// Commit a frame carrying a snapshot cache, advance the cursor + mutate the
		// node, then SEEK_FRAME to that offsetlog segment id: restore_state must get
		// the frame's cache and the cursor must move to the record's source {seg,off}.
		Core::$now = 3000.0;
		$node      = new TimeTravel_Snapshot_Probe();
		$node->name( 'request-builder' );
		$node->state = [ 'in_flight' => [ 'r1' => 1 ] ];

		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$c->add_snapshot_node( 'request-builder' );

		$this->checkpoint_at( $c, 2, 64 );
		$frame_cache = $node->state;
		// The committed keyframe is the newest offsetlog segment.
		$segment_id  = $this->newest_segment_id( $c );

		// Drift the node + cursor away from the committed frame.
		$node->state = [ 'in_flight' => [ 'r9' => 9 ] ];
		$c->next_offset( [ 'segment' => 5, 'offset' => 999 ] );

		$result = $c->seek_frame( $segment_id );
		$this->assertSame( 'ok', $result );
		$this->assertSame( $frame_cache, $node->restored, 'restore_state got the frame cache' );

		$this->assertSame( 2, $this->read_private( $c, 'cursor_segment' ), 'cursor moved to the record source seg' );
		$this->assertSame( 64, $this->read_private( $c, 'cursor_offset' ), 'cursor moved to the record source off' );
	}

	public function test_seek_frame_does_not_rearm_timer(): void {
		// A paused consumer stays paused after seeking.
		Core::$now = 3100.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$this->checkpoint_at( $c, 0, 30 );
		$segment_id = $this->newest_segment_id( $c );

		$c->pause();
		$c->seek_frame( $segment_id );

		$this->assertFalse( $this->timer_armed( $c ), 'seek must not re-arm the poll timer' );
	}

	public function test_seek_frame_returns_error_when_segment_absent(): void {
		Core::$now = 3200.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$this->checkpoint_at( $c, 0, 10 );

		$result = $c->seek_frame( 9999 );
		$this->assertStringContainsString( 'no frame', $result );
	}

	public function test_seek_frame_returns_error_when_no_offsetlog(): void {
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0" ] );
		$c->sink( new Capture_Sink_Node() );
		$result = $c->seek_frame( 0 );
		$this->assertStringContainsString( 'offsetlog', $result );
	}

	// ============================================================================
	// PAUSE
	// ============================================================================

	public function test_pause_stops_the_timer(): void {
		Core::$now = 4000.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		// arguments() armed an EOF timer; confirm it is active before pausing.
		$this->assertTrue( $this->timer_armed( $c ), 'precondition: timer armed by arguments()' );

		$c->pause();
		$this->assertFalse( $this->timer_armed( $c ), 'pause must stop the poll timer' );
	}

	// ============================================================================
	// STEP
	// ============================================================================

	public function test_step_emits_exactly_one_message_and_advances_cursor(): void {
		$source = new Partition_Node();
		$source->arguments( [ "{$this->tmp}/data/p0", (string) ( 64 * 1024 ), "4", "86400" ] );
		$this->produce_line( $source, 'a' );
		$this->produce_line( $source, 'b' );
		$this->produce_line( $source, 'c' );

		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		// poll_init loads the buffer on the first tick but emits nothing in line
		// mode; STEP must keep stepping until it has emitted one message.
		$c->step();
		$this->assertCount( 1, $cap->captured, 'STEP emits exactly one message' );
		$this->assertSame( 'a', $cap->captured[0][ Message::VALUE ] );

		$c->step();
		$this->assertCount( 2, $cap->captured );
		$this->assertSame( 'b', $cap->captured[1][ Message::VALUE ] );
	}

	public function test_step_forces_line_mode_for_the_step(): void {
		$source = new Partition_Node();
		$source->arguments( [ "{$this->tmp}/data/p0", (string) ( 64 * 1024 ), "4", "86400" ] );
		$this->produce_line( $source, 'a' );
		$this->produce_line( $source, 'b' );

		// Consumer NOT in line mode — a normal poll would drain both at once.
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$c->step();
		$this->assertCount( 1, $cap->captured, 'STEP forces one-line granularity even when line_mode is off' );
		$this->assertTrue( $this->read_private( $c, 'line_mode' ), 'STEP turns line_mode on for the session' );
	}

	public function test_step_implies_pause(): void {
		// STEP must stop the poll timer so the self-rearming fire() loop can't
		// interleave full-batch polls between steps (which would leap the cursor
		// past messages) or leave an abandoned session stuck in line_mode.
		Core::$now = 4500.0;
		$source    = new Partition_Node();
		$source->arguments( [ "{$this->tmp}/data/p0", (string) ( 64 * 1024 ), "4", "86400" ] );
		$this->produce_line( $source, 'a' );

		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		// arguments() armed an EOF timer; STEP must stop it.
		$this->assertTrue( $this->timer_armed( $c ), 'precondition: timer armed by arguments()' );

		$c->step();
		$this->assertFalse( $this->timer_armed( $c ), 'STEP leaves the consumer paused' );
	}

	public function test_step_sets_the_polling_signal_to_paused(): void {
		// STEP stops the timer (it IS paused), so its dump_metadata polling signal
		// must read PAUSED — consistent with pause() — not stay stale at ACTIVE.
		$source = new Partition_Node();
		$source->arguments( [ "{$this->tmp}/data/p0", (string) ( 64 * 1024 ), "4", "86400" ] );
		$this->produce_line( $source, 'a' );

		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		// arguments() set the signal ACTIVE; STEP must flip it to PAUSED.
		$this->assertSame( 'ACTIVE', $c->dump_metadata()['polling'], 'precondition: arguments() set ACTIVE' );

		$c->step();
		$this->assertSame( 'PAUSED', $c->dump_metadata()['polling'], 'STEP leaves the polling signal PAUSED' );
	}

	public function test_step_command_returns_cursor_and_eof_json(): void {
		// STEP is a COMMAND (it mutates: emits + advances the durable cursor), so
		// it dispatches through the auth-gated {name}:config interpreter. Its reply
		// is the {seg,off,at_eof} array as a JSON string for the UI to parse.
		$source = new Partition_Node();
		$source->arguments( [ "{$this->tmp}/data/p0", (string) ( 64 * 1024 ), "4", "86400" ] );
		$this->produce_line( $source, 'only' );

		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$reply = $this->dispatch_command( $c, 'STEP' );
		$data  = \json_decode( $reply, true );
		$this->assertSame( 0, $data['segment'] );
		$this->assertGreaterThan( 0, $data['offset'], 'cursor advanced past the emitted line' );
		$this->assertFalse( $data['at_eof'] );
		// The stepped data line was emitted to the same sink.
		$values = \array_map( static fn ( $m ) => $m[ Message::VALUE ], $cap->captured );
		$this->assertContains( 'only', $values, 'STEP emitted exactly the one data line' );
	}

	public function test_unauthorized_step_command_is_refused_and_does_not_emit_or_advance(): void {
		// The property that was untestable while STEP was a TM_REQUEST (which
		// bypasses interpret()'s auth gate): an unsigned, non-LOCAL STEP command is
		// refused, emits no data message, and does NOT advance the cursor.
		$source = new Partition_Node();
		$source->arguments( [ "{$this->tmp}/data/p0", (string) ( 64 * 1024 ), "4", "86400" ] );
		$this->produce_line( $source, 'guarded' );

		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$data_cap = new Capture_Sink_Node();
		$c->sink( $data_cap );

		$cursor_before = $this->read_private( $c, 'cursor_offset' );

		$interpreter = $this->read_private( $c, 'interpreter' );
		$reply_cap   = new Capture_Sink_Node();
		$interpreter->sink( $reply_cap );

		$cmd                   = Message::new_message();
		$cmd[ Message::TYPE ]  = Message::TM_COMMAND;
		$cmd[ Message::FROM ]  = 'attacker';
		$cmd[ Message::TO ]    = '';
		$cmd[ Message::VALUE ] = [ 'name' => 'STEP', 'arguments' => '' ];
		// NOTE: no Message::LOCAL taint and no HMAC — the default authorize gate
		// must refuse it.
		$interpreter->fill( $cmd );

		$reply = $reply_cap->captured[0];
		$this->assertSame(
			Message::TM_COMMAND | Message::TM_ERROR,
			$reply[ Message::TYPE ],
			'unauthorized command must reply TM_COMMAND|TM_ERROR'
		);
		$this->assertStringContainsString( 'unauthorized', $reply[ Message::VALUE ]['payload'] );
		$this->assertCount( 0, $data_cap->captured, 'refused STEP must emit no data message' );
		$this->assertSame( $cursor_before, $this->read_private( $c, 'cursor_offset' ), 'refused STEP must not advance the cursor' );
	}

	public function test_step_at_eof_is_a_noop(): void {
		// Empty source: STEP emits nothing and surfaces at_eof.
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$data = $c->step();
		$this->assertCount( 0, $cap->captured, 'no data message at EOF' );
		$this->assertTrue( $data['at_eof'] );
	}

	// ============================================================================
	// PLAY
	// ============================================================================

	public function test_play_restores_prior_line_mode_true_and_rearms_timer(): void {
		// Consumer legitimately runs line_mode=true; STEP→PLAY must leave it true.
		$source = new Partition_Node();
		$source->arguments( [ "{$this->tmp}/data/p0", (string) ( 64 * 1024 ), "4", "86400" ] );
		$this->produce_line( $source, 'a' );

		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->set_line_mode( true );
		$c->sink( new Capture_Sink_Node() );

		Core::$now = 5000.0;
		$c->pause();
		$c->step();
		$c->play();

		$this->assertTrue( $this->read_private( $c, 'line_mode' ), 'PLAY restores the prior line_mode=true' );
		$this->assertTrue( $this->timer_armed( $c ), 'PLAY re-arms the poll timer' );
	}

	public function test_play_restores_prior_line_mode_false(): void {
		// Consumer runs line_mode=false; STEP forces it true, PLAY restores false.
		$source = new Partition_Node();
		$source->arguments( [ "{$this->tmp}/data/p0", (string) ( 64 * 1024 ), "4", "86400" ] );
		$this->produce_line( $source, 'a' );

		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );

		Core::$now = 5100.0;
		$c->pause();
		$c->step();
		$this->assertTrue( $this->read_private( $c, 'line_mode' ), 'STEP forced line_mode true' );
		$c->play();

		$this->assertFalse( $this->read_private( $c, 'line_mode' ), 'PLAY restores the prior line_mode=false' );
	}

	public function test_play_rearms_with_busy_interval(): void {
		Core::$now = 5200.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$c->pause();
		$c->play();

		$timers = $this->read_private( Event_Framework::instance(), 'timers' );
		$id     = \spl_object_id( $c );
		$this->assertArrayHasKey( $id, $timers );
		$this->assertSame( Consumer_Node::POLL_INTERVAL_BUSY_MS, $timers[ $id ]->interval_ms );
		$this->assertTrue( $timers[ $id ]->oneshot );
	}

	// ============================================================================
	// PLAY truncate-on-resume: a rewound consumer truncates the offsetlog after the
	// rewind point on PLAY (the "commit to this branch" moment), so the re-written
	// forward timeline stays monotonic. Paused seeking stays non-destructive.
	// ============================================================================

	public function test_seek_frame_records_the_rewind_point(): void {
		Core::$now = 9000.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );

		// Two keyframes; seek to the older one.
		$this->checkpoint_at( $c, 0, 10 );
		$older = $this->newest_segment_id( $c );
		$this->checkpoint_at( $c, 0, 20 );

		$this->assertNull( $this->read_private( $c, 'rewound_to' ), 'no rewind recorded before a seek' );
		$this->assertSame( 'ok', $c->seek_frame( $older ) );
		$this->assertSame( $older, $this->read_private( $c, 'rewound_to' ), 'a successful seek records the rewind point' );
	}

	public function test_play_after_seek_truncates_offsetlog_after_rewind_point(): void {
		Core::$now = 9100.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );

		// Four keyframes (offsetlog segments 0..3).
		$this->checkpoint_at( $c, 0, 10 );
		$rewind = $this->newest_segment_id( $c ); // segment 0.
		$this->checkpoint_at( $c, 0, 20 );
		$this->checkpoint_at( $c, 0, 30 );
		$this->checkpoint_at( $c, 0, 40 );
		$offsetlog = $this->read_private( $c, 'offsetlog' );
		$this->assertCount( 4, $offsetlog->get_segments( true ), 'precondition: 4 keyframes' );

		$c->pause();
		$c->seek_frame( $rewind );
		$c->play();

		$ids = \array_column( $offsetlog->get_segments( true ), 'id' );
		$this->assertSame( [ $rewind ], $ids, 'PLAY truncates the offsetlog frames after the rewind point' );
		$this->assertNull( $this->read_private( $c, 'rewound_to' ), 'PLAY clears the rewind point' );
		$this->assertTrue( $this->timer_armed( $c ), 'PLAY re-arms the poll timer' );
	}

	public function test_play_without_prior_seek_does_not_truncate(): void {
		Core::$now = 9200.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );

		$this->checkpoint_at( $c, 0, 10 );
		$this->checkpoint_at( $c, 0, 20 );
		$this->checkpoint_at( $c, 0, 30 );
		$offsetlog = $this->read_private( $c, 'offsetlog' );
		$before    = $offsetlog->get_segments( true );
		$this->assertCount( 3, $before );

		$c->pause();
		$c->play();

		$this->assertSame( $before, $offsetlog->get_segments( true ), 'normal pause/play with no seek leaves the offsetlog intact' );
	}

	public function test_seek_then_play_then_checkpoint_keeps_offsetlog_monotonic(): void {
		// End-to-end: after seek→play→checkpoint the new frame appends AFTER the
		// rewind point and the old future frames are gone — a single coherent,
		// monotonic forward timeline.
		Core::$now = 9300.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );

		$this->checkpoint_at( $c, 5, 11 ); // frame 0, source 5:11.
		$rewind = $this->newest_segment_id( $c );
		$this->checkpoint_at( $c, 6, 22 ); // frame 1.
		$this->checkpoint_at( $c, 7, 33 ); // frame 2.

		$c->pause();
		$c->seek_frame( $rewind );
		$c->play();

		// A fresh checkpoint after PLAY: cursor advanced from the rewind point.
		$this->checkpoint_at( $c, 8, 44 );

		$offsetlog = $this->read_private( $c, 'offsetlog' );
		$ids       = \array_column( $offsetlog->get_segments( true ), 'id' );
		$this->assertSame( [ $rewind, $rewind + 1 ], $ids, 'new checkpoint appends right after the rewind point; the old future frames are gone' );

		// The newest frame is the post-PLAY checkpoint, not a stale future frame.
		$record = $this->read_newest_offset_record( $offsetlog );
		$this->assertSame( 8, $record['segment'], 'newest frame is the post-PLAY checkpoint source seg' );
		$this->assertSame( 44, $record['offset'], 'newest frame is the post-PLAY checkpoint source off' );
	}

	/** Read the newest offsetlog segment's record VALUE ({seg,off,...}). */
	private function read_newest_offset_record( Partition_Node $offsetlog ): array {
		$segments = $offsetlog->get_segments( true );
		$newest   = \end( $segments );
		$bytes    = $offsetlog->read_at( $newest['id'], 0, $newest['size'] );
		$lines    = \array_filter( \explode( "\n", $bytes ), static fn ( $l ) => '' !== $l );
		return Message::unpacked( \end( $lines ) )[ Message::VALUE ];
	}

	// ============================================================================
	// Command-verb dispatch through the {name}:config interpreter (production path).
	// ============================================================================

	public function test_command_verbs_dispatch_through_config_interpreter(): void {
		Core::$now = 6000.0;
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$this->checkpoint_at( $c, 3, 77 );
		$segment_id = $this->newest_segment_id( $c );

		// PAUSE via the config interpreter.
		$this->assertSame( 'ok', $this->dispatch_command( $c, 'PAUSE' ) );
		$this->assertFalse( $this->timer_armed( $c ) );

		// SEEK_FRAME <segment-id> — arg parsing casts the one int.
		$this->assertSame( 'ok', $this->dispatch_command( $c, 'SEEK_FRAME', (string) $segment_id ) );
		$this->assertSame( 3, $this->read_private( $c, 'cursor_segment' ), 'cursor restored to the record source seg' );
		$this->assertSame( 77, $this->read_private( $c, 'cursor_offset' ), 'cursor restored to the record source off' );

		// PLAY re-arms.
		$this->assertSame( 'ok', $this->dispatch_command( $c, 'PLAY' ) );
		$this->assertTrue( $this->timer_armed( $c ) );
	}

	/** Fire a TM_COMMAND verb through the Consumer's {name}:config interpreter; return the reply payload. */
	private function dispatch_command( Consumer_Node $c, string $verb, string $args = '' ): mixed {
		$interpreter = $this->read_private( $c, 'interpreter' );
		$cap         = new Capture_Sink_Node();
		$interpreter->sink( $cap );

		$cmd                   = Message::new_message();
		$cmd[ Message::TYPE ]  = Message::TM_COMMAND;
		$cmd[ Message::FROM ]  = 'asker';
		$cmd[ Message::TO ]    = '';
		$cmd[ Message::LOCAL ] = true;
		$cmd[ Message::VALUE ] = [ 'name' => $verb, 'arguments' => $args ];
		$interpreter->fill( $cmd );

		return $cap->captured[0][ Message::VALUE ]['payload'];
	}

	// ============================================================================
	// Regression: GET_LAG survives; the consolidated read verbs are gone.
	// ============================================================================

	public function test_existing_get_lag_still_works(): void {
		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$data = $this->request( $c, $cap, 'GET_LAG' );
		$this->assertArrayHasKey( 'bytes_behind', $data );
		$this->assertArrayHasKey( 'caught_up', $data );
	}

	/**
	 * The three read verbs folded into dump_metadata are gone from the request
	 * schema AND from handle_request dispatch (unknown-verb error).
	 */
	public function test_consolidated_read_verbs_are_removed(): void {
		$schema = Consumer_Node::node_schema();
		$verbs  = \array_column( $schema['requests'], 'name' );
		$this->assertNotContains( 'LIST_FRAMES', $verbs );
		$this->assertNotContains( 'READ_STATE', $verbs );
		$this->assertNotContains( 'GET_OFFSET', $verbs );

		$c = new Consumer_Node();
		$c->arguments( [ "{$this->tmp}/data/p0", "{$this->tmp}/offsets/r/p0" ] );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		foreach ( [ 'LIST_FRAMES', 'READ_STATE', 'GET_OFFSET' ] as $gone ) {
			$data = $this->request( $c, $cap, $gone );
			$this->assertArrayHasKey( 'error', $data, "{$gone} must be an unknown verb now" );
			$this->assertStringContainsString( 'unknown request verb', $data['error'] );
		}
	}

	// ============================================================================
	// Helpers
	// ============================================================================

	/** True when the Consumer has a live timer in either scheduling mode. */
	private function timer_armed( Consumer_Node $c ): bool {
		return 'inactive' !== $this->read_private( $c, 'mode' );
	}

	/** Newest offsetlog segment id (the keyframe SEEK_FRAME addresses). */
	private function newest_segment_id( Consumer_Node $c ): int {
		$segments = $this->read_private( $c, 'offsetlog' )->get_segments( true );
		return \end( $segments )['id'];
	}

	/** Build one packed offsetlog record (the {seg,off,...} VALUE) + trailing \n. */
	private function offset_record( int $segment, int $offset, int $ts ): string {
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_STRUCT;
		$message[ Message::TIMESTAMP ] = $ts;
		$message[ Message::VALUE ]     = [ 'segment' => $segment, 'offset' => $offset, 'name' => 'r', 'cache' => [ 'big' => 'blob' ] ];
		return Message::packed( $message ) . "\n";
	}

	/** Build a TM_BYTESTREAM message and flush it through the source Partition. */
	private function produce_line( Partition_Node $partition, string $value ): void {
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::TIMESTAMP ] = \microtime( true );
		$message[ Message::VALUE ]     = $value;
		$partition->fill( $message );
		$partition->flush();
	}
}

/** A node with the duck-typed save_state/restore_state the Consumer snapshots. */
class TimeTravel_Snapshot_Probe extends Node {
	/** @var array<string, mixed> */
	public array $state = [];
	/** @var array<string, mixed>|null Captures the last restore_state() argument. */
	public ?array $restored = null;
	public function save_state(): array {
		return $this->state;
	}
	public function restore_state( array $saved ): void {
		$this->restored = $saved;
		$this->state    = $saved;
	}
}
