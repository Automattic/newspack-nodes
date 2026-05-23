<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\Medium;

#[Medium]
#[CoversClass( Lock_Node::class )]
class LockTest extends TestCase {
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

	public function test_force_release_breaks_stale_lock(): void {
		// Instance form: only releases if heartbeat is stale.
		$dir = "{$this->tmp}/test.lock.d";
		mkdir( $dir, 0755, true );
		touch( "$dir/heartbeat", time() - 3600 );

		$new = new Lock_Node( $dir, 60 );
		$this->assertTrue( $new->force_release() );
		$this->assertTrue( $new->acquire() );
	}

	public function test_force_release_skips_fresh_lock(): void {
		// Instance force_release MUST NOT steal a fresh lock.
		$dir = "{$this->tmp}/test.lock.d";
		mkdir( $dir, 0755, true );
		touch( "$dir/heartbeat", time() );

		$lock = new Lock_Node( $dir, 60 );
		$this->assertFalse( $lock->force_release() );
		$this->assertTrue( is_dir( $dir ) );
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

	// --- Restart channel ----------------------------------------------------

	public function test_should_restart_false_by_default(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$this->assertFalse( $lock->should_restart() );
	}

	public function test_request_restart_creates_flag_seen_by_should_restart(): void {
		$holder = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $holder->acquire() );

		// Different Lock instance pointing at the same path simulates an
		// external requester (REST endpoint, admin action, supervisor).
		$external = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $external->request_restart() );

		$this->assertTrue( $holder->should_restart() );
		$this->assertFileExists( "{$this->tmp}/test.lock.d/" . Lock_Node::RESTART_FLAG );
	}

	public function test_request_restart_returns_false_when_lock_dir_missing(): void {
		$lock = new Lock_Node( "{$this->tmp}/nonexistent.lock.d" );
		$this->assertFalse( $lock->request_restart() );
		$this->assertFalse( $lock->should_restart() );
	}

	public function test_request_restart_at_static_form(): void {
		$holder = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $holder->acquire() );

		// Static path-only API.
		$this->assertTrue( Lock_Node::request_restart_at( "{$this->tmp}/test.lock.d" ) );
		$this->assertTrue( $holder->should_restart() );
	}

	public function test_request_restart_at_returns_false_for_missing_dir(): void {
		$this->assertFalse( Lock_Node::request_restart_at( "{$this->tmp}/missing.lock.d" ) );
	}

	public function test_is_restart_pending_static(): void {
		$holder = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$holder->acquire();

		$this->assertFalse( Lock_Node::is_restart_pending( "{$this->tmp}/test.lock.d" ) );
		$holder->request_restart();
		$this->assertTrue( Lock_Node::is_restart_pending( "{$this->tmp}/test.lock.d" ) );
	}

	public function test_clear_restart_removes_flag(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$lock->request_restart();
		$this->assertTrue( $lock->should_restart() );

		$lock->clear_restart();
		$this->assertFalse( $lock->should_restart() );
		$this->assertFileDoesNotExist( "{$this->tmp}/test.lock.d/" . Lock_Node::RESTART_FLAG );
	}

	public function test_clear_restart_idempotent_when_no_flag_present(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$lock->clear_restart();
		$this->assertFalse( $lock->should_restart() );
	}

	public function test_release_implicitly_removes_restart_flag(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$lock->request_restart();
		$this->assertTrue( $lock->should_restart() );

		$lock->release();
		$this->assertFalse( $lock->should_restart() );
		$this->assertFalse( is_dir( "{$this->tmp}/test.lock.d" ) );
	}

	// --- PID-content theft detection ---------------------------------------

	public function test_should_restart_detects_heartbeat_pid_mismatch(): void {
		// Holder believes it has the lock. An external party overwrites the
		// heartbeat with a different PID. Holder's should_restart() returns true
		// so it exits cleanly and lets the supervisor respawn.
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );
		$this->assertFalse( $lock->should_restart() );

		// Simulate lock theft: another process writes its own PID over ours.
		file_put_contents(
			"{$this->tmp}/test.lock.d/heartbeat",
			(string) ( getmypid() + 99999 )
		);

		$this->assertTrue( $lock->should_restart() );
	}

	public function test_should_restart_detects_heartbeat_file_gone(): void {
		// Catastrophic case: heartbeat file deleted out from under us. Treat as
		// lock theft / orphan — exit clean.
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );
		unlink( "{$this->tmp}/test.lock.d/heartbeat" );

		$this->assertTrue( $lock->should_restart() );
	}

	public function test_should_restart_skips_pid_check_when_not_held(): void {
		// External-pointer Lock (didn't acquire): PID check shouldn't fire.
		// only the restart-flag check matters.
		$external = new Lock_Node( "{$this->tmp}/test.lock.d" );
		mkdir( "{$this->tmp}/test.lock.d", 0755, true );
		file_put_contents( "{$this->tmp}/test.lock.d/heartbeat", '99999' );

		$this->assertFalse( $external->should_restart() );
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

	public function test_acquire_takes_over_orphan_dir_after_grace(): void {
		// Lock dir exists but no heartbeat file (crash during creation).
		// After ORPHAN_GRACE_S seconds with no heartbeat appearing, acquire() steals it.
		// The grace is implemented as a real sleep() inside the production
		// code; phpunit.xml's `defaultTimeLimit` accommodates the wait.
		mkdir( "{$this->tmp}/orphan.lock.d", 0755, true );

		$lock = new Lock_Node( "{$this->tmp}/orphan.lock.d" );
		$this->assertTrue( $lock->acquire() );
		$this->assertFileExists( "{$this->tmp}/orphan.lock.d/heartbeat" );
	}

	// --- Path getter --------------------------------------------------------

	public function test_path_returns_lock_directory(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d" );
		$this->assertSame( "{$this->tmp}/test.lock.d", $lock->path() );
	}

	public function test_path_strips_trailing_slash(): void {
		$lock = new Lock_Node( "{$this->tmp}/test.lock.d/" );
		$this->assertSame( "{$this->tmp}/test.lock.d", $lock->path() );
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
		$this->assertSame( [], $schema['ctor'] );
		$this->assertSame( [], $schema['verbs'] );
	}
}
