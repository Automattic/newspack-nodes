<?php
namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\Medium;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;

#[CoversClass( Lock_Node::class )]
#[Medium]
class LockTest extends TestCase {
	public function test_release_spares_a_lock_dir_another_process_stole(): void {
		// An evicted holder must not destroy its successor. A worker blocked in
		// a long job goes stale, a peer steals, and the original then exits —
		// if release() trusts its own is_held flag it deletes the THIEF's dir,
		// and the healthy successor dies of "lock dir gone" one tick later.
		$path = "{$this->tmp}/locks/ledger-workers.p4.lock.d";
		$held = new Lock_Node( $path, 7 );
		$this->assertTrue( $held->acquire() );

		// Exactly what a real steal leaves behind: our dir, someone else's PID.
		$thief_pid = \getmypid() + 9187;
		\file_put_contents( "{$path}/heartbeat", (string) $thief_pid );

		$held->release();

		$this->assertDirectoryExists( $path, "the thief's lock dir must survive the evicted holder's release" );
		$this->assertSame(
			(string) $thief_pid,
			\trim( (string) \file_get_contents( "{$path}/heartbeat" ) ),
			"the thief's heartbeat must be untouched"
		);
	}

	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_acquire_creates_lock_directory(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );
		$this->assertTrue( is_dir( "{$this->tmp}/test.lock.d" ) );
		$this->assertTrue( $lock->is_held() );
	}

	public function test_acquire_writes_pid_to_heartbeat(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$this->assertSame(
			(string) getmypid(),
			file_get_contents( "{$this->tmp}/test.lock.d/heartbeat" )
		);
	}

	public function test_acquire_writes_started_timestamp(): void {
		$before = time();
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );

		$contents = file_get_contents( "{$this->tmp}/test.lock.d/started" );
		$this->assertNotFalse( $contents );
		$started = (int) $contents;
		$this->assertGreaterThanOrEqual( $before, $started );
		$this->assertLessThanOrEqual( time(), $started );
	}

	public function test_acquire_fails_when_already_held(): void {
		$a = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$b = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $a->acquire() );
		$this->assertFalse( $b->acquire() );
	}

	public function test_release_removes_lock_directory(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$lock->release();
		$this->assertFalse( $lock->is_held() );
		$this->assertFalse( is_dir( "{$this->tmp}/test.lock.d" ) );
	}

	public function test_heartbeat_updates_mtime(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$hb = "{$this->tmp}/test.lock.d/heartbeat";
		// Backdate so heartbeat()'s touch produces a strictly-newer mtime
		// without waiting a wall-clock second (filemtime is integer-second
		// resolution).
		touch( $hb, time() - 5 );
		clearstatcache();
		$old = filemtime( $hb );
		$lock->heartbeat();
		clearstatcache();
		$this->assertGreaterThan( $old, filemtime( $hb ) );
	}

	public function test_force_release_at_unconditionally_clears(): void {
		// Static form: clears regardless of staleness.
		$dir = "{$this->tmp}/test.lock.d";
		mkdir( $dir, 0755, true );
		touch( "$dir/heartbeat", time() ); // fresh — instance would skip.

		Lock_Node::force_release_at( $dir );
		$this->assertFalse( is_dir( $dir ) );
	}

	public function test_force_release_at_no_op_on_missing_dir(): void {
		// Idempotent: clearing a nonexistent dir is a no-op (no exception).
		Lock_Node::force_release_at( "{$this->tmp}/never.lock.d" );
		$this->assertTrue( true );
	}

	// Lock::with_lock() was removed — per-write callback locking was the wrong
	// abstraction (the user explicitly killed it). Locking now happens once at
	// allow_large_writes() time on the Partition, with a heartbeat Timer
	// keeping the lock fresh; see PartitionTest::test_allow_large_writes_*.

	// --- Reload channel -----------------------------------------------------

	public function test_request_reload_at_creates_a_flag_distinct_from_restart(): void {
		$dir = "{$this->tmp}/test.lock.d";
		$holder = new Lock_Node( $dir );
		$this->assertTrue( $holder->acquire() );

		$this->assertTrue( Lock_Node::request_reload_at( $dir ) );

		$this->assertFileExists( $dir . '/' . Lock_Node::RELOAD_FLAG );
		// The whole point: a config reload must never cost a process recycle.
		$this->assertFileDoesNotExist( $dir . '/' . Lock_Node::RESTART_FLAG );
		$this->assertSame( '', $holder->restart_reason() );
	}

	public function test_request_reload_at_returns_false_when_lock_dir_missing(): void {
		$this->assertFalse( Lock_Node::request_reload_at( "{$this->tmp}/nonexistent.lock.d" ) );
	}

	public function test_force_release_at_clears_the_reload_flag_so_the_dir_can_go(): void {
		// rmdir() only empties an EMPTY dir: a surviving reload flag would turn
		// every clean release into an orphan peers must steal through the grace.
		$dir = "{$this->tmp}/test.lock.d";
		\mkdir( $dir, 0755, true );
		\touch( "{$dir}/heartbeat" );
		Lock_Node::request_reload_at( $dir );

		Lock_Node::force_release_at( $dir );

		$this->assertFalse( \is_dir( $dir ) );
	}

	// --- Restart channel ----------------------------------------------------

	public function test_restart_reason_empty_by_default(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$this->assertSame( '', $lock->restart_reason() );
	}

	public function test_request_restart_at_creates_flag_seen_by_restart_reason(): void {
		$holder = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $holder->acquire() );

		// Different Lock instance pointing at the same path simulates an
		// external requester (REST endpoint, admin action, peer worker).
		$external = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( Lock_Node::request_restart_at( "{$this->tmp}/test.lock.d" ) );

		$this->assertSame( 'restart requested', $holder->restart_reason() );
		$this->assertFileExists( "{$this->tmp}/test.lock.d/" . Lock_Node::RESTART_FLAG );
	}

	public function test_request_restart_at_returns_false_when_lock_dir_missing(): void {
		$lock = new Lock_Node( "{$this->tmp}/nonexistent.lock.d" );
		$this->assertFalse( Lock_Node::request_restart_at( "{$this->tmp}/nonexistent.lock.d" ) );
		$this->assertSame( '', $lock->restart_reason() );
	}

	public function test_request_restart_at_static_form(): void {
		$holder = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $holder->acquire() );

		// Static path-only API.
		$this->assertTrue( Lock_Node::request_restart_at( "{$this->tmp}/test.lock.d" ) );
		$this->assertSame( 'restart requested', $holder->restart_reason() );
	}

	public function test_request_restart_at_returns_false_for_missing_dir(): void {
		$this->assertFalse( Lock_Node::request_restart_at( "{$this->tmp}/missing.lock.d" ) );
	}

	public function test_is_restart_pending_static(): void {
		$holder = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$holder->acquire();

		$this->assertFalse( Lock_Node::is_restart_pending( "{$this->tmp}/test.lock.d" ) );
		Lock_Node::request_restart_at( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( Lock_Node::is_restart_pending( "{$this->tmp}/test.lock.d" ) );
	}

	public function test_release_implicitly_removes_restart_flag(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		Lock_Node::request_restart_at( "{$this->tmp}/test.lock.d" );
		$this->assertSame( 'restart requested', $lock->restart_reason() );

		$lock->release();
		$this->assertSame( '', $lock->restart_reason() );
		$this->assertFalse( is_dir( "{$this->tmp}/test.lock.d" ) );
	}

	// --- PID-content theft detection ---------------------------------------

	public function test_restart_reason_detects_heartbeat_pid_mismatch(): void {
		// Holder believes it has the lock. An external party overwrites the
		// heartbeat with a different PID. The holder reports the theft so it
		// exits cleanly and a peer respawns it.
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );
		$this->assertSame( '', $lock->restart_reason() );

		// Simulate lock theft: another process writes its own PID over ours.
		$thief = getmypid() + 99999;
		file_put_contents( "{$this->tmp}/test.lock.d/heartbeat", (string) $thief );

		$this->assertSame( "lock stolen by pid {$thief}", $lock->restart_reason() );
	}

	public function test_restart_reason_detects_heartbeat_file_gone(): void {
		// Catastrophic case: heartbeat file deleted out from under us. Treat as
		// lock theft / orphan — exit clean.
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );
		unlink( "{$this->tmp}/test.lock.d/heartbeat" );

		$this->assertSame( 'lock heartbeat gone', $lock->restart_reason() );
	}

	public function test_restart_reason_skips_pid_check_when_not_held(): void {
		// External-pointer Lock (didn't acquire): PID check shouldn't fire.
		// only the restart-flag check matters.
		$external = new Lock_Node( "{$this->tmp}/test.lock.d" );
		mkdir( "{$this->tmp}/test.lock.d", 0755, true );
		file_put_contents( "{$this->tmp}/test.lock.d/heartbeat", '99999' );

		$this->assertSame( '', $external->restart_reason() );
	}

	public function test_restart_reason_tells_the_three_causes_apart(): void {
		// One bool covering all three read as an operator-requested restart
		// whether an operator asked, the dir vanished, or a peer stole the lock.
		$flagged = new Lock_Node( "{$this->tmp}/flagged.lock.d" );
		$flagged->acquire();
		Lock_Node::request_restart_at( "{$this->tmp}/flagged.lock.d" );

		$stolen = new Lock_Node( "{$this->tmp}/stolen.lock.d" );
		$stolen->acquire();
		file_put_contents( "{$this->tmp}/stolen.lock.d/heartbeat", (string) ( getmypid() + 12345 ) );

		$vanished = new Lock_Node( "{$this->tmp}/vanished.lock.d" );
		$vanished->acquire();
		unlink( "{$this->tmp}/vanished.lock.d/heartbeat" );

		$reasons = [ $flagged->restart_reason(), $stolen->restart_reason(), $vanished->restart_reason() ];

		$this->assertSame( 'restart requested', $reasons[0] );
		$this->assertSame( $reasons, \array_unique( $reasons ) );
	}

	// --- Started-time helper ------------------------------------------------

	public function test_get_started_time_returns_acquired_timestamp(): void {
		$before = time();
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );

		$started = Lock_Node::get_started_time( "{$this->tmp}/test.lock.d" );
		$this->assertNotNull( $started );
		$this->assertGreaterThanOrEqual( $before, $started );
		$this->assertLessThanOrEqual( time(), $started );
	}

	public function test_get_started_time_returns_null_for_missing_dir(): void {
		$this->assertNull( Lock_Node::get_started_time( "{$this->tmp}/missing.lock.d" ) );
	}

	public function test_get_started_time_returns_null_when_file_missing(): void {
		// Lock dir exists but no started file (orphan from older code).
		mkdir( "{$this->tmp}/orphan.lock.d", 0755, true );
		file_put_contents( "{$this->tmp}/orphan.lock.d/heartbeat", '12345' );

		$this->assertNull( Lock_Node::get_started_time( "{$this->tmp}/orphan.lock.d" ) );
	}

	// --- Grace period for orphan dirs ---------------------------------------

	public function test_acquire_does_not_steal_fresh_orphan_and_does_not_block(): void {
		// A just-created heartbeat-less dir means the owner is mid-acquire
		// (mkdir done, heartbeat not yet written). acquire() must NOT steal it,
		// and must NOT block the calling request to find that out.
		mkdir( "{$this->tmp}/orphan.lock.d", 0755, true );

		$lock    = new Lock_Node( "{$this->tmp}/orphan.lock.d" );
		$started = microtime( true );
		$result  = $lock->acquire();
		$elapsed = microtime( true ) - $started;

		$this->assertFalse( $result, 'A fresh orphan dir must not be stolen.' );
		$this->assertLessThan(
			Lock_Node::ORPHAN_GRACE_S,
			$elapsed,
			'acquire() must not sleep in request scope while judging an orphan dir.'
		);
	}

	public function test_acquire_does_not_steal_orphan_at_the_grace_boundary(): void {
		// Integer-second mtime granularity: a truly-fresh orphan (owner mid-acquire,
		// heartbeat pending) reads as ORPHAN_GRACE_S seconds old the instant the wall
		// clock ticks past a second boundary between its mkdir and this acquire's
		// time() read — that boundary straddle is the flaky-steal window (a rare
		// double-lock race in production). A dir whose MEASURED age is exactly the
		// grace must still be protected, since its true age can be as little as 0s.
		mkdir( "{$this->tmp}/orphan.lock.d", 0755, true );
		touch( "{$this->tmp}/orphan.lock.d", time() - Lock_Node::ORPHAN_GRACE_S );

		$lock = new Lock_Node( "{$this->tmp}/orphan.lock.d" );

		$this->assertFalse(
			$lock->acquire(),
			'An orphan at exactly the grace boundary must not be stolen.'
		);
	}

	public function test_acquire_steals_aged_orphan_dir_without_blocking(): void {
		// Lock dir exists but no heartbeat file (crash during creation), and it
		// has sat heartbeat-less past the grace window — the owner died
		// mid-acquire. acquire() steals it, judging staleness by the dir's own
		// mtime (no real sleep).
		mkdir( "{$this->tmp}/orphan.lock.d", 0755, true );
		touch( "{$this->tmp}/orphan.lock.d", time() - ( Lock_Node::ORPHAN_GRACE_S + 5 ) );

		$lock    = new Lock_Node( "{$this->tmp}/orphan.lock.d" );
		$started = microtime( true );
		$result  = $lock->acquire();
		$elapsed = microtime( true ) - $started;

		$this->assertTrue( $result, 'An aged heartbeat-less orphan dir must be stolen.' );
		$this->assertFileExists( "{$this->tmp}/orphan.lock.d/heartbeat" );
		$this->assertLessThan(
			Lock_Node::ORPHAN_GRACE_S,
			$elapsed,
			'acquire() must judge orphan age by mtime, not by sleeping.'
		);
		// The atomic steal must not leave a renamed-aside scratch dir behind.
		$this->assertSame(
			[],
			glob( "{$this->tmp}/orphan.lock.d.stealing.*" ),
			'Atomic steal must clean up its renamed-aside scratch dir.'
		);
	}

	// --- fill() dispatch -----------------------------------------------------

	public function test_fill_with_heartbeat_key_refreshes_when_held(): void {
		// Heartbeat-tagged messages mirror Tachikoma's STREAM-based control
		// signaling; our 7-field layout uses KEY for the same purpose. When the
		// lock is held, fill() must call heartbeat() so the on-disk mtime
		// advances and stale-takeover can't fire mid-write.
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );

		$hb = "{$this->tmp}/test.lock.d/heartbeat";
		// Backdate so the post-fill() touch produces a strictly-newer mtime
		// without waiting a wall-clock second.
		\touch( $hb, \time() - 5 );
		\clearstatcache();
		$before = \filemtime( $hb );

		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::KEY ]       = 'heartbeat';
		$message[ Message::VALUE ]     = '';
		$lock->fill( $message );

		\clearstatcache();
		$this->assertGreaterThan( $before, \filemtime( $hb ) );
	}

	public function test_fill_with_heartbeat_key_noop_when_not_held(): void {
		// External Lock pointer at a lock dir we didn't acquire — fill()'s
		// heartbeat branch must still increment the counter but MUST NOT
		// touch the heartbeat file (we'd be stomping another holder's mtime).
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		// is_held remains false because acquire() was never called.
		$this->assertFalse( $lock->is_held() );
		$before = $lock->counter();

		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::KEY ]       = 'heartbeat';
		$message[ Message::VALUE ]     = '';
		$lock->fill( $message );

		$this->assertSame( $before + 1, $lock->counter(), 'counter ticks for every heartbeat message regardless of holder status' );
		// No lock dir should have been created by the heartbeat-key dispatch.
		$this->assertFalse( \is_dir( "{$this->tmp}/test.lock.d" ) );
	}

	public function test_fill_non_heartbeat_message_forwards_to_sink(): void {
		// KEY != 'heartbeat' falls through to parent::fill (Node::fill), which
		// stamps TO from target and forwards to sink. Validates the routing
		// branch — Lock is registered as a Node, so generic data messages
		// shouldn't be eaten by it.
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$sink = new Capture_Sink_Node();
		$lock->sink( $sink );

		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_BYTESTREAM;
		$message[ Message::KEY ]       = 'somekey';
		$message[ Message::VALUE ]     = 'payload';
		$lock->fill( $message );

		$this->assertCount( 1, $sink->captured );
		$this->assertSame( 'payload', $sink->captured[0][ Message::VALUE ] );
	}

	// --- verify_ownership() direct coverage ---------------------------------

	public function test_verify_ownership_returns_false_when_not_held(): void {
		// Fresh instance, never acquired — verify_ownership short-circuits on
		// the is_held guard without even reading the heartbeat file.
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertFalse( $lock->verify_ownership() );
	}

	public function test_verify_ownership_returns_true_when_pid_matches(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );
		$this->assertTrue( $lock->verify_ownership() );
		// Still considered held.
		$this->assertTrue( $lock->is_held() );
	}

	public function test_verify_ownership_flips_is_held_on_pid_mismatch(): void {
		// Hot-takeover sequence: we hold the lock, somebody stale-steals us,
		// they write their own pid into the heartbeat. verify_ownership must
		// flip is_held=false so a subsequent release() becomes a no-op (we
		// must not force-release a lock now legitimately owned by someone else).
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );
		$this->assertTrue( $lock->is_held() );

		\file_put_contents( "{$this->tmp}/test.lock.d/heartbeat", (string) ( \getmypid() + 99999 ) );

		$this->assertFalse( $lock->verify_ownership() );
		$this->assertFalse( $lock->is_held(), 'is_held must flip false so release() no-ops' );

		// release() is now defensive — the lock dir on disk belongs to "them".
		$lock->release();
		// Directory must still be there (we didn't force-release someone else's).
		$this->assertTrue( \is_dir( "{$this->tmp}/test.lock.d" ) );
	}

	public function test_verify_ownership_flips_is_held_when_heartbeat_unreadable(): void {
		// Catastrophic case: heartbeat file deleted out from under us between
		// acquire and the next ownership check. file_get_contents returns
		// false; verify_ownership must flip is_held=false and report lost.
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );

		\unlink( "{$this->tmp}/test.lock.d/heartbeat" );

		$this->assertFalse( $lock->verify_ownership() );
		$this->assertFalse( $lock->is_held() );
	}

	// --- heartbeat() failure branch -----------------------------------------

	public function test_heartbeat_returns_false_when_ownership_lost(): void {
		// heartbeat() is the early-warning seam for event-loop-less Partition
		// writers — they call heartbeat() before each large write to confirm
		// they still own the lock. Returning false MUST stop the caller from
		// writing into someone else's segment.
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );

		// Stale-steal simulation: overwrite heartbeat with another PID.
		\file_put_contents( "{$this->tmp}/test.lock.d/heartbeat", (string) ( \getmypid() + 1 ) );

		$this->assertFalse( $lock->heartbeat() );
		$this->assertFalse( $lock->is_held() );
	}

	public function test_heartbeat_returns_false_when_never_acquired(): void {
		// Mirrors the verify_ownership short-circuit, but exercises it through
		// heartbeat() — the public entry point Partition writers use.
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertFalse( $lock->heartbeat() );
	}

	// --- Acquire branches: retry path + write-failure rollback --------------

	public function test_acquire_blocks_until_max_wait_then_returns_false(): void {
		// max_wait_ms > 0 path: the holder is alive and stays alive throughout
		// our wait window. acquire() must usleep+retry inside the loop until
		// the deadline passes, then return false. Pin the wall-clock so a
		// regression that drops the retry loop would also drop the wait.
		$dir = "{$this->tmp}/contended.lock.d";
		\mkdir( $dir, 0755, true );
		// Fresh heartbeat — not stale.
		\file_put_contents( "$dir/heartbeat", (string) \getmypid() );

		$lock  = new Lock_Node( $dir, 60 );
		$start = \microtime( true );
		// Short wait so the test stays well inside the Medium 10s budget.
		$result  = $lock->acquire( 250 );
		$elapsed = ( \microtime( true ) - $start ) * 1000;

		$this->assertFalse( $result );
		$this->assertGreaterThanOrEqual(
			200,
			$elapsed,
			'acquire() must actually wait the requested ms before giving up'
		);
	}

	// --- node_schema() ------------------------------------------------------

	public function test_node_schema_marks_lock_as_hidden_internal(): void {
		// Lock is plumbing for Partition::allow_large_writes() — not meant to
		// be palette-rendered. The schema's `category=Hidden` is how the
		// topology console knows to suppress it. Pin the contract so a refactor
		// that bumps category to 'Lifecycle' (or similar) shows up here.
		$schema = Lock_Node::node_schema();
		$this->assertSame( 'Hidden', $schema['category'] );
		$this->assertNotEmpty( $schema['description'] );
		$this->assertSame( [], $schema['arguments'] );
		$this->assertSame( [], $schema['commands'] );
	}

	// ── acquire_failure() ──────────────────────────────────────────────────

	public function test_acquire_failure_reports_contention_as_lock_held(): void {
		$holder = new Lock_Node( "{$this->tmp}/contended.lock.d" );
		$this->assertTrue( $holder->acquire() );

		$loser = new Lock_Node( "{$this->tmp}/contended.lock.d" );
		$this->assertFalse( $loser->acquire() );
		$this->assertSame( 'lock_held', $loser->acquire_failure() );
	}

	public function test_acquire_failure_reports_mkdir_error_distinct_from_contention(): void {
		// Permission-denied mkdir (root-owned locks dir) is NOT contention;
		// diagnosing it as lock_held hides the real footgun three layers deep.
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'permission checks are moot as root' );
		}
		$parent = "{$this->tmp}/readonly";
		\mkdir( $parent, 0555, true );
		$lock = new Lock_Node( "{$parent}/w.p3.lock.d" );
		try {
			$this->assertFalse( $lock->acquire() );
		} finally {
			\chmod( $parent, 0755 );
		}
		$this->assertStringContainsString( 'mkdir', $lock->acquire_failure() );
		$this->assertStringContainsString( "{$parent}/w.p3.lock.d", $lock->acquire_failure(), 'the failing path must be named' );
	}

	public function test_acquire_failure_resets_on_success(): void {
		if ( \function_exists( 'posix_getuid' ) && 0 === \posix_getuid() ) {
			$this->markTestSkipped( 'permission checks are moot as root' );
		}
		$parent = "{$this->tmp}/flaky";
		\mkdir( $parent, 0555, true );
		$lock = new Lock_Node( "{$parent}/w.p0.lock.d" );
		$this->assertFalse( $lock->acquire() );
		\chmod( $parent, 0755 );
		$this->assertTrue( $lock->acquire() );
		$this->assertSame( '', $lock->acquire_failure() );
	}
	/**
	 * The lock dir sits in the runtime tree, so a planted `heartbeat` symlink
	 * turns the writer into a write primitive at the target. Both paths reach
	 * the write only after their own guards pass, so each is exercised where it
	 * actually writes: acquire through write_acquire_files() (the mkdir already
	 * succeeded — the plant lands in the window after it), and heartbeat with a
	 * target holding our pid, which is exactly what verify_ownership reads.
	 * Spawn_Coordinator already refuses to follow a link when sweeping.
	 */
	public function test_the_acquire_write_refuses_a_symlinked_heartbeat(): void {
		$victim = "{$this->tmp}/victim.txt";
		\file_put_contents( $victim, "untouched\n" );
		$lock_dir = "{$this->tmp}/planted.lock.d";
		@\mkdir( $lock_dir, 0700, true );
		@\symlink( $victim, "{$lock_dir}/heartbeat" );

		$lock   = new Lock_Node( $lock_dir );
		$method = new \ReflectionMethod( $lock, 'write_acquire_files' );

		$this->assertFalse( $method->invoke( $lock ), 'a planted link must fail the write' );
		$this->assertSame( "untouched\n", \file_get_contents( $victim ) );
	}

	public function test_heartbeat_refuses_a_symlink_whose_target_holds_our_pid(): void {
		// The target carries our pid, so verify_ownership() reads through the
		// link and passes — the guard has to be at the write itself.
		$victim = "{$this->tmp}/victim2.txt";
		\file_put_contents( $victim, (string) \getmypid() );
		$lock_dir = "{$this->tmp}/live.lock.d";
		$lock     = new Lock_Node( $lock_dir );
		$this->assertTrue( $lock->acquire() );
		@\unlink( "{$lock_dir}/heartbeat" );
		@\symlink( $victim, "{$lock_dir}/heartbeat" );
		\clearstatcache();
		$before = \filemtime( $victim );
		\sleep( 1 );

		$this->assertFalse( $lock->heartbeat(), 'a planted link must not be refreshed' );
		\clearstatcache();
		$this->assertSame( $before, \filemtime( $victim ) );
	}

}
