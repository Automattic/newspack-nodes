<?php
namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\Lock_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Base;

class WorkerLifecycleTest extends TestCase {
	private string $tmp;

	/** @var \Closure|null Bootstrap-installed curl seam, restored in tearDown so the capturer can't leak. */
	private $saved_curl_exec;

	protected function setUp(): void {
		parent::setUp();
		// Start every drain from a clean event loop — the EF singleton accumulates
		// timers across the suite, and this test relies on several real ticks.
		Event_Framework::reset();
		$this->tmp             = $this->make_temp_dir();
		$this->saved_curl_exec = Core::$curl_exec;
	}

	protected function tearDown(): void {
		Core::$curl_exec = $this->saved_curl_exec;
		$this->rmdir_recursive( $this->tmp );
		parent::tearDown();
	}

	public function test_acquire_build_scaffolding_run_topology(): void {
		$w = new Worker_Base( $this->tmp, 'echo-test', 0 );
		$this->assertTrue( $w->acquire() );

		$interpreter = $w->build_scaffolding();

		$topology = function ( $interpreter, int $partition ) {
			$interpreter->dispatch( 'make_node', 'Capture_Sink echo' );
		};
		$w->run_topology( $topology, $interpreter );

		$this->assertNotNull( Core::node( 'echo' ) );

		$w->release();
	}

	public function test_execute_treats_worker_should_stop_as_a_clean_stop(): void {
		// execute() must treat a Worker_Should_Stop from the drain as a clean stop, not a crash.
		// max_runtime=5 is a backstop so a missed timer can't hang the suite.
		$w = new Worker_Base( $this->tmp, 'stop-test', 0, 5 );

		$topology = function ( $interpreter, int $partition ) {
			$timer = new class extends \Newspack_Nodes\Timer_Node {
				public function fire_cb(): void {
					throw new \Newspack_Nodes\Worker_Should_Stop();
				}
			};
			$timer->name( '_stop_timer' );
			$timer->set_timer( 1, true );
		};

		$result = $w->execute( $topology, '', '' );

		$this->assertSame( 'ok', $result['status'] );
		$this->assertFalse(
			\is_dir( "{$this->tmp}/locks/stop-test.p0.lock.d" ),
			'execute() released the lock during cooperative-stop teardown'
		);
	}

	/**
	 * Drive execute() through REAL drain ticks doing real work: a seeded partition
	 * is consumed by a real Consumer over several iterations of the event loop; the
	 * stop is a REAL condition (the stopper node drops the restart flag once both
	 * seeded messages land), with a 5s max_runtime backstop so a missed stop can't
	 * hang the suite. Then the full lifecycle is asserted observably — messages
	 * processed, IPC input checkpointed, lock released, self_respawn fired via the
	 * Core::$curl_exec seam.
	 */
	public function test_execute_drains_real_consumer_then_releases_lock_and_respawns(): void {
		// Capture self_respawn through the real raw-curl seam (not the bootstrap stub global).
		$posts = [];
		Core::$curl_exec = static function ( \CurlHandle $ch, array $body ) use ( &$posts ) {
			$posts[] = [
				'url'  => (string) \curl_getinfo( $ch, \CURLINFO_EFFECTIVE_URL ),
				'body' => $body,
			];
			return false;
		};

		// Pre-seed a partition with two messages for the worker's Consumer to process.
		$seed_dir = "{$this->tmp}/seed.p0";
		$seed     = new Partition_Node();
		$seed->arguments( $seed_dir );
		$this->produce_into( $seed, 'lifecycle-msg-1' );
		$this->produce_into( $seed, 'lifecycle-msg-2' );
		unset( $seed );

		$lock_path = "{$this->tmp}/locks/lifecycle-drain.p0.lock.d";
		$worker    = new Lifecycle_Worker( $this->tmp, 'lifecycle-drain', 0, 5 );

		// Hold the stopper outside the node registry — execute()'s shutdown handler
		// runs cleanup_all_nodes(), so Core::node('capture') is gone once it returns.
		$stopper = null;
		$topology = function ( $interpreter, int $partition ) use ( $seed_dir, $lock_path, &$stopper ): void {
			// Real stopper: captures forwarded messages and, once both seeded
			// messages have landed, drops the restart flag — the real stop condition.
			$stopper                    = new Lifecycle_Stopper_Node();
			$stopper->restart_lock_path = $lock_path;
			$stopper->stop_after        = 2;
			$stopper->name( 'capture' );

			// Real Consumer reading the seeded partition from offset 0, targeting the stopper.
			$consumer = $interpreter->make_node( 'Consumer', 'seed_reader', "{$seed_dir} {$this->tmp}/seed.offsets" );
			$consumer->target( 'capture' );
		};

		$result = $worker->execute( $topology, 'http://example/spawn', 'tok-drain' );

		$this->assertSame( 'ok', $result['status'] );

		// 1) Both seeded messages were actually processed through real drain ticks.
		$this->assertInstanceOf( Capture_Sink_Node::class, $stopper );
		$values = \array_map( static fn ( $m ) => $m[ Message::VALUE ], $stopper->captured );
		$this->assertSame( [ 'lifecycle-msg-1', 'lifecycle-msg-2' ], $values, 'the seeded messages were consumed via the real event loop' );

		// 2) The IPC input was checkpointed at shutdown (clean recycle, no replay).
		$this->assertSame( 1, $worker->ipc_checkpoint_calls, 'execute shutdown checkpoints the IPC input' );

		// 3) The lock dir was released so the next spawn can take over.
		$this->assertFalse( \is_dir( $lock_path ), 'execute released the worker lock' );

		// 4) self_respawn fired through the real curl seam with a spawn-compatible body.
		$this->assertCount( 1, $posts, 'self_respawn POSTed exactly once' );
		$this->assertSame( 'http://example/spawn', $posts[0]['url'] );
		$this->assertSame( 'lifecycle-drain', $posts[0]['body']['type'] );
		$this->assertSame( 0, $posts[0]['body']['partition'] );
		$this->assertSame( 'tok-drain', $posts[0]['body']['nonce'] );
	}
}

/** Worker fixture: counts IPC-input checkpoints so the test can assert the shutdown handoff ran. */
class Lifecycle_Worker extends Worker_Base {
	public int $ipc_checkpoint_calls = 0;

	public function checkpoint_ipc_input(): void {
		++$this->ipc_checkpoint_calls;
		parent::checkpoint_ipc_input();
	}
}

/** Capture sink that drops the worker's restart flag once $stop_after messages land — the real drain stop condition. */
class Lifecycle_Stopper_Node extends Capture_Sink_Node {
	public string $restart_lock_path = '';
	public int $stop_after           = 1;

	public function fill( array &$message ): void {
		parent::fill( $message );
		if ( \count( $this->captured ) >= $this->stop_after && '' !== $this->restart_lock_path ) {
			Lock_Node::request_restart_at( $this->restart_lock_path );
		}
	}
}
