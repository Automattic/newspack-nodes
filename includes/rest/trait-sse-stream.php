<?php
/**
 * SSE_Stream_Trait — Server-Sent Events wire-format helpers shared by the
 * substrate's SSE REST controllers (Messages_Stream_Controller and
 * Topology_Stream_Controller).
 *
 * Lifted from `class-sse-controller-base.php` in the legacy event-logger
 * plugins — the caller-agnostic wire-format pieces only (slot acquisition
 * and the per-stream polling loop live on each controller):
 *  - send_sse_event() echoes `event:`/`data:` framing + a light flush().
 *  - flush_if_needed() emits a FLUSH_SIZE-byte `:` comment to push pending
 *    events past nginx/Apache/TLS write buffers before the loop sleeps.
 *    Without it, small payloads sit buffered and never reach the client.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

\defined( 'ABSPATH' ) || exit;

trait SSE_Stream_Trait {

	/**
	 * Flush-comment total byte size. Must stay under PIPE_BUF (4096 on
	 * Linux). Sized to push past nginx/Apache/TLS write buffers without
	 * overshooting the atomic-write boundary.
	 */
	public const FLUSH_SIZE = 4096;

	/**
	 * Allow-list of event names emitted without sanitization. Hot-path:
	 * O(1) hash lookup short-circuits the regex sanitizer for the canonical
	 * events.
	 *
	 * @var array<string,int>
	 */
	private const SAFE_EVENTS = [
		'hello'     => 1,
		'msg'       => 1,
		'heartbeat' => 1,
		'connected' => 1,
		'timeout'   => 1,
	];

	/** Has anything been emitted since the last flush? */
	protected bool $needs_flush = false;

	/**
	 * Capability gate used as a route's `permission_callback`.
	 */
	public function stream_permissions_check(): bool|\WP_Error {
		if ( ! \function_exists( 'current_user_can' ) || ! \current_user_can( 'manage_options' ) ) {
			$status = \function_exists( 'rest_authorization_required_code' )
				? \rest_authorization_required_code()
				: 401;
			return new \WP_Error(
				'rest_forbidden',
				'You do not have permission to access this resource.',
				[ 'status' => $status ]
			);
		}
		return true;
	}

	/**
	 * Strip everything outside [a-zA-Z0-9_-] from an unsafe event name.
	 * SAFE_EVENTS pass through verbatim. Defense in depth against SSE
	 * `event:` line injection if a caller forwards user input as the event
	 * name without prior validation.
	 *
	 * @param string $event Caller-supplied event name.
	 * @return string Sanitized event name (may be empty if the input
	 *                contained no allowed characters).
	 */
	protected function sanitize_event_name( string $event ): string {
		if ( isset( self::SAFE_EVENTS[ $event ] ) ) {
			return $event;
		}
		return (string) \preg_replace( '/[^a-zA-Z0-9_-]/', '', $event );
	}

	/**
	 * Disable every buffering layer between PHP and the browser so SSE
	 * events stream incrementally: PHP output buffers, zlib output
	 * compression, mod_deflate (apache_setenv), and nginx (X-Accel-Buffering).
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
	 * Emit a single SSE event. SAFE_EVENTS pass through; anything else is
	 * sanitized via `sanitize_event_name()`. JSON-encodes the payload.
	 *
	 * @param string $event Event name.
	 * @param mixed  $data  JSON-serializable payload.
	 */
	protected function send_sse_event( string $event, mixed $data ): void {
		$event = $this->sanitize_event_name( $event );
		if ( '' === $event ) {
			// A name that sanitizes to empty means a caller passed garbage.
			// Fail loud rather than emit a nameless `event:` line the client
			// would silently treat as a default `message`.
			throw new \InvalidArgumentException( 'SSE event name is empty after sanitization; refusing to emit a nameless event.' );
		}
		$json    = \wp_json_encode( $data );
		$payload = "event: {$event}\ndata: {$json}\n\n";
		// SSE wire format — `event:`/`data:` framing must reach the client
		// byte-for-byte. HTML escaping would corrupt the stream.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo $payload;
		@\flush();
		$this->needs_flush = true;
	}

	/**
	 * If anything has been sent since the last flush, emit a FLUSH_SIZE
	 * SSE comment to push pending events past any remaining proxy/TLS buffer
	 * before we sleep. Idempotent: a second call without an intervening
	 * send_sse_event() is a no-op.
	 *
	 * Wire format: `:` + (FLUSH_SIZE-3) dots + "\n\n" = FLUSH_SIZE bytes. NO
	 * space after the colon — framing the dashboard React hooks expect.
	 */
	protected function flush_if_needed(): void {
		if ( ! $this->needs_flush ) {
			return;
		}
		// SSE comment line. Wire format — must reach the client byte-for-byte.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo ':' . \str_repeat( '.', static::FLUSH_SIZE - 3 ) . "\n\n";
		@\flush();
		$this->needs_flush = false;
	}
}
