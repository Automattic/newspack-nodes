<?php
/**
 * Integration coverage for the M5-cutover SSE controller's drain loop.
 *
 * Task 18 — the route registration, CSV splitter, and subscription
 * resolver are covered by the Task-17 unit suite. This file exercises
 * the drain-loop body itself: `connected` envelope, then per-line
 * forwarding from log-partition Consumers wired into the SSE-process
 * substrate graph (Router + HTTP_Filter + Callback sink).
 *
 * @package Newspack_Nodes
 */

declare(strict_types=1);

namespace Newspack_Nodes\Tests\Integration;

use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\Medium;

#[CoversClass( SSE_Out_Node::class )]
#[Medium]
class SSEOutTest extends TestCase {

	public function test_fill_emits_msg_event_and_increments_counter(): void {
		// SSE_Out is double-duty: as a Node, fill() emits the Message as a
		// single `msg` SSE event and bumps the counter (the egress writer
		// HTTP_Filter sinks into).
		$ctrl                  = new SSE_Out_Node();
		$msg                   = Message::new_message();
		$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$msg[ Message::TO ]    = '_output';
		$msg[ Message::VALUE ] = 'hello';

		\ob_start();
		$ctrl->fill( $msg );
		$out = \ob_get_clean();

		$this->assertSame( 1, $ctrl->counter() );
		$events = $this->split_sse_events( $out );
		$this->assertCount( 1, $events );
		$this->assertSame( 'msg', $events[0]['event'] );
		$decoded = \json_decode( $events[0]['data'], true );
		$this->assertSame( 'hello', $decoded[ Message::VALUE ] );
		$this->assertSame( '_output', $decoded[ Message::TO ] );
	}

