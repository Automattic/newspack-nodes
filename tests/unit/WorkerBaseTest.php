<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\WorkerBase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( WorkerBase::class )]
class WorkerBaseTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_acquire_creates_worker_lock(): void {
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$this->assertTrue( $w->acquire() );
		$this->assertTrue( is_dir( "{$this->tmp}/locks/test-worker.p0.lock.d" ) );
	}

	public function test_acquire_fails_when_already_held(): void {
		$a = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$b = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$this->assertTrue( $a->acquire() );
		$this->assertFalse( $b->acquire() );
	}

	public function test_release_removes_lock(): void {
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		$w->release();
		$this->assertFalse( is_dir( "{$this->tmp}/locks/test-worker.p0.lock.d" ) );
	}

	public function test_should_continue_returns_false_after_max_runtime(): void {
		$w = new TestableWorker( $this->tmp, 'test-worker', 0, max_runtime: 1 );
		$w->acquire();
		$w->set_start_time_for_test( microtime( true ) - 2.0 );
		$this->assertFalse( $w->should_continue() );
	}

	public function test_should_continue_returns_false_when_lock_lost(): void {
		$w = new TestableWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		$this->rmdir_recursive( "{$this->tmp}/locks/test-worker.p0.lock.d" );
		$this->assertFalse( $w->should_continue() );
	}
}

class TestableWorker extends WorkerBase {
	public function set_start_time_for_test( float $t ): void {
		$this->start_time = $t;
	}
}
