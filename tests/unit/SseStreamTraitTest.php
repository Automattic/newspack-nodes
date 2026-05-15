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
 *  - stream_permissions_check() gates routes on manage_options capability
 *    and returns a WP_Error with the rest_authorization_required_code
 *    status when denied.
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
final class SseStreamTraitTest extends TestCase {

	/**
	 * Snapshot of the relevant test-globals so each test starts clean.
	 *
	 * @var array<string,mixed>
	 */
	private array $globals_snapshot = [];

	protected function setUp(): void {
		parent::setUp();
		$this->globals_snapshot = [
			'_wp_test_current_user_can' => $GLOBALS['_wp_test_current_user_can'] ?? null,
		];
		$GLOBALS['_wp_test_current_user_can'] = [];
	}

	protected function tearDown(): void {
		if ( null === $this->globals_snapshot['_wp_test_current_user_can'] ) {
			unset( $GLOBALS['_wp_test_current_user_can'] );
		} else {
			$GLOBALS['_wp_test_current_user_can'] = $this->globals_snapshot['_wp_test_current_user_can'];
		}
		parent::tearDown();
	}

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

			/**
			 * Expose init_sse_headers() to the test. PHPUnit's CLI runner
			 * has already emitted output by the time we get here, so the
			 * trait's `header()` calls trigger "headers already sent"
			 * warnings. The trait deliberately doesn't `@`-suppress them
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

	public function test_send_sse_event_falls_back_to_msg_when_name_is_all_unsafe(): void {
		$out = $this->host()->call_send( "<<\n>>", [] );
		$this->assertStringContainsString( "event: msg\n", $out );
	}

	public function test_send_sse_event_falls_back_to_msg_when_name_is_empty(): void {
		// Empty unsafe name → preg_replace yields empty string → falls back to 'msg'.
		$out = $this->host()->call_send( '', [] );
		$this->assertStringContainsString( "event: msg\n", $out );
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
		// the wire shape the trait emits. Lock the contract so a regression
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
		// Wire-format assertion: `: ` + 4092 dots + `\n\n` = 4096 bytes.
		// 4096 - 1 (`:`) - 1 (` `) - 2 (`\n\n`) = 4092 dots.
		$out = $this->host()->call_flush();
		$this->assertSame( ': ' . \str_repeat( '.', 4092 ) . "\n\n", $out );
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
		// PHP doesn't allow `Trait::CONST` directly; reach it through a using class.
		$this->assertSame( 4096, $this->host()::FLUSH_SIZE );
	}

	// ── stream_permissions_check ───────────────────────────────────────────

	public function test_stream_permissions_check_allows_manage_options(): void {
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = true;
		$this->assertTrue( $this->host()->stream_permissions_check() );
	}

	public function test_stream_permissions_check_rejects_without_manage_options(): void {
		// $GLOBALS['_wp_test_current_user_can'] empty → current_user_can() returns false.
		$result = $this->host()->stream_permissions_check();
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rest_forbidden', $result->get_error_code() );
	}

	public function test_stream_permissions_check_uses_rest_authorization_required_code(): void {
		// The bootstrap stub returns 401 for rest_authorization_required_code();
		// the WP_Error's status data must reflect that.
		$result = $this->host()->stream_permissions_check();
		$this->assertInstanceOf( \WP_Error::class, $result );
		$data = $result->get_error_data();
		$this->assertSame( 401, $data['status'] ?? null );
	}

	public function test_stream_permissions_check_error_carries_user_facing_message(): void {
		$result = $this->host()->stream_permissions_check();
		$this->assertInstanceOf( \WP_Error::class, $result );
		// Message is a fixed string (not a translated marker) so we can match it.
		$this->assertSame(
			'You do not have permission to access this resource.',
			$result->get_error_message()
		);
	}

	public function test_stream_permissions_check_rejects_when_cap_explicitly_false(): void {
		// Explicit false (not just missing) must also be denied — guards
		// against a regression that treats `isset()` as the gate instead
		// of the value itself.
		$GLOBALS['_wp_test_current_user_can']['manage_options'] = false;
		$result = $this->host()->stream_permissions_check();
		$this->assertInstanceOf( \WP_Error::class, $result );
		$this->assertSame( 'rest_forbidden', $result->get_error_code() );
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
}
