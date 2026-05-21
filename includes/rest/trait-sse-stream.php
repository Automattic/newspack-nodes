<?php
/**
 * SSE_Stream_Trait — Server-Sent Events wire-format helpers shared by the
 * substrate's SSE REST controllers.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

\defined( 'ABSPATH' ) || exit;

trait SSE_Stream_Trait {

	/** Flush-comment total byte size. Must stay under PIPE_BUF (4096 on Linux). */
	public const FLUSH_SIZE = 4096;

	/**
	 * Allow-list of event names emitted without sanitization (O(1) hot-path).
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
	 * Strip everything outside [a-zA-Z0-9_-] from an unsafe event name (SSE
	 * `event:` line injection defense). SAFE_EVENTS pass through verbatim.
	 *
	 * @param string $event Caller-supplied event name.
	 * @return string Sanitized event name (may be empty).
	 */
	protected function sanitize_event_name( string $event ): string {
		if ( isset( self::SAFE_EVENTS[ $event ] ) ) {
			return $event;
		}
		return (string) \preg_replace( '/[^a-zA-Z0-9_-]/', '', $event );
	}

	/**
	 * Disable every buffering layer between PHP and the browser so SSE events
	 * stream incrementally (output buffers, zlib, mod_deflate, nginx).
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
			throw new \InvalidArgumentException( 'SSE event name is empty after sanitization; refusing to emit a nameless event.' );
		}
		$json    = \wp_json_encode( $data );
		$payload = "event: {$event}\ndata: {$json}\n\n";
		// SSE wire format must reach the client byte-for-byte; HTML escaping would corrupt the stream.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo $payload;
		@\flush();
		$this->needs_flush = true;
	}

	/**
	 * If anything has been sent since the last flush, emit a FLUSH_SIZE SSE
	 * comment to push pending events past any proxy/TLS buffer. Idempotent.
	 *
	 * Wire format: `:` + (FLUSH_SIZE-3) dots + "\n\n". NO space after the
	 * colon — framing the dashboard React hooks expect.
	 */
	protected function flush_if_needed(): void {
		if ( ! $this->needs_flush ) {
			return;
		}
		// SSE comment line — must reach the client byte-for-byte.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo ':' . \str_repeat( '.', static::FLUSH_SIZE - 3 ) . "\n\n";
		@\flush();
		$this->needs_flush = false;
	}
}
