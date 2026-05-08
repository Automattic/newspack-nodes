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
}
