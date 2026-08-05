<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use PHPUnit\Framework\TestCase;
use Newspack_Nodes\Rest\SSE_Out_Node;

/**
 * Unit tests for SSE_Out_Node's inlined Server-Sent Events wire helpers —
 * the minimal SSE-emitting substrate the `/messages/stream` controller uses
 * to write SSE wire-format output. (These helpers formerly lived in the
 * deleted SSE_Stream_Trait; they were inlined when SSE_Out_Node became the
 * trait's sole consumer.)
 *
 * Behaviors under test (matched 1:1 with the helpers' responsibilities):
 *  - init_sse_headers() drains every active output buffer (so the SSE
 *    stream isn't held back by anything between PHP and the client).
 *  - send_sse_event() emits valid SSE `event:`/`data:` lines.
 *  - send_sse_event() sanitizes unsafe event names so a misbehaving
 *    caller can't inject control characters into the wire stream.
 *  - send_sse_event() marks needs_flush so the next flush_if_needed()
 *    pushes the bytes past proxy buffers.
 *  - flush_if_needed() emits a 4096-byte SSE comment when needs_flush
 *    is set and resets the flag.
 *  - flush_if_needed() is a no-op when needs_flush is false.
 */
final class SseOutStreamHelpersTest extends TestCase {

	/**
	 * Build an anonymous SSE_Out_Node subclass exposing the now-protected
	 * SSE helper methods. SSE_Out_Node's node_schema() declares no
	 * handler-bearing verbs, so the base ctor builds no sibling interpreter
	 * and registers no node — construction is inert for a pure unit test.
	 */
	private function host(): object {
		return new class() extends SSE_Out_Node {

			public function call_send( string $event, array $payload ): string {
				\ob_start();
				try {
					$this->send_sse_event( $event, $payload );
				} finally {
					$out = (string) \ob_get_clean();
				}
				return $out;
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

			/**
			 * Expose init_sse_headers() to the test. PHPUnit's CLI runner
			 * has already emitted output by the time we get here, so the
			 * method's `header()` calls trigger "headers already sent"
			 * warnings. The method deliberately doesn't `@`-suppress them
			 * (the calls are no-ops in the real REST environment where
			 * headers are still pending). PHPUnit's error handler respects
			 * the suppression operator, so wrapping with `@` here keeps
			 * the test from being flagged risky / warning-emitting.
			 */
			public function call_init_sse_headers(): void {
				@$this->init_sse_headers();
			}
		};
	}

	// ── send_sse_event ─────────────────────────────────────────────────────

	public function test_send_sse_event_emits_event_and_data_lines(): void {
		$out = $this->host()->call_send( 'hello', [ 'pid' => 42 ] );
		$this->assertStringContainsString( "event: hello\n", $out );
		$this->assertStringContainsString( 'data: {"pid":42}', $out );
		$this->assertStringEndsWith( "\n\n", $out );
	}

	public function test_send_sse_event_accepts_all_safe_events(): void {
		// SAFE_EVENTS = hello / msg / heartbeat / connected / timeout.
		// Each must flow through verbatim with no sanitization.
		$safe = [ 'hello', 'msg', 'heartbeat', 'connected', 'timeout' ];
		foreach ( $safe as $name ) {
			$out = $this->host()->call_send( $name, [] );
			$this->assertStringContainsString(
				"event: {$name}\n",
				$out,
				"safe event '{$name}' must not be mangled"
			);
		}
	}

	public function test_send_sse_event_rejects_newlines_in_unsafe_event_name(): void {
		$out = $this->host()->call_send( "evil\nname", [ 'x' => 1 ] );
		// Newline stripped → safe.
		$this->assertStringNotContainsString( "evil\nname", $out );
		// What survives is the sanitized form ("evilname") on the event line.
		$this->assertStringContainsString( "event: evilname\n", $out );
		// Critical: only ONE `event:` header line in the payload (no injection).
		$this->assertSame( 1, \substr_count( $out, 'event:' ) );
	}

	public function test_send_sse_event_strips_colon_and_space_from_unsafe_name(): void {
		// Spaces and colons inside an unsafe name would break SSE framing —
		// they must collapse out via /[^A-Za-z0-9_-]/.
		$out = $this->host()->call_send( 'bogus event: poison', [] );
		$this->assertStringContainsString( 'event: bogusevent', $out );
		$this->assertSame( 1, \substr_count( $out, 'event:' ) );
	}

	public function test_send_sse_event_throws_when_name_is_all_unsafe(): void {
		// A name that sanitizes to empty is a caller bug — fail loud rather
		// than emit a nameless `event:` line.
		$this->expectException( \InvalidArgumentException::class );
		$this->host()->call_send( "<<\n>>", [] );
	}

	public function test_send_sse_event_throws_when_name_is_empty(): void {
		$this->expectException( \InvalidArgumentException::class );
		$this->host()->call_send( '', [] );
	}

	public function test_send_sse_event_preserves_underscore_and_hyphen_in_unsafe_name(): void {
		// /[^A-Za-z0-9_-]/ keeps underscores and hyphens (used by app event names).
		$out = $this->host()->call_send( 'my_event-name@bogus', [] );
		$this->assertStringContainsString( "event: my_event-namebogus\n", $out );
	}

	public function test_send_sse_event_marks_flush_needed(): void {
		$host = $this->host();
		$host->call_send( 'msg', [ 'k' => 'v' ] );
		$this->assertTrue( $host->read_needs_flush() );
	}

	public function test_send_sse_event_json_encodes_payload(): void {
		// Nested arrays + strings must round-trip through wp_json_encode untouched.
		$out = $this->host()->call_send(
			'connected',
			[ 'slot' => 3, 'meta' => [ 'a' => 1, 'b' => 'x' ] ]
		);
		$matches = [];
		\preg_match( '/data: (.+)\n\n/', $out, $matches );
		$this->assertNotEmpty( $matches );
		$this->assertSame(
			[ 'slot' => 3, 'meta' => [ 'a' => 1, 'b' => 'x' ] ],
			\json_decode( $matches[1], true )
		);
	}

	public function test_send_sse_event_emits_empty_payload_as_empty_object(): void {
		$out = $this->host()->call_send( 'heartbeat', [] );
		// PHP's json_encode on empty array yields `[]` (not `{}`), and that's
		// the wire shape the helper emits. Lock the contract so a regression
		// to associative encoding doesn't surprise the JS client.
		$this->assertStringContainsString( "data: []\n\n", $out );
	}

	// ── flush_if_needed ────────────────────────────────────────────────────

	public function test_flush_if_needed_emits_4kb_comment_when_set(): void {
		$host = $this->host();
		$out  = $host->call_flush();
		$this->assertSame( 4096, \strlen( $out ) );
		$this->assertStringStartsWith( ':', $out );
		$this->assertStringEndsWith( "\n\n", $out );
		$this->assertFalse( $host->read_needs_flush() );
	}

	public function test_flush_if_needed_emits_exact_dot_payload(): void {
		// Wire-format assertion: `:` + 4093 dots + `\n\n` = 4096 bytes. No
		// space after the colon (framing the dashboard React hooks expect).
		// 4096 - 1 (`:`) - 2 (`\n\n`) = 4093 dots.
		$out = $this->host()->call_flush();
		$this->assertSame( ':' . \str_repeat( '.', 4093 ) . "\n\n", $out );
	}

	public function test_flush_if_needed_is_noop_when_not_set(): void {
		$this->assertSame( '', $this->host()->call_flush_no_op() );
	}

	public function test_flush_if_needed_idempotent_after_flush(): void {
		// Once flushed, a second call without new send is a no-op.
		$host = $this->host();
		$host->call_flush();
		$this->assertSame( '', $host->call_flush_no_op() );
		$this->assertFalse( $host->read_needs_flush() );
	}

	public function test_flush_size_constant_locks_wire_contract(): void {
		// The 4096-byte payload is a wire contract with proxies (matches Nginx /
		// CloudFront SSE flush thresholds). Any change here breaks the stream.
		$this->assertSame( 4096, SSE_Out_Node::FLUSH_SIZE );
	}

	// ── init_sse_headers ───────────────────────────────────────────────────

	public function test_init_sse_headers_drains_all_active_output_buffers(): void {
		// init_sse_headers() runs `while ob_get_level() > 0: ob_end_clean()`.
		// Open extra buffer levels here, then verify they're all gone after
		// the call. PHPUnit's own output capture has already produced bytes
		// to stdout (the test name, the dots), so the host wrapper uses
		// `@` to swallow the "headers already sent" warning that header()
		// triggers in a CLI runner. We re-open buffers to restore the
		// pre-test level so PHPUnit's risky-test buffer-level check passes.
		$host        = $this->host();
		$start_level = \ob_get_level();

		\ob_start();
		\ob_start();
		\ob_start();
		$this->assertSame( $start_level + 3, \ob_get_level(), 'sanity: opened 3 buffers' );

		try {
			$host->call_init_sse_headers();
			$this->assertSame( 0, \ob_get_level(), 'init_sse_headers must drain every active buffer' );
		} finally {
			// Restore the buffer level we found so PHPUnit's risky-test
			// check (ob_get_level() before == after) passes.
			while ( \ob_get_level() < $start_level ) {
				\ob_start();
			}
		}
	}

	public function test_init_sse_headers_is_safe_to_call_with_no_active_buffers(): void {
		// Drain anything ambient so the while loop has nothing to do, then
		// re-open it in the finally so PHPUnit's risky-test buffer-level
		// check passes.
		$host        = $this->host();
		$start_level = \ob_get_level();
		while ( \ob_get_level() > 0 ) {
			\ob_end_clean();
		}
		$this->assertSame( 0, \ob_get_level() );

		try {
			// Must not throw and must leave the buffer level at zero.
			$host->call_init_sse_headers();
			$this->assertSame( 0, \ob_get_level() );
		} finally {
			while ( \ob_get_level() < $start_level ) {
				\ob_start();
			}
		}
	}

	public function test_init_sse_headers_returns_void(): void {
		// Explicit void return: the method's contract is a side-effecting
		// pre-stream setup, not a value to consume. Lock that contract.
		$host        = $this->host();
		$start_level = \ob_get_level();
		\ob_start();
		try {
			$result = $host->call_init_sse_headers();
			$this->assertNull( $result );
		} finally {
			while ( \ob_get_level() < $start_level ) {
				\ob_start();
			}
		}
	}
	/** Both SSE streams front the fleet, so the multisite guard applies to them too. */
	public function test_a_multisite_subsite_is_refused(): void {
		$GLOBALS['_wp_test_current_user_can'] = [ 'read' => true, 'manage_options' => true ];
		$GLOBALS['_wp_test_is_multisite']     = true;
		$GLOBALS['_wp_test_is_main_site']     = false;

		$result = ( new SSE_Out_Node() )->check_permission();

		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'newspack_nodes_not_fleet_site', $result->get_error_code() );

		$GLOBALS['_wp_test_is_multisite']     = false;
		$GLOBALS['_wp_test_is_main_site']     = true;
		$GLOBALS['_wp_test_current_user_can'] = [];
	}

}
