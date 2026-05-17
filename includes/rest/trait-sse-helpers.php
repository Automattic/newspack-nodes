<?php
/**
 * SSE_Helpers_Trait — headers, safe-event sanitization, and the legacy
 * SSE wire-format helpers extracted from `class-sse-controller-base.php`
 * in `newspack-event-logger-nodes` so the new substrate
 * `Messages_Stream_Controller` can share them with the legacy
 * controllers (still alive until M5).
 *
 * Diff vs the parallel `SSE_Stream_Trait` (substrate-only, used by the
 * topology stream controller): both preserve an on-the-wire contract,
 * but two different contracts —
 *  - SAFE_EVENTS: `msg` / `heartbeat` / `connected` / `timeout` (no `hello`).
 *  - sanitize_event_name(): no `msg` fallback on empty string — caller
 *    must validate upstream.
 *  - flush comment framing: `:` + dots + `\n\n` (NO space after colon).
 *
 * Slot-acquisition and the polling-loop body live on the legacy
 * `SSEControllerBase` in `newspack-event-logger-nodes` — they depend on
 * the Cache_Interface / Memcached_Cache that the event-logger plugin
 * owns. This trait is intentionally just the wire-format pieces, which
 * are caller-agnostic.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

\defined( 'ABSPATH' ) || exit;

trait SSE_Helpers_Trait {

	/**
	 * Allow-list of event names this trait emits without sanitization.
	 * Hot-path: O(1) hash lookup short-circuits the regex sanitizer for
	 * the four canonical legacy events.
	 *
	 * @var array<string,int>
	 */
	private const SAFE_EVENTS = [
		'msg'       => 1,
		'heartbeat' => 1,
		'connected' => 1,
		'timeout'   => 1,
	];

	/**
	 * Flush-comment total byte size. Must stay under PIPE_BUF (4096 on
	 * Linux). Sized to push past nginx/Apache/TLS write buffers without
	 * overshooting the atomic-write boundary.
	 */
	public const FLUSH_SIZE = 4096;

	/** Has anything been emitted since the last flush? */
	protected bool $needs_flush = false;

	/**
	 * Strip everything outside [a-zA-Z0-9_-] from an unsafe event name.
	 * SAFE_EVENTS pass through verbatim. Defense in depth against SSE
	 * `event:` line injection if a caller forwards user input as the
	 * event name without prior validation.
	 *
	 * @param string $event Caller-supplied event name.
	 * @return string Sanitized event name (may be empty if the input
	 *                contained no allowed characters — legacy behavior).
	 */
	protected function sanitize_event_name( string $event ): string {
		if ( isset( self::SAFE_EVENTS[ $event ] ) ) {
			return $event;
		}
		return (string) \preg_replace( '/[^a-zA-Z0-9_-]/', '', $event );
	}

	/**
	 * Disable every buffering layer between PHP and the browser so SSE
	 * events stream incrementally. See the legacy controller-base for the
	 * full inventory: PHP output buffers, zlib output compression,
	 * mod_deflate (apache_setenv), and nginx (X-Accel-Buffering header).
	 */
	protected function init_sse_headers(): void {
		// phpcs:disable WordPress.PHP.IniSet.Risky
		@\ini_set( 'output_buffering', 'off' );
		@\ini_set( 'zlib.output_compression', false );
		@\ini_set( 'implicit_flush', true );
		// phpcs:enable

		while ( \ob_get_level() > 0 ) {
			\ob_end_clean();
		}

		if ( \function_exists( 'apache_setenv' ) ) {
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.runtime_configuration_apache_setenv
			@\apache_setenv( 'no-gzip', '1' );
		}

		\header( 'Content-Type: text/event-stream' );
		\header( 'Cache-Control: no-cache, no-store, must-revalidate' );
		\header( 'Connection: keep-alive' );
		\header( 'X-Accel-Buffering: no' );
		\header( 'Content-Encoding: none' );
	}

	/**
	 * Emit a single SSE event. SAFE_EVENTS pass through; anything else
	 * is sanitized via `sanitize_event_name()`. JSON-encodes the payload.
	 *
	 * @param string $event Event name.
	 * @param mixed  $data  JSON-serializable payload.
	 */
	protected function send_sse_event( string $event, mixed $data ): void {
		$event   = $this->sanitize_event_name( $event );
		$json    = \wp_json_encode( $data );
		$payload = "event: {$event}\ndata: {$json}\n\n";
		// SSE wire format — `event:`/`data:` framing must reach the
		// client byte-for-byte. HTML escaping would corrupt the stream.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo $payload;
		@\flush();
		$this->needs_flush = true;
	}

	/**
	 * If anything has been sent since the last flush, emit a FLUSH_SIZE
	 * SSE comment to push pending events past any remaining proxy/TLS
	 * buffer before we sleep. Idempotent: a second call without an
	 * intervening send_sse_event() is a no-op.
	 *
	 * Wire format: `:` + (FLUSH_SIZE-3) dots + "\n\n" = FLUSH_SIZE bytes.
	 * (1 ':' + N dots + 2 '\n\n' bytes total.) NO space after the colon
	 * — legacy framing the dashboard React hooks expect.
	 */
	protected function flush_if_needed(): void {
		if ( ! $this->needs_flush ) {
			return;
		}
		// SSE comment line. Wire format — must reach the client
		// byte-for-byte.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo ':' . \str_repeat( '.', static::FLUSH_SIZE - 3 ) . "\n\n";
		@\flush();
		$this->needs_flush = false;
	}
}
