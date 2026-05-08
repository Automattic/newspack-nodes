<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\SupervisorBase;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( SupervisorBase::class )]
class SupervisorBaseTest extends TestCase {
	private string $tmp;

	protected function setUp(): void {
		parent::setUp();
		$this->tmp = $this->make_temp_dir();
	}

	protected function tearDown(): void {
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_worker_needs_spawn_when_no_lock(): void {
		$s = new SupervisorBase( $this->tmp );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertTrue( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	public function test_worker_does_not_need_spawn_when_lock_fresh(): void {
		$s = new SupervisorBase( $this->tmp );
		mkdir( "{$this->tmp}/locks/foo.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/foo.p0.lock.d/heartbeat" );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertFalse( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	public function test_worker_needs_spawn_when_heartbeat_stale(): void {
		$s = new SupervisorBase( $this->tmp );
		mkdir( "{$this->tmp}/locks/foo.p0.lock.d", 0755, true );
		touch( "{$this->tmp}/locks/foo.p0.lock.d/heartbeat", time() - 3600 );
		$worker = [ 'type' => 'foo', 'partition' => 0, 'stale_timeout' => 60 ];
		$this->assertTrue( $s->worker_needs_spawn( $worker, microtime( true ) ) );
	}

	public function test_spawn_rate_limit_skips_recent_spawns(): void {
		$s = new SupervisorBase( $this->tmp );
		$now = microtime( true );
		$s->record_spawn( 'foo', 0, $now - 5 );
		$this->assertTrue( $s->is_recently_spawned( 'foo', 0, $now ) );
		$this->assertFalse( $s->is_recently_spawned( 'foo', 0, $now + 20 ) );
	}
}
