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

	public function test_should_continue_passes_when_db_check_succeeds(): void {
		$w = new DbCheckWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		// Force a db-check window by backdating last_db_check.
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$w->set_db_check_result( true );
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 0, $w->get_db_failures_for_test() );
	}

	public function test_should_continue_returns_false_after_three_consecutive_db_failures(): void {
		$w = new DbCheckWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		$w->set_db_check_result( false );

		// 1st failure.
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 1, $w->get_db_failures_for_test() );

		// 2nd failure.
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 2, $w->get_db_failures_for_test() );

		// 3rd failure → trip.
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertFalse( $w->should_continue() );
		$this->assertSame( 3, $w->get_db_failures_for_test() );
	}

	public function test_should_continue_resets_db_failures_on_intermittent_pass(): void {
		$w = new DbCheckWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();

		// Failure.
		$w->set_db_check_result( false );
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 1, $w->get_db_failures_for_test() );

		// Pass — counter resets.
		$w->set_db_check_result( true );
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 0, $w->get_db_failures_for_test() );

		// Another failure — does NOT trip (counter started fresh).
		$w->set_db_check_result( false );
		$w->set_last_db_check_for_test( microtime( true ) - 31.0 );
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 1, $w->get_db_failures_for_test() );
	}

	public function test_should_continue_skips_db_check_within_interval(): void {
		$w = new DbCheckWorker( $this->tmp, 'test-worker', 0 );
		$w->acquire();
		$w->set_db_check_result( false );
		// last_db_check is "now" from acquire(); db_check should not run.
		$this->assertTrue( $w->should_continue() );
		$this->assertSame( 0, $w->get_db_failures_for_test(), 'within interval: db_check must not run' );
	}
}

class TestableWorker extends WorkerBase {
	public function set_start_time_for_test( float $t ): void {
		$this->start_time = $t;
	}
}

class DbCheckWorker extends WorkerBase {
	private bool $db_pass = true;

	public function set_db_check_result( bool $pass ): void {
		$this->db_pass = $pass;
	}

	public function set_last_db_check_for_test( float $t ): void {
		$this->last_db_check = $t;
	}

	public function get_db_failures_for_test(): int {
		return $this->db_failures;
	}

	protected function db_check_passes(): bool {
		return $this->db_pass;
	}
}
