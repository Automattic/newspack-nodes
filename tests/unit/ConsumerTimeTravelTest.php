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
 * Time-travel transport verbs on Consumer_Node: LIST_FRAMES, SEEK_FRAME, PAUSE,
 * STEP, PLAY, READ_STATE. These back a debugger UI that pauses a consumer, seeks
 * it to an offsetlog checkpoint (restoring the co-committed snapshot), and
 * single-steps it message-by-message.
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
	private function checkpoint_at( Consumer_Node $c, int $seg, int $off ): void {
		$c->next_offset( [ 'seg' => $seg, 'off' => $off ] );
		Core::$now = Core::$now + 1.0;
		$c->checkpoint();
	}

	// ============================================================================
	// LIST_FRAMES
	// ============================================================================

	public function test_list_frames_returns_lightweight_checkpoint_list_oldest_to_newest(): void {
		Core::$now = 1000.0;
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$this->checkpoint_at( $c, 0, 10 );
		$this->checkpoint_at( $c, 0, 20 );
		$this->checkpoint_at( $c, 1, 5 );

		$data   = $this->request( $c, $cap, 'LIST_FRAMES' );
		$frames = $data['frames'];

		$this->assertCount( 3, $frames );
		$this->assertSame( [ 'seg' => 0, 'off' => 10 ], [ 'seg' => $frames[0]['seg'], 'off' => $frames[0]['off'] ] );
		$this->assertSame( [ 'seg' => 0, 'off' => 20 ], [ 'seg' => $frames[1]['seg'], 'off' => $frames[1]['off'] ] );
		$this->assertSame( [ 'seg' => 1, 'off' => 5 ],  [ 'seg' => $frames[2]['seg'], 'off' => $frames[2]['off'] ] );
		// ts present, monotonic.
		$this->assertGreaterThan( 0, $frames[0]['ts'] );
		$this->assertLessThanOrEqual( $frames[2]['ts'], $frames[0]['ts'] );
		$this->assertFalse( $data['truncated'] );
	}

	public function test_list_frames_omits_the_cache_blob(): void {
		// The ruler only needs positions/timestamps; caches can be up to 32MB so
		// the lightweight frame list must NOT carry them.
		Core::$now = 2000.0;
		$node      = new TimeTravel_Snapshot_Probe();
		$node->name( 'request-builder' );
		$node->state = [ 'pad' => \str_repeat( 'x', 6000 ) ];

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$c->set_snapshot_node( 'request-builder' );

		$this->checkpoint_at( $c, 0, 42 );

		$data  = $this->request( $c, $cap, 'LIST_FRAMES' );
		$frame = $data['frames'][0];
		$this->assertArrayNotHasKey( 'cache', $frame, 'frame list must not carry the snapshot cache' );
		$this->assertSame( [ 'seg', 'off', 'ts' ], \array_keys( $frame ) );
	}

	public function test_list_frames_scans_all_retained_segments(): void {
		// load_offsetlog reads only the newest segment; LIST_FRAMES must scan
		// every retained segment. Write two segment files by hand.
		$dir = "{$this->tmp}/offsets/r/p0";
		\mkdir( $dir, 0755, true );
		\file_put_contents( "{$dir}/0.log", $this->offset_record( 0, 1, 100 ) . $this->offset_record( 0, 2, 200 ) );
		\file_put_contents( "{$dir}/1.log", $this->offset_record( 1, 3, 300 ) );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$data   = $this->request( $c, $cap, 'LIST_FRAMES' );
		$frames = $data['frames'];
		$this->assertCount( 3, $frames );
		$offs = \array_column( $frames, 'off' );
		$this->assertSame( [ 1, 2, 3 ], $offs, 'frames span both segments, oldest→newest' );
	}

	public function test_offsetlog_is_one_segment_per_checkpoint_keyframe(): void {
		// The offsetlog is tuned (segment_size=1) so each commit = one segment =
		// one keyframe: do_rotate() adopts the still-empty newest segment on the
		// first commit, then rotates to a fresh segment on every commit after.
		Core::$now = 7000.0;
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
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

	public function test_offsetlog_retains_only_the_last_num_segments_keyframes(): void {
		// num_segments keyframes are kept; older ones are pruned (max_lifespan=0,
		// so the AND-gated retention's age clause never blocks). list_frames()
		// returns the surviving frames oldest→newest.
		Core::$now = 8000.0;
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$keep  = Consumer_Node::OFFSETLOG_NUM_SEGMENTS;
		$total = $keep + 3;
		for ( $i = 1; $i <= $total; $i++ ) {
			$this->checkpoint_at( $c, 0, $i * 10 );
		}

		$offsetlog = $this->read_private( $c, 'offsetlog' );
		$this->assertLessThanOrEqual( $keep, \count( $offsetlog->get_segments( true ) ), 'retention prunes to num_segments' );

		$data   = $this->request( $c, $cap, 'LIST_FRAMES' );
		$frames = $data['frames'];
		$this->assertCount( $keep, $frames, 'exactly num_segments keyframes retained' );
		// The surviving frames are the newest $keep, oldest→newest.
		$expected = [];
		for ( $i = $total - $keep + 1; $i <= $total; $i++ ) {
			$expected[] = $i * 10;
		}
		$this->assertSame( $expected, \array_column( $frames, 'off' ) );
		$this->assertFalse( $data['truncated'], 'num_segments is well under MAX_LISTED_FRAMES' );
	}

	public function test_load_offsetlog_resumes_from_newest_keyframe_after_pruning(): void {
		// Crash-resume still seeds the cursor from the newest retained frame even
		// after older keyframes are pruned (load_offsetlog reads the newest segment).
		Core::$now = 8500.0;
		$c1 = new Consumer_Node();
		$c1->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c1->name( 'firehose:consumer' );
		$c1->sink( new Capture_Sink_Node() );

		$total = Consumer_Node::OFFSETLOG_NUM_SEGMENTS + 2;
		for ( $i = 1; $i <= $total; $i++ ) {
			$this->checkpoint_at( $c1, 2, $i * 100 );
		}
		// Old worker process dies; the offsetlog files persist on disk.
		Core::reset();

		// New worker: poll_init → load_offsetlog seeds from the newest frame (2:$total*100).
		$c2 = new Consumer_Node();
		$c2->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c2->name( 'firehose:consumer' );
		$c2->sink( new Capture_Sink_Node() );
		$c2->poll();

		$this->assertTrue( $c2->has_checkpoint() );
		$this->assertSame( 2, $this->read_private( $c2, 'cursor_seg' ) );
		$this->assertSame( $total * 100, $this->read_private( $c2, 'cursor_off' ), 'resumes from the newest retained keyframe' );
	}

	public function test_list_frames_skips_unparseable_records(): void {
		$dir = "{$this->tmp}/offsets/r/p0";
		\mkdir( $dir, 0755, true );
		// One garbage line, one good record.
		\file_put_contents( "{$dir}/0.log", "not-a-packed-message\n" . $this->offset_record( 0, 7, 700 ) );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$data = $this->request( $c, $cap, 'LIST_FRAMES' );
		$this->assertCount( 1, $data['frames'], 'unparseable records are skipped' );
		$this->assertSame( 7, $data['frames'][0]['off'] );
	}

	public function test_list_frames_empty_when_no_offsetlog(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$data = $this->request( $c, $cap, 'LIST_FRAMES' );
		$this->assertSame( [], $data['frames'] );
		$this->assertFalse( $data['truncated'] );
	}

	public function test_list_frames_caps_count_newest_biased_and_flags_truncated(): void {
		$dir = "{$this->tmp}/offsets/r/p0";
		\mkdir( $dir, 0755, true );
		$blob = '';
		// 600 records; the cap is 500, newest-biased.
		for ( $i = 1; $i <= 600; $i++ ) {
			$blob .= $this->offset_record( 0, $i, $i * 10 );
		}
		\file_put_contents( "{$dir}/0.log", $blob );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$data   = $this->request( $c, $cap, 'LIST_FRAMES' );
		$frames = $data['frames'];
		$this->assertCount( 500, $frames );
		$this->assertTrue( $data['truncated'] );
		// Newest-biased: the last 500 (offsets 101..600), still oldest→newest.
		$this->assertSame( 101, $frames[0]['off'] );
		$this->assertSame( 600, $frames[499]['off'] );
	}

	// ============================================================================
	// SEEK_FRAME
	// ============================================================================

	public function test_seek_frame_restores_state_and_moves_cursor(): void {
		// Commit a frame carrying a snapshot cache, advance the cursor + mutate
		// the node, then SEEK_FRAME back to that frame: restore_state must get the
		// frame's cache and the cursor must move to the frame's {seg,off}.
		Core::$now = 3000.0;
		$node      = new TimeTravel_Snapshot_Probe();
		$node->name( 'request-builder' );
		$node->state = [ 'in_flight' => [ 'r1' => 1 ] ];

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$c->set_snapshot_node( 'request-builder' );

		$this->checkpoint_at( $c, 2, 64 );
		$frame_cache = $node->state;

		// Drift the node + cursor away from the committed frame.
		$node->state = [ 'in_flight' => [ 'r9' => 9 ] ];
		$c->next_offset( [ 'seg' => 5, 'off' => 999 ] );

		$result = $c->seek_frame( 2, 64 );
		$this->assertSame( 'ok', $result );
		$this->assertSame( $frame_cache, $node->restored, 'restore_state got the frame cache' );

		$seg = $this->read_private( $c, 'cursor_seg' );
		$off = $this->read_private( $c, 'cursor_off' );
		$this->assertSame( 2, $seg );
		$this->assertSame( 64, $off );
	}

	public function test_seek_frame_does_not_rearm_timer(): void {
		// A paused consumer stays paused after seeking.
		Core::$now = 3100.0;
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$this->checkpoint_at( $c, 0, 30 );

		$c->pause();
		$c->seek_frame( 0, 30 );

		$this->assertFalse( $this->timer_armed( $c ), 'seek must not re-arm the poll timer' );
	}

	public function test_seek_frame_returns_error_when_frame_absent(): void {
		Core::$now = 3200.0;
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$this->checkpoint_at( $c, 0, 10 );

		$result = $c->seek_frame( 9, 9999 );
		$this->assertStringContainsString( 'no frame', $result );
	}

	public function test_seek_frame_returns_error_when_no_offsetlog(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 " );
		$c->sink( new Capture_Sink_Node() );
		$result = $c->seek_frame( 0, 0 );
		$this->assertStringContainsString( 'offsetlog', $result );
	}

	// ============================================================================
	// PAUSE
	// ============================================================================

	public function test_pause_stops_the_timer(): void {
		Core::$now = 4000.0;
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
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
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'a' );
		$this->produce_line( $source, 'b' );
		$this->produce_line( $source, 'c' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
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
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'a' );
		$this->produce_line( $source, 'b' );

		// Consumer NOT in line mode — a normal poll would drain both at once.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
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
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'a' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		// arguments() armed an EOF timer; STEP must stop it.
		$this->assertTrue( $this->timer_armed( $c ), 'precondition: timer armed by arguments()' );

		$c->step();
		$this->assertFalse( $this->timer_armed( $c ), 'STEP leaves the consumer paused' );
	}

	public function test_step_command_returns_cursor_and_eof_json(): void {
		// STEP is a COMMAND (it mutates: emits + advances the durable cursor), so
		// it dispatches through the auth-gated {name}:config interpreter. Its reply
		// is the {seg,off,at_eof} array as a JSON string for the UI to parse.
		$source = new Partition_Node();
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'only' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$reply = $this->dispatch_command( $c, 'STEP' );
		$data  = \json_decode( $reply, true );
		$this->assertSame( 0, $data['seg'] );
		$this->assertGreaterThan( 0, $data['off'], 'cursor advanced past the emitted line' );
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
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'guarded' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$data_cap = new Capture_Sink_Node();
		$c->sink( $data_cap );

		$cursor_before = $this->read_private( $c, 'cursor_off' );

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
		$this->assertSame( $cursor_before, $this->read_private( $c, 'cursor_off' ), 'refused STEP must not advance the cursor' );
	}

	public function test_step_at_eof_is_a_noop(): void {
		// Empty source: STEP emits nothing and surfaces at_eof.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
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
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'a' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
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
		$source->arguments( "{$this->tmp}/data/p0 " . ( 64 * 1024 ) . ' 4 86400' );
		$this->produce_line( $source, 'a' );

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
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
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
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
	// READ_STATE
	// ============================================================================

	public function test_read_state_returns_snapshot_node_save_state(): void {
		$node        = new TimeTravel_Snapshot_Probe();
		$node->name( 'request-builder' );
		$node->state = [ 'in_flight' => [ 'r1' => [ 'x' => 1 ] ] ];

		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$c->set_snapshot_node( 'request-builder' );

		$data = $this->request( $c, $cap, 'READ_STATE' );
		$this->assertSame( $node->state, $data['state'] );
	}

	public function test_read_state_null_when_no_snapshot_node(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$data = $this->request( $c, $cap, 'READ_STATE' );
		$this->assertNull( $data['state'] );
	}

	public function test_read_state_null_when_snapshot_node_missing(): void {
		// Named snapshot node that was never registered.
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );
		$c->set_snapshot_node( 'ghost' );

		$data = $this->request( $c, $cap, 'READ_STATE' );
		$this->assertNull( $data['state'] );
	}

	// ============================================================================
	// Command-verb dispatch through the {name}:config interpreter (production path).
	// ============================================================================

	public function test_command_verbs_dispatch_through_config_interpreter(): void {
		Core::$now = 6000.0;
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$c->sink( new Capture_Sink_Node() );
		$this->checkpoint_at( $c, 3, 77 );

		// PAUSE via the config interpreter.
		$this->assertSame( 'ok', $this->dispatch_command( $c, 'PAUSE' ) );
		$this->assertFalse( $this->timer_armed( $c ) );

		// SEEK_FRAME 3 77 — arg parsing splits seg/off and casts to int.
		$this->assertSame( 'ok', $this->dispatch_command( $c, 'SEEK_FRAME', '3 77' ) );
		$this->assertSame( 3, $this->read_private( $c, 'cursor_seg' ) );
		$this->assertSame( 77, $this->read_private( $c, 'cursor_off' ) );

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
	// Regression: the existing verb table still works.
	// ============================================================================

	public function test_existing_get_offset_still_works(): void {
		$c = new Consumer_Node();
		$c->arguments( "{$this->tmp}/data/p0 {$this->tmp}/offsets/r/p0" );
		$c->name( 'firehose:consumer' );
		$cap = new Capture_Sink_Node();
		$c->sink( $cap );

		$data = $this->request( $c, $cap, 'GET_OFFSET' );
		$this->assertArrayHasKey( 'cursor_seg', $data );
		$this->assertArrayHasKey( 'checkpoint_off', $data );
	}

	// ============================================================================
	// Helpers
	// ============================================================================

	/** True when the Consumer has a live timer in either scheduling mode. */
	private function timer_armed( Consumer_Node $c ): bool {
		return 'inactive' !== $this->read_private( $c, 'mode' );
	}

	/** Build one packed offsetlog record (the {seg,off,ts,...} VALUE) + trailing \n. */
	private function offset_record( int $seg, int $off, int $ts ): string {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_STRUCT;
		$message[ Message::VALUE ] = [ 'seg' => $seg, 'off' => $off, 'ts' => $ts, 'name' => 'r', 'cache' => [ 'big' => 'blob' ] ];
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
