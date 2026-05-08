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
		$dir = "{$this->tmp}/test.lock.d";
		mkdir( $dir, 0755, true );
		touch( "$dir/heartbeat", time() - 3600 );

		$new = new Lock( $dir, 60 );
		$this->assertTrue( $new->force_release() );
		$this->assertTrue( $new->acquire() );
	}

	public function test_with_lock_acquires_runs_releases(): void {
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$ran  = false;
		$result = $lock->with_lock( function () use ( &$ran ) {
			$ran = true;
			return 'ok';
		} );
		$this->assertTrue( $ran );
		$this->assertSame( 'ok', $result );
		$this->assertFalse( $lock->is_held() );
	}

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

		// Holder polls; sees the flag.
		$this->assertTrue( $holder->should_restart() );
		$this->assertFileExists( "{$this->tmp}/test.lock.d/" . Lock::RESTART_FLAG );
	}

	public function test_request_restart_returns_false_when_lock_dir_missing(): void {
		// Brand-new Lock object pointing at a path that hasn't been acquired.
		$lock = new Lock( "{$this->tmp}/nonexistent.lock.d" );
		$this->assertFalse( $lock->request_restart() );
		$this->assertFalse( $lock->should_restart() );
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
		// No request_restart yet — clear is a no-op.
		$lock->clear_restart();
		$this->assertFalse( $lock->should_restart() );
	}

	public function test_release_implicitly_removes_restart_flag(): void {
		$lock = new Lock( "{$this->tmp}/test.lock.d" );
		$lock->acquire();
		$lock->request_restart();
		$this->assertTrue( $lock->should_restart() );

		// release() removes the entire lock dir, taking the flag with it.
		$lock->release();
		$this->assertFalse( $lock->should_restart() );
		$this->assertFalse( is_dir( "{$this->tmp}/test.lock.d" ) );
	}
}
