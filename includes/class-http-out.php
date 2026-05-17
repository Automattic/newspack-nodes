<?php
/**
 * HTTP_Out: stable-named Node registered at `_http` in the per-request
 * substrate graph. Writes the HTTP response body directly as each
 * message arrives — no intermediate buffer for the controller to read.
 *
 * Browser-sent commands stamp FROM=`_http`; the CI's response with
 * TO=FROM walks back through Router → here. First fill emits a 200
 * status header; subsequent fills (e.g. a verb that streams multiple
 * replies) append packed-Message bytes to the body without re-sending
 * headers.
 *
 * The `$send_header` constructor argument is a test seam — production
 * passes a closure wrapping `\status_header(...)`; tests inject a
 * recorder so PHPUnit can assert which status codes were emitted.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class HTTP_Out extends Node {
	public bool $sent_headers = false;

	/** @var \Closure status-header seam */
	private \Closure $send_header;

	public function __construct( ?\Closure $send_header = null ) {
		// Node has no __construct; skip parent call (matches Callback pattern).
		$this->send_header = $send_header ?? static function ( int $code ): void {
			\status_header( $code );
		};
	}

	public function fill( array &$message ): void {
		++$this->counter;
		if ( ! $this->sent_headers ) {
			( $this->send_header )( 200 );
			$this->sent_headers = true;
		}
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo Message::packed( $message );
	}

	public function reset(): void {
		$this->sent_headers = false;
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => 'Browser response writer — registered as `_http` at request scope.',
			'ctor'        => [],
			'verbs'       => [],
		];
	}
}
