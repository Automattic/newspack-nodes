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

use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;
use Newspack_Nodes\Rest\Messages_Stream_Controller;
use Newspack_Nodes\Tests\TestCase;
use PHPUnit\Framework\Attributes\CoversClass;
use PHPUnit\Framework\Attributes\Medium;

#[CoversClass( Messages_Stream_Controller::class )]
#[Medium]
class MessagesStreamControllerTest extends TestCase {

	public function test_stream_emits_connected_then_msg_for_each_log_line(): void {
		$base = $this->make_temp_dir( 'msg-stream-int-' );
		\mkdir( "{$base}/logs/firehose.log", 0755, true );

		// Pre-populate the firehose log with two TM_BYTESTREAM lines so the
		// Consumer has something to drain. Use Partition::fill directly with
		// a constructed Message (matches how Partition writes data on disk).
		$p     = new Partition( "{$base}/logs/firehose.log", 0 );
		$line1 = Message::new_message();
		$line1[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$line1[ Message::VALUE ] = "line-one\n";
		$p->fill( $line1 );
		$line2 = Message::new_message();
		$line2[ Message::TYPE ]  = Message::TM_BYTESTREAM;
		$line2[ Message::VALUE ] = "line-two\n";
		$p->fill( $line2 );
		$p->flush();

		$ctrl = new Messages_Stream_Controller();
		$ctrl->set_base_dir( $base );
		$ctrl->set_num_partitions( 1 );
		$ctrl->set_test_mode( true );
		$ctrl->set_test_iterations( 5 );

		\ob_start();
		$ctrl->run_stream_loop( [ 'firehose' ], null, 500 );
		$out = \ob_get_clean();

		$events = $this->split_sse_events( $out );
		$this->assertGreaterThanOrEqual( 1, \count( $events ) );

		// First event should be connected.
		$this->assertSame( 'msg', $events[0]['event'] );
		$first = \json_decode( $events[0]['data'], true );
		$this->assertSame( 'connected', $first[ Message::KEY ] );
		$this->assertArrayHasKey( 'pid', $first[ Message::VALUE ] );

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