	public function test_stream_emits_connected_then_msg_for_each_log_line(): void {
		$base = $this->make_temp_dir( 'msg-stream-int-' );
		\mkdir( "{$base}/logs/firehose.log", 0755, true );

		// Pre-populate the firehose log with two TM_BYTESTREAM lines so the
		// Consumer has something to drain. Use Partition::fill directly with
		// a constructed Message (matches how Partition writes data on disk).
		$p     = new Partition_Node( "{$base}/logs/firehose.log", 0 );
		$line1 = Message::new_message();
		$line1[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$line1[ Message::VALUE ] = "line-one\n";
		$p->fill( $line1 );
		$line2 = Message::new_message();
		$line2[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$line2[ Message::VALUE ] = "line-two\n";
		$p->fill( $line2 );
		$p->flush();

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		$ctrl->set_num_partitions( 1 );
		$ctrl->set_test_mode( true );
		// 20 ticks is enough for the Consumer's busy-poll cycle to seek to
		// 'start', read both lines, emit them through the sink, and let the
		// SSE writes hit the captured stdout buffer.
		$ctrl->set_test_iterations( 20 );

		\ob_start();
		// Per-subscription positions, keyed first by subscription name then
		// by partition index (matches `open_subscription`'s `$positions[$p]`
		// loop). 'start' is a magic value `Consumer::next_offset` accepts
		// (cursor → seg 0 / off 0). Without this, the Consumer tail-seeks
		// via 'end' and the two pre-populated lines never reach the SSE
		// output — the test passes without exercising line forwarding.
		$ctrl->run_stream_loop( [ 'firehose' ], [ 'firehose' => [ 0 => 'start' ] ], 500 );
		$out = \ob_get_clean();

		$events = $this->split_sse_events( $out );
		// connected + line-one + line-two = at least 3 events.
		$this->assertGreaterThanOrEqual( 3, \count( $events ) );

		// First event should be connected.
		$this->assertSame( 'msg', $events[0]['event'] );
		$first = \json_decode( $events[0]['data'], true );
		$this->assertSame( 'connected', $first[ Message::KEY ] );
		$this->assertArrayHasKey( 'pid', $first[ Message::VALUE ] );

		// Subsequent events carry the line-one / line-two VALUEs. Each
		// TM_BYTESTREAM message the Consumer emits gets JSON-encoded into
		// a single SSE `msg` event.
		$values = [];
		foreach ( \array_slice( $events, 1 ) as $ev ) {
			$decoded = \json_decode( $ev['data'], true );
			if ( \is_array( $decoded ) && isset( $decoded[ Message::VALUE ] ) ) {
				$values[] = $decoded[ Message::VALUE ];
			}
		}
		$this->assertContains( "line-one\n", $values );
		$this->assertContains( "line-two\n", $values );

		$this->rmdir_recursive( $base );
	}

	/**
	 * The stream MUST emit flush padding (a FLUSH_SIZE-byte SSE comment) so
	 * payloads are pushed through fastcgi/nginx buffers rather than sitting
	 * buffered — without it, opening the stream URL shows nothing until ~4KB
	 * of real data accumulates. flush_if_needed() must run in the drain loop.
	 */
	public function test_stream_flushes_buffers_with_padding(): void {
		$base = $this->make_temp_dir( 'msg-stream-flush-' );
		\mkdir( "{$base}/logs/firehose.log", 0755, true );

		$p    = new Partition_Node( "{$base}/logs/firehose.log", 0 );
		$line = Message::new_message();
		$line[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$line[ Message::VALUE ] = "payload\n";
		$p->fill( $line );
		$p->flush();

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		$ctrl->set_num_partitions( 1 );
		$ctrl->set_test_mode( true );
		$ctrl->set_test_iterations( 20 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose' ], [ 'firehose' => [ 0 => 'start' ] ], 500 );
		$out = \ob_get_clean();

		$this->assertStringContainsString(
			':' . \str_repeat( '.', 200 ),
			$out,
			'expected a flush-padding SSE comment to push buffered payloads through'
		);

		$this->rmdir_recursive( $base );
	}

	/**
	 * A subscription that throws (e.g. path-traversal `../etc/passwd`) MUST
	 * NOT leave `_router`, `_http`, or `_stream_sink` registered in the
	 * substrate. If it does, the next SSE request hits `node name collision:
	 * _router already registered` on `Router->name('_router')` and every
	 * subsequent stream blows up until the process recycles.
	 */
	public function test_invalid_subscription_does_not_leak_substrate_nodes(): void {
		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $this->make_temp_dir( 'msg-stream-leak-' ) );
		$ctrl->set_num_partitions( 1 );
		$ctrl->set_test_mode( true );
		$ctrl->set_test_iterations( 5 );

		try {
			\ob_start();
			$ctrl->run_stream_loop( [ '../etc/passwd' ], null, 500 );
			$this->fail( 'expected InvalidArgumentException' );
		} catch ( \InvalidArgumentException $e ) {
			// expected
		} finally {
			\ob_get_clean();
		}

		$this->assertNull( Core::node( '_router' ) );
		$this->assertNull( Core::node( '_http' ) );
		$this->assertNull( Core::node( '_stream_sink' ) );
	}

	public function test_stream_emits_heartbeat_events_during_idle(): void {
		// Empty firehose dir so no data lines compete with heartbeats — any
		// `heartbeat` event in the captured output came from the drain loop
		// itself, not from a forwarded message.
		$base = $this->make_temp_dir( 'msg-stream-heartbeat-' );
		\mkdir( "{$base}/logs/firehose.log", 0755, true );

		$ctrl = new SSE_Out_Node();
		$ctrl->set_base_dir( $base );
		$ctrl->set_num_partitions( 1 );
		$ctrl->set_test_mode( true );
		// 50 ticks over a 1ms heartbeat interval is enough wall time for at
		// least one heartbeat to fire (real time advances between ticks).
		$ctrl->set_test_iterations( 50 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose' ], [ 'firehose' => [ 0 => 'start' ] ], 1 );
		$out = \ob_get_clean();

		$events    = $this->split_sse_events( $out );
		$heartbeat = \array_filter( $events, static fn ( $e ) => 'heartbeat' === $e['event'] );
		$this->assertNotEmpty(
			$heartbeat,
			'drain loop should emit at least one `heartbeat` SSE event so dashboards can detect a live but idle stream'
		);

		$this->rmdir_recursive( $base );
	}

	/**
	 * Parse `event: X\ndata: Y\n\n` SSE chunks from a captured stdout
	 * buffer. Skips empty chunks and comment-only flush filler lines.
	 *
	 * @return array<int, array{event: string, data: string}>
	 */
	private function split_sse_events( string $raw ): array {
		$out = [];
		foreach ( \explode( "\n\n", \trim( $raw ) ) as $chunk ) {
			$chunk = \trim( $chunk );
			if ( '' === $chunk || \str_starts_with( $chunk, ':' ) ) {
				continue;
			}
			$ev   = null;
			$data = null;
			foreach ( \explode( "\n", $chunk ) as $line ) {
				if ( \str_starts_with( $line, 'event: ' ) ) {
					$ev = \substr( $line, 7 );
				}
				if ( \str_starts_with( $line, 'data: ' ) ) {
					$data = \substr( $line, 6 );
				}
			}
			if ( null !== $ev && null !== $data ) {
				$out[] = [
					'event' => $ev,
					'data'  => $data,
				];
			}
		}
		return $out;
	}
}
