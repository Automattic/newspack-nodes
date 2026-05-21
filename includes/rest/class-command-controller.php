<?php
/**
 * Command_Controller: single POST endpoint for non-streaming dispatch.
 *
 * Uniformly routes via the substrate's Router (no IPC vs local branches —
 * worker `Partition` Nodes handle IPC). The bootstrap registers a `HTTP_Out`
 * Node at `_http`; a CI response with TO=FROM walks back to it and writes the
 * packed Message to the HTTP body. After Router::fill returns:
 *   - sent_headers true  → response already on the wire; exit().
 *   - sent_headers false → async/IPC; emit a 202 ack (real replies arrive
 *                          via the browser's open SSE stream).
 * Pivoted IPC commands set FROM=`_http/<ssePid>` so the reply walks to the
 * SSE process (HTTP_Out bypassed). test_mode returns instead of exit().
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\CommandInterpreter;
use Newspack_Nodes\Core;
use Newspack_Nodes\HTTP_Out;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router;

\defined( 'ABSPATH' ) || exit;

class Command_Controller {
	public const REST_NAMESPACE = 'newspack-nodes/v1';
	public const ROUTE          = '/command';

	private bool $test_mode = false;

	public function set_test_mode( bool $on ): void {
		$this->test_mode = $on;
	}

	public function register_routes(): void {
		\register_rest_route(
			self::REST_NAMESPACE,
			self::ROUTE,
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'dispatch' ],
				'permission_callback' => static fn() => \current_user_can( 'manage_options' ),
			]
		);
	}

	public function dispatch( \WP_REST_Request $request ): void {
		$messages = $this->messages_from_body( (string) $request->get_body() );

		// Lazy-init the request-scope graph (idempotent), then let applications
		// mount service CIs via the request_graph_ready hook.
		$base_ci = $this->ensure_request_graph();
		\do_action( 'newspack_nodes/request_graph_ready', $base_ci );

		$router = Core::node( '_router' );
		$out    = Core::node( '_http' );
		if ( ! $router instanceof Router || ! $out instanceof HTTP_Out ) {
			$this->emit_error(
				$messages[ \array_key_last( $messages ) ] ?? Message::new_message(),
				'request-scope graph not initialized (missing _router or _http)'
			);
			$this->finish();
			return;
		}

		// Route messages in order through the one request graph: a batch runs
		// serially, so an earlier command's side effect is visible to a later one.
		$out->reset();
		$last = null;
		foreach ( $messages as $msg ) {
			// Default FROM=`_http` so the CI's TO=FROM response routes back to our
			// HTTP_Out. Pivoted IPC commands supply their own FROM — leave it alone.
			if ( '' === $msg[ Message::FROM ] ) {
				$msg[ Message::FROM ] = '_http';
			}
			$router->fill( $msg );
			$last = $msg;
		}

		if ( ! $out->sent_headers ) {
			// Async / IPC case. 202 ack keyed off the LAST message (leading setup
			// commands like connect_worker_input return '' and never reply).
			\status_header( 202 );
			\header( 'Content-Type: application/json' );
			// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			echo \wp_json_encode( [ 'queued' => true, 'id' => null === $last ? '' : $last[ Message::ID ] ] );
		}
		$this->finish();
	}

	/**
	 * Decode the JSONL request body into an ordered list of Messages (one
	 * packed Message per line via `Message::unpacked()`; blank lines skipped).
	 *
	 * @return array<int,array<int,mixed>>
	 * @throws \InvalidArgumentException When no line parses to a Message.
	 */
	private function messages_from_body( string $body ): array {
		$messages = [];
		foreach ( \explode( "\n", $body ) as $line ) {
			$line = \trim( $line );
			if ( '' === $line ) {
				continue;
			}
			$messages[] = Message::unpacked( $line );
		}
		if ( empty( $messages ) ) {
			throw new \InvalidArgumentException( 'Command body must be one or more newline-delimited packed Messages (JSONL).' );
		}
		return $messages;
	}

	/**
	 * Lazy-construct the request-scope graph if not already in Core's registry
	 * (idempotent). Returns the base CommandInterpreter for the
	 * `newspack_nodes/request_graph_ready` hook.
	 */
	private function ensure_request_graph(): CommandInterpreter {
		$router = Core::node( '_router' );
		if ( ! $router instanceof Router ) {
			$router = new Router();
			$router->name( '_router' );
		}
		$base_ci = Core::node( '_command_interpreter' );
		if ( ! $base_ci instanceof CommandInterpreter ) {
			$base_ci = new CommandInterpreter();
			$base_ci->name( '_command_interpreter' );
			$base_ci->sink( $router );
		}
		$http_out = Core::node( '_http' );
		if ( ! $http_out instanceof HTTP_Out ) {
			$http_out = new HTTP_Out( static fn ( int $code ) => \status_header( $code ) );
			$http_out->name( '_http' );
		}
		return $base_ci;
	}

	private function finish(): void {
		if ( ! $this->test_mode ) {
			exit;
		}
	}

	private function emit_error( array $msg, string $err ): void {
		\status_header( 500 );
		\header( 'Content-Type: application/json' );
		$r                   = Message::new_message();
		$r[ Message::TYPE ]  = Message::TM_RESPONSE | Message::TM_ERROR;
		$r[ Message::FROM ]  = '_command';
		$r[ Message::TO ]    = $msg[ Message::FROM ];
		$r[ Message::ID ]    = $msg[ Message::ID ];
		$r[ Message::VALUE ] = $err;
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo Message::packed( $r );
	}
}
