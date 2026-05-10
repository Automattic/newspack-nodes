<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Lock;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( Lock::class )]
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
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );
		$this->assertTrue( is_dir( "{$this->tmp}/test.lock.d" ) );
		$this->assertTrue( $lock->is_held() );
	}

	public function test_acquire_writes_pid_to_heartbeat(): void {
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$this->assertSame(
			(string) getmypid(),
			file_get_contents( "{$this->tmp}/test.lock.d/heartbeat" )
		);
	}

	public function test_acquire_writes_started_timestamp(): void {
		$before = time();
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );

		$contents = file_get_contents( "{$this->tmp}/test.lock.d/started" );
		$this->assertNotFalse( $contents );
		$started = (int) $contents;
		$this->assertGreaterThanOrEqual( $before, $started );
		$this->assertLessThanOrEqual( time(), $started );
	}

	public function test_acquire_fails_when_already_held(): void {
		$a = new Lock( "{$this->tmp}/test.lock.d" );
		$b = new Lock( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $a->acquire() );
		$this->assertFalse( $b->acquire() );
	}

	public function test_release_removes_lock_directory(): void {
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$lock->release();
		$this->assertFalse( $lock->is_held() );
		$this->assertFalse( is_dir( "{$this->tmp}/test.lock.d" ) );
	}

	public function test_heartbeat_updates_mtime(): void {
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$hb = "{$this->tmp}/test.lock.d/heartbeat";
		$old = filemtime( $hb );
		sleep( 1 );
		$lock->heartbeat();
		clearstatcache();
		$this->assertGreaterThan( $old, filemtime( $hb ) );
	}

	public function test_force_release_breaks_stale_lock(): void {
		// Instance form: only releases if heartbeat is stale.
		$dir = "{$this->tmp}/test.lock.d";
		mkdir( $dir, 0755, true );
		touch( "$dir/heartbeat", time() - 3600 );

		$new = new Lock( $dir, 60 );
		$this->assertTrue( $new->force_release() );
		$this->assertTrue( $new->acquire() );
	}

	public function test_force_release_skips_fresh_lock(): void {
		// Instance force_release MUST NOT steal a fresh lock.
		$dir = "{$this->tmp}/test.lock.d";
		mkdir( $dir, 0755, true );
		touch( "$dir/heartbeat", time() );

		$lock = new Lock( $dir, 60 );
		$this->assertFalse( $lock->force_release() );
		$this->assertTrue( is_dir( $dir ) );
	}

	public function test_force_release_at_unconditionally_clears(): void {
		// Static form: clears regardless of staleness.
		$dir = "{$this->tmp}/test.lock.d";
		mkdir( $dir, 0755, true );
		touch( "$dir/heartbeat", time() ); // fresh — instance would skip.

		Lock::force_release_at( $dir );
		$this->assertFalse( is_dir( $dir ) );
	}

	public function test_force_release_at_no_op_on_missing_dir(): void {
		// Idempotent: clearing a nonexistent dir is a no-op (no exception).
		Lock::force_release_at( "{$this->tmp}/never.lock.d" );
		$this->assertTrue( true );
	}

	// Lock::with_lock() was removed — per-write callback locking was the wrong
	// abstraction (the user explicitly killed it). Locking now happens once at
	// allow_large_writes() time on the Partition, with a heartbeat Timer
	// keeping the lock fresh; see PartitionTest::test_allow_large_writes_*.

	// --- Restart channel ----------------------------------------------------

	public function test_should_restart_false_by_default(): void {
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$this->assertFalse( $lock->should_restart() );
	}

	public function test_request_restart_creates_flag_seen_by_should_restart(): void {
		$holder = new Lock( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $holder->acquire() );

		// Different Lock instance pointing at the same path simulates an
		// external requester (REST endpoint, admin action, supervisor).
		$external = new Lock( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $external->request_restart() );

		$this->assertTrue( $holder->should_restart() );
		$this->assertFileExists( "{$this->tmp}/test.lock.d/" . Lock::RESTART_FLAG );
	}

	public function test_request_restart_returns_false_when_lock_dir_missing(): void {
		$lock = new Lock( "{$this->tmp}/nonexistent.lock.d" );
		$this->assertFalse( $lock->request_restart() );
		$this->assertFalse( $lock->should_restart() );
	}

	public function test_request_restart_at_static_form(): void {
		$holder = new Lock( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $holder->acquire() );

		// Static path-only API.
		$this->assertTrue( Lock::request_restart_at( "{$this->tmp}/test.lock.d" ) );
		$this->assertTrue( $holder->should_restart() );
	}

	public function test_request_restart_at_returns_false_for_missing_dir(): void {
		$this->assertFalse( Lock::request_restart_at( "{$this->tmp}/missing.lock.d" ) );
	}

	public function test_is_restart_pending_static(): void {
		$holder = new Lock( "{$this->tmp}/test.lock.d" );
		$holder->acquire();

		$this->assertFalse( Lock::is_restart_pending( "{$this->tmp}/test.lock.d" ) );
		$holder->request_restart();
		$this->assertTrue( Lock::is_restart_pending( "{$this->tmp}/test.lock.d" ) );
	}

	public function test_clear_restart_removes_flag(): void {
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$lock->request_restart();
		$this->assertTrue( $lock->should_restart() );

		$lock->clear_restart();
		$this->assertFalse( $lock->should_restart() );
		$this->assertFileDoesNotExist( "{$this->tmp}/test.lock.d/" . Lock::RESTART_FLAG );
	}

	public function test_clear_restart_idempotent_when_no_flag_present(): void {
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$lock->clear_restart();
		$this->assertFalse( $lock->should_restart() );
	}

	public function test_release_implicitly_removes_restart_flag(): void {
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
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
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
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
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );
		unlink( "{$this->tmp}/test.lock.d/heartbeat" );

		$this->assertTrue( $lock->should_restart() );
	}

	public function test_should_restart_skips_pid_check_when_not_held(): void {
		// External-pointer Lock (didn't acquire): PID check shouldn't fire.
		// only the restart-flag check matters.
		$external = new Lock( "{$this->tmp}/test.lock.d" );
		mkdir( "{$this->tmp}/test.lock.d", 0755, true );
		file_put_contents( "{$this->tmp}/test.lock.d/heartbeat", '99999' );

		$this->assertFalse( $external->should_restart() );
	}

	// --- Started-time helper ------------------------------------------------

	public function test_get_started_time_returns_acquired_timestamp(): void {
		$before = time();
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$this->assertTrue( $lock->acquire() );

		$started = Lock::get_started_time( "{$this->tmp}/test.lock.d" );
		$this->assertNotNull( $started );
		$this->assertGreaterThanOrEqual( $before, $started );
		$this->assertLessThanOrEqual( time(), $started );
	}

	public function test_get_started_time_returns_null_for_missing_dir(): void {
		$this->assertNull( Lock::get_started_time( "{$this->tmp}/missing.lock.d" ) );
	}

	public function test_get_started_time_returns_null_when_file_missing(): void {
		// Lock dir exists but no started file (orphan from older code).
		mkdir( "{$this->tmp}/orphan.lock.d", 0755, true );
		file_put_contents( "{$this->tmp}/orphan.lock.d/heartbeat", '12345' );

		$this->assertNull( Lock::get_started_time( "{$this->tmp}/orphan.lock.d" ) );
	}

	// --- Grace period for orphan dirs ---------------------------------------

	public function test_acquire_takes_over_orphan_dir_after_grace(): void {
		// Lock dir exists but no heartbeat file (crash during creation).
		// After ORPHAN_GRACE_S seconds with no heartbeat appearing, acquire() steals it.
		mkdir( "{$this->tmp}/orphan.lock.d", 0755, true );

		$lock = new Lock( "{$this->tmp}/orphan.lock.d" );
		$this->assertTrue( $lock->acquire() );
		$this->assertFileExists( "{$this->tmp}/orphan.lock.d/heartbeat" );
	}

	// --- Path getter --------------------------------------------------------

	public function test_path_returns_lock_directory(): void {
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$this->assertSame( "{$this->tmp}/test.lock.d", $lock->path() );
	}

	public function test_path_strips_trailing_slash(): void {
		$lock = new Lock( "{$this->tmp}/test.lock.d/" );
		$this->assertSame( "{$this->tmp}/test.lock.d", $lock->path() );
	}
}
