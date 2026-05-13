<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\SSE_Stream_Trait;
use PHPUnit\Framework\TestCase;

/**
 * Unit tests for SSE_Stream_Trait — the minimal Server-Sent Events
 * helper substrate REST controllers (currently just the topology
 * stream controller) use to emit SSE wire-format output.
 *
 * Behaviors under test (matched 1:1 with the trait's responsibilities):
 *  - send_sse_event() emits valid SSE `event:`/`data:` lines.
 *  - send_sse_event() sanitizes unsafe event names so a misbehaving
 *    caller can't inject control characters into the wire stream.
 *  - send_sse_event() marks needs_flush so the next flush_if_needed()
 *    pushes the bytes past proxy buffers.
 *  - flush_if_needed() emits a 4096-byte SSE comment when needs_flush
 *    is set and resets the flag.
 *  - flush_if_needed() is a no-op when needs_flush is false.
 */
final class SseStreamTraitTest extends TestCase {

	/**
	 * Build a minimal host class that uses the trait. Real consumers
	 * are REST controllers — but for the trait's contract we just need
	 * to invoke the protected methods and capture their stdout.
	 */
	private function host(): object {
		return new class {
			use SSE_Stream_Trait;

			public function call_send( string $event, array $payload ): string {
				\ob_start();
				$this->send_sse_event( $event, $payload );
				return (string) \ob_get_clean();
			}

			public function call_flush(): string {
				$this->needs_flush = true;
				\ob_start();
				$this->flush_if_needed();
				return (string) \ob_get_clean();
			}

			public function call_flush_no_op(): string {
				\ob_start();
				$this->flush_if_needed();
				return (string) \ob_get_clean();
			}

			public function read_needs_flush(): bool {
				return $this->needs_flush;
			}
		};
	}

	public function test_send_sse_event_emits_event_and_data_lines(): void {
		$out = $this->host()->call_send( 'hello', [ 'pid' => 42 ] );
		$this->assertStringContainsString( "event: hello\n", $out );
		$this->assertStringContainsString( 'data: {"pid":42}', $out );
		$this->assertStringEndsWith( "\n\n", $out );
	}

	public function test_send_sse_event_rejects_newlines_in_unsafe_event_name(): void {
		$out = $this->host()->call_send( "evil\nname", [ 'x' => 1 ] );
		// Newline stripped → safe.
		$this->assertStringNotContainsString( "evil\nname", $out );
		// What survives is the sanitized form ("evilname") on the event line.
		$this->assertStringContainsString( "event: evilname\n", $out );
	}

	public function test_send_sse_event_falls_back_to_msg_when_name_is_all_unsafe(): void {
		$out = $this->host()->call_send( "<<\n>>", [] );
		$this->assertStringContainsString( "event: msg\n", $out );
	}

	public function test_send_sse_event_marks_flush_needed(): void {
		$host = $this->host();
		$host->call_send( 'msg', [ 'k' => 'v' ] );
		$this->assertTrue( $host->read_needs_flush() );
	}

	public function test_flush_if_needed_emits_4kb_comment_when_set(): void {
		$host = $this->host();
		$out  = $host->call_flush();
		$this->assertSame( 4096, \strlen( $out ) );
		$this->assertStringStartsWith( ':', $out );
		$this->assertStringEndsWith( "\n\n", $out );
		$this->assertFalse( $host->read_needs_flush() );
	}

	public function test_flush_if_needed_is_noop_when_not_set(): void {
		$this->assertSame( '', $this->host()->call_flush_no_op() );
	}
}
