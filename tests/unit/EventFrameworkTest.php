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
}
