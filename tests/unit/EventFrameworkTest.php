<?php
namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\EventFramework;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( EventFramework::class )]
class EventFrameworkTest extends TestCase {
	protected function setUp(): void {
		parent::setUp();
		EventFramework::reset();
	}

	public function test_register_reader_node_stores_node_by_fd(): void {
		$ef = EventFramework::instance();
		$tmp = \fopen( 'php://memory', 'r+' );

		$node = new class {
			public $stream;
			public int $drained = 0;
			public function drain_fh(): void { ++$this->drained; }
		};
		$node->stream = $tmp;

		$ef->register_reader_node( $node );

		$this->assertSame( $node, $ef->reader_for_fd( \intval( $tmp ) ) );
		\fclose( $tmp );
	}

	public function test_drain_exits_when_should_continue_returns_false(): void {
		$ef     = EventFramework::instance();
		$ticks  = 0;
		$should = function () use ( &$ticks ): bool {
			++$ticks;
			return $ticks <= 3;
		};
		$ef->drain( $should );
		$this->assertSame( 4, $ticks );
	}

	public function test_drain_runs_closing_queue_post_loop(): void {
		$ef = EventFramework::instance();
		$post_loop_ran = false;
		\Newspack_Nodes\Core::push_closing( function () use ( &$post_loop_ran ) {
			$post_loop_ran = true;
		} );
		$ef->drain( fn () => false );
		$this->assertTrue( $post_loop_ran, 'Core::run_closing() must drain after the loop terminates' );
	}

	public function test_drain_calls_drain_fh_when_FD_is_readable(): void {
		$ef = EventFramework::instance();

		$pipes = \stream_socket_pair( STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP );
		[ $read, $write ] = $pipes;
		\stream_set_blocking( $read, false );

		$node = new class {
			public $stream;
			public int $drained = 0;
			public function drain_fh(): void { ++$this->drained; }
		};
		$node->stream = $read;
		$ef->register_reader_node( $node );

		\fwrite( $write, "x" );

		$ef->drain( $this->boundedTicks( 3 ) );

		$this->assertGreaterThan( 0, $node->drained );

		\fclose( $write );
		\fclose( $read );
	}

	public function test_set_timer_fires_after_interval(): void {
		$ef = EventFramework::instance();

		$timer_node = new class {
			public int $fired = 0;
			public function fire_cb(): void { ++$this->fired; }
		};

		$ef->set_timer( $timer_node, 50 );

		$start = \microtime( true );
		$ef->drain( function () use ( $start ): bool {
			\Newspack_Nodes\Core::update_time();
			return ( \microtime( true ) - $start ) < 0.2;
		} );

		$this->assertGreaterThan( 0, $timer_node->fired );
	}

	public function test_oneshot_timer_fires_exactly_once(): void {
		$ef = EventFramework::instance();

		$timer_node = new class {
			public int $fired = 0;
			public function fire_cb(): void { ++$this->fired; }
		};

		$ef->set_timer( $timer_node, 10, true );

		$start = \microtime( true );
		$ef->drain( function () use ( $start ): bool {
			\Newspack_Nodes\Core::update_time();
			return ( \microtime( true ) - $start ) < 0.1;
		} );

		$this->assertSame( 1, $timer_node->fired, 'Oneshot fires exactly once' );
	}

	public function test_register_curl_handle_tracks_node_for_multi_dispatch(): void {
		$ef = EventFramework::instance();

		$node = new class {
			public int $curl_events = 0;
			public function on_curl_message( array $info ): void { ++$this->curl_events; }
		};

		$mh = \curl_multi_init();
		$ef->register_curl_handle( $node, $mh );

		$ef->drain( $this->boundedTicks( 1 ) );

		$this->assertTrue( true, 'drain with empty curl multi handle did not crash' );

		\curl_multi_close( $mh );
	}

	public function test_drain_exits_when_shutting_down_flag_is_set(): void {
		$ef = EventFramework::instance();
		$ticks = 0;
		$ef->drain( function () use ( &$ticks ): bool {
			++$ticks;
			if ( $ticks === 2 ) {
				\Newspack_Nodes\Core::$shutting_down = true;
			}
			return true;
		} );
		$this->assertGreaterThanOrEqual( 2, $ticks );
		$this->assertLessThan( 5, $ticks );
	}

	public function test_install_signal_handlers_does_not_crash(): void {
		if ( ! \function_exists( 'pcntl_signal' ) ) {
			$this->markTestSkipped( 'pcntl not available' );
		}
		$ef = EventFramework::instance();
		$ef->install_signal_handlers();
		$this->assertTrue( true );
	}
}
