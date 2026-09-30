<?php
/**
 * `CLI::open_channel()`: a worker's command channel, whose reply leg keeps only
 * the replies addressed `_output/_cli:<session>/…`, to the session that opened it.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\CLI;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\HTTP_Filter_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Tests\Capture_Sink_Node;
use Newspack_Nodes\Tests\TestCase;
use Newspack_Nodes\Worker_Base;
use PHPUnit\Framework\Attributes\CoversClass;

#[CoversClass( CLI::class )]
final class CliOpenChannelTest extends TestCase {
	private string $base = '';

	protected function setUp(): void {
		parent::setUp();
		$this->base = $this->make_temp_dir( 'open-channel-' );
		$this->use_base_dir( $this->base );
		$this->use_loop_time();
	}

	protected function tearDown(): void {
		Core::cleanup_all_nodes();
		$this->rmdir_recursive( $this->base );
		parent::tearDown();
	}

	/**
	 * Open a channel for session `$session` on a worker, have the worker append
	 * one reply per `$tos` entry to its output, and return what reached the
	 * replies node.
	 *
	 * @param list<string> $tos        TO of each reply the worker writes.
	 * @param string       $session    Session id the channel is opened for.
	 * @param int          $expected   How many replies the drain waits for.
	 * @param string       $target     The gate's target, '' for none.
	 * @return list<string> The TO of each reply that got through.
	 */
	private function delivered( array $tos, string $session, int $expected, string $target = 'dumper-5520' ): array {
		$ipc = [
			'id'     => 'kea-t.p0',
			'input'  => Worker_Base::ipc_dir( $this->base, 'kea-t', 0, Worker_Base::IPC_INPUT ),
			'output' => Worker_Base::ipc_dir( $this->base, 'kea-t', 0, Worker_Base::IPC_OUTPUT ),
		];
		\mkdir( $ipc['input'], 0755, true );
		\mkdir( $ipc['output'], 0755, true );
		$replies = new Capture_Sink_Node();
		$nodes   = CLI::open_channel( $ipc, new Capture_Sink_Node(), $replies, $session );
		if ( '' !== $target ) {
			$nodes[2]->target( $target );
		}
		$worker  = new Partition_Node();
		$worker->arguments( Worker_Base::ipc_partition_args( $ipc['output'] ) );
		$worker->sink( new Capture_Sink_Node() );
		foreach ( $tos as $i => $to ) {
			$reply                     = Message::new_message();
			$reply[ Message::TYPE ]    = Message::TM_BYTESTREAM;
			$reply[ Message::TO ]      = $to;
			$reply[ Message::VALUE ]   = "reply-{$i}";
			$worker->fill( $reply );
		}
		// One past the expected count, so a wrongly passed reply lands too.
		$deadline = Core::right_now() + 2;
		Event_Framework::instance()->drain(
			fn (): bool => \count( $replies->captured ) <= $expected && Core::$now < $deadline
		);
		$got = \array_map( fn ( array $m ) => Core::as_string( $m[ Message::TO ] ), $replies->captured );
		foreach ( \array_reverse( $nodes ) as $node ) {
			$node->remove_node();
		}
		$worker->remove_node();
		return $got;
	}

	public function test_passes_our_head_stripped_and_drops_another_sessions(): void {
		$got = $this->delivered( [ '_output/_cli:48211/_output', '_output/_cli:73519/_output' ], '73519', 1 );
		$this->assertSame( [ '_output' ], $got );
	}

	public function test_drops_a_reply_whose_tail_names_our_session_under_another_head(): void {
		$got = $this->delivered( [ '_output/_cli:48211/_output/73519', '_output/73519', 'recv/sku-9/73519', '_output/_cli:73519/recv/sku-9' ], '73519', 1 );
		$this->assertSame( [ 'recv/sku-9' ], $got );
	}

	public function test_passes_an_unaddressed_broadcast_to_the_gates_target(): void {
		$got = $this->delivered( [ '', '_output/_cli:48211/_output' ], '73519', 1 );
		$this->assertSame( [ 'dumper-5520' ], $got );
	}

	public function test_drops_an_unaddressed_broadcast_when_the_gate_has_no_target(): void {
		$got = $this->delivered( [ '', '_output/_cli:73519/_output' ], '73519', 1, '' );
		$this->assertSame( [ '_output' ], $got );
	}

	public function test_does_not_match_a_session_id_that_merely_ends_alike(): void {
		$got = $this->delivered( [ '_output/_cli:473519/_output', '_output/_cli:73519/_output' ], '73519', 1 );
		$this->assertSame( [ '_output' ], $got );
	}

	public function test_the_gate_is_a_named_session_gate_on_the_workers_replies(): void {
		$ipc  = [
			'id'     => 'kea-t.p3',
			'input'  => Worker_Base::ipc_dir( $this->base, 'kea-t', 3, Worker_Base::IPC_INPUT ),
			'output' => Worker_Base::ipc_dir( $this->base, 'kea-t', 3, Worker_Base::IPC_OUTPUT ),
		];
		\mkdir( $ipc['input'], 0755, true );
		\mkdir( $ipc['output'], 0755, true );
		$replies = new Capture_Sink_Node();

		[ , , $gate ] = CLI::open_channel( $ipc, new Capture_Sink_Node(), $replies, '61403' );

		$this->assertInstanceOf( HTTP_Filter_Node::class, $gate );
		$this->assertSame( 'kea-t.p3:replies', $gate->name() );
		$this->assertSame( $gate, Core::node( 'kea-t.p3:replies' ) );
		$this->assertSame( $replies, $gate->sink() );
	}

	public function test_reply_head_is_the_output_boundary_then_the_cli_session(): void {
		$this->assertSame( '_output/_cli:61403', CLI::reply_head( '61403' ) );
	}
}
