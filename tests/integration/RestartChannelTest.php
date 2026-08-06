<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Base;

/**
 * Lock::request_restart → WorkerBase::should_continue=false integration test.
 *
 * Single restart channel: `Lock_Node::request_restart_at( $lock_dir )` drops a
 * `restart` file inside any locked process's lock dir, which that process picks
 * up from `Lock_Node::restart_reason()` on its next `should_continue()`. One
 * mechanism for every long-running process.
 */
class RestartChannelTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_worker_should_continue_returns_false_after_request_restart(): void {
		$worker = new Worker_Base( $this->tmp, 'restart-test', 0 );
		$this->assertTrue( $worker->acquire() );

		// Healthy state: should_continue passes.
		$this->assertTrue( $worker->should_continue() );

		// External requester drops the flag (e.g., a REST endpoint or admin action).
		$external = new Lock_Node( "{$this->tmp}/locks/restart-test.p0.lock.d" );
		$this->assertTrue( $external->request_restart_at( "{$this->tmp}/locks/restart-test.p0.lock.d" ) );

		// Worker's next drain-loop tick exits cleanly.
		$this->assertFalse( $worker->should_continue() );

		$worker->release();
	}

	public function test_worker_release_after_restart_signal_cleans_up_flag(): void {
		$worker = new Worker_Base( $this->tmp, 'restart-test', 0 );
		$worker->acquire();

		$external = new Lock_Node( "{$this->tmp}/locks/restart-test.p0.lock.d" );
		$external->request_restart_at( "{$this->tmp}/locks/restart-test.p0.lock.d" );

		$this->assertFalse( $worker->should_continue() );
		$worker->release();

		// Lock dir gone; restart flag implicitly cleared.
		$this->assertFalse( is_dir( "{$this->tmp}/locks/restart-test.p0.lock.d" ) );

		// A fresh worker can acquire and starts in a non-restart state.
		$next = new Worker_Base( $this->tmp, 'restart-test', 0 );
		$this->assertTrue( $next->acquire() );
		$this->assertTrue( $next->should_continue(), 'fresh worker must not inherit prior restart signal' );
		$next->release();
	}
}
