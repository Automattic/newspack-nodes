<?php
declare(strict_types=1);

namespace Newspack_Nodes\Tests\Unit;

use Newspack_Nodes\Rest\SSE_Helpers_Trait;
use PHPUnit\Framework\TestCase;

/**
 * Unit tests for SSE_Helpers_Trait — the header/event-sanitization /
 * wire-format helpers extracted from the legacy
 * `class-sse-controller-base.php` (in `newspack-event-logger-nodes`) so
 * the new substrate `Messages_Stream_Controller` can share them with the
 * legacy controllers (still alive until M5).
 *
 * The trait preserves the legacy wire contract exactly. The most
 * load-bearing detail (because the same byte stream feeds the existing
 * React hooks): the flush comment is `:` + dots + `\n\n` — NO space
 * after the colon, unlike the parallel `SSE_Stream_Trait` which uses
 * `: ` + dots. A regression to space-after-colon framing would still be
 * a valid SSE comment but would silently change the byte stream feeding
 * the production dashboards.
 */
final class SseHelpersTraitTest extends TestCase {

	/**
	 * Build a minimal host class that uses the trait and exposes the
	 * protected methods to the test. Real consumers are REST controllers;
	 * for the trait's contract we just need to drive its methods and
	 * capture stdout.
	 */
	private function host(): object {
		return new class {
			use SSE_Helpers_Trait;

			public function probe_sanitize( string $event ): string {
				return $this->sanitize_event_name( $event );
			}

			public function call_send( string $event, mixed $data ): string {
				\ob_start();
				$this->send_sse_event( $event, $data );
				return (string) \ob_get_clean();
			}

			public function call_flush_set(): string {
				$this->needs_flush = true;
				\ob_start();
				$this->flush_if_needed();
				return (string) \ob_get_clean();
			}

			public function call_flush_unset(): string {
				\ob_start();
				$this->flush_if_needed();
				return (string) \ob_get_clean();
			}

			public function read_needs_flush(): bool {
				return $this->needs_flush;
			}
		};
	}

	// ── sanitize_event_name ────────────────────────────────────────────────

	public function test_safe_event_name_passthrough_for_allowlisted(): void {
		$obj = $this->host();
		$this->assertSame( 'connected', $obj->probe_sanitize( 'connected' ) );
		$this->assertSame( 'msg',       $obj->probe_sanitize( 'msg' ) );
		$this->assertSame( 'heartbeat', $obj->probe_sanitize( 'heartbeat' ) );
		$this->assertSame( 'timeout',   $obj->probe_sanitize( 'timeout' ) );
	}

	public function test_safe_event_name_strips_dangerous_chars(): void {
		$obj = $this->host();
		$this->assertSame( 'okname', $obj->probe_sanitize( "ok\nname" ) );
		$this->assertSame( 'a-b_c',  $obj->probe_sanitize( 'a-b_c' ) );
	}

	public function test_unsafe_event_name_strips_colons_spaces_and_control_chars(): void {
		// SSE framing relies on `event:`/`data:` lines — spaces, colons,
		// and newlines in an unsafe event name would break the wire format
		// and let a misbehaving caller inject extra events.
		$obj = $this->host();
		$this->assertSame( 'evilevent', $obj->probe_sanitize( "evil:\n event" ) );
	}

	// ── send_sse_event ─────────────────────────────────────────────────────

	public function test_send_sse_event_emits_event_and_data_lines(): void {
		$out = $this->host()->call_send( 'connected', [ 'pid' => 42 ] );
		$this->assertStringContainsString( "event: connected\n", $out );
		$this->assertStringContainsString( 'data: {"pid":42}', $out );
		$this->assertStringEndsWith( "\n\n", $out );
	}

	public function test_send_sse_event_marks_flush_needed(): void {
		$host = $this->host();
		$host->call_send( 'msg', [ 'k' => 'v' ] );
		$this->assertTrue( $host->read_needs_flush() );
	}

	// ── flush_if_needed ────────────────────────────────────────────────────

	public function test_flush_if_needed_emits_exact_legacy_framing_when_set(): void {
		$host = $this->host();
		$out  = $host->call_flush_set();
		// Legacy framing — wire contract with the existing React dashboards.
		// PHP doesn't allow `Trait::CONST` directly; reach it through the host class.
		// The exact-bytes assertion locks BOTH the size AND the no-space-after-colon
		// framing — without it a regression to `: ....\n\n` would still satisfy
		// FLUSH_SIZE-bytes + starts-with-`:` + ends-with-`\n\n`.
		$expected = ':' . \str_repeat( '.', $host::FLUSH_SIZE - 3 ) . "\n\n";
		$this->assertSame( $expected, $out );
		$this->assertSame( $host::FLUSH_SIZE, \strlen( $out ) );
		$this->assertFalse( $host->read_needs_flush() );
	}

	public function test_flush_if_needed_is_noop_when_unset(): void {
		$this->assertSame( '', $this->host()->call_flush_unset() );
	}
}
