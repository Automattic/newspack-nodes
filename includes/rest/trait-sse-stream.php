<?php
/**
 * SSE_Stream_Trait — minimal Server-Sent Events helpers for substrate
 * REST controllers (only the topology stream controller in v1).
 *
 * Lifted from newspack-event-logger-nodes' SSEControllerBase, stripped
 * of the memcache slot machinery. The app plugin's other five SSE
 * controllers continue to use the full base — this trait is only what
 * the substrate's topology stream controller needs.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

\defined( 'ABSPATH' ) || exit;

trait SSE_Stream_Trait {

	public const FLUSH_SIZE = 4096;

	/**
	 * Allow-list of event names this stream may emit. Acts as a
	 * defense-in-depth measure against accidental event-name injection.
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

	protected bool $needs_flush = false;

	/**
	 * Capability gate used as the route's `permission_callback`.
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
	 * Set headers + disable every buffering layer between PHP and the
	 * browser so SSE events stream incrementally.
	 */
	protected function init_sse_headers(): void {
		// phpcs:disable WordPress.PHP.IniSet.Risky
		@\ini_set( 'output_buffering', 'off' );
		@\ini_set( 'zlib.output_compression', false );
		// phpcs:enable WordPress.PHP.IniSet.Risky
		while ( \ob_get_level() > 0 ) {
			@\ob_end_clean();
		}
		if ( \function_exists( 'apache_setenv' ) ) {
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.runtime_configuration_apache_setenv
			@\apache_setenv( 'no-gzip', '1' );
		}
		\header( 'Content-Type: text/event-stream; charset=utf-8' );
		\header( 'Cache-Control: no-cache, no-store, must-revalidate' );
		\header( 'Pragma: no-cache' );
		\header( 'Expires: 0' );
		\header( 'X-Accel-Buffering: no' );
		\header( 'Content-Encoding: none' );
		\header( 'Connection: keep-alive' );
	}

	/**
	 * Emit an SSE event. Event names not in SAFE_EVENTS get sanitized
	 * (control chars stripped) — defense in depth against caller bugs.
	 */
	protected function send_sse_event( string $name, array $payload ): void {
		if ( ! isset( self::SAFE_EVENTS[ $name ] ) ) {
			$name = (string) \preg_replace( '/[^A-Za-z0-9_-]/', '', $name );
			if ( '' === $name ) {
				$name = 'msg';
			}
		}
		$payload_json = (string) \wp_json_encode( $payload );
		// SSE wire format — `event:` + `data:` framing must reach the
		// client byte-for-byte. HTML escaping would corrupt the stream.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo "event: {$name}\ndata: {$payload_json}\n\n";
		$this->needs_flush = true;
	}

	/**
	 * Emit a 4096-byte SSE comment to push pending events past any
	 * remaining proxy/TLS buffer before we sleep. Resets the flag.
	 */
	protected function flush_if_needed(): void {
		if ( ! $this->needs_flush ) {
			return;
		}
		// SSE comments start with `:` and a single space and end with
		// "\n\n". 4096 total - 1 (':') - 1 (' ') - 2 ("\n\n") = 4092
		// dots → 4096-byte payload. Wire format — must reach the
		// client byte-for-byte.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo ': ' . \str_repeat( '.', 4092 ) . "\n\n";
		\flush();
		$this->needs_flush = false;
	}
}
