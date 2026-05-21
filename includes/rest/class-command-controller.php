<?php
/**
 * Command_Controller: single POST endpoint for non-streaming dispatch.
 *
 * Uniformly routes via the substrate's Router. The browser-supplied
 * `to` is the message's TO field; Router peels the head and looks up
 * the named Node. There are no IPC vs local branches — IPC is handled
 * by the per-worker `Partition` Nodes the bootstrap registers (one per
 * discovered worker) before this controller runs. Partition's own
 * `fill()` writes the message to disk.
 *
 * Response handling: the bootstrap registers a `HTTP_Out` Node at
 * `_http`. Browsers stamp FROM=`_http` (or `_http/<anything>`) for
 * local commands; the CI's response with TO=FROM walks back through
 * Router → HTTP_Out, whose `fill()` writes the packed Message directly
 * to the HTTP response body. After Router::fill returns, the controller
 * inspects `HTTP_Out::sent_headers`:
 *
 *   - sent_headers true   →  the response is already on the wire.
 *                             exit() to bypass WP's REST wrapping.
 *   - sent_headers false  →  no synchronous reply landed; this is the
 *                             async/IPC case (worker Partition wrote
 *                             the message to disk, no in-process
 *                             response). Emit a 202 ack so the caller
 *                             knows the message was queued. Real
 *                             replies arrive via the SSE stream the
 *                             browser already has open.
 *
 * For pivoted IPC commands the browser sets FROM=`_http/<ssePid>` so
 * the worker's reply walks back to the SSE process — HTTP_Out is
 * bypassed in that case (TO=FROM never resolves back to this process).
 *
 * Test mode: when `set_test_mode(true)` is set, dispatch returns
 * instead of exit(), so PHPUnit can capture stdout via ob_start().
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

		// Lazy-init the request-scope graph (idempotent). REST requests
		// hit this dispatch directly; no other entry point builds the
		// graph for them. CLI, workers, and SSE controllers each build
		// their own. Then fire `newspack_nodes/request_graph_ready` so
		// applications can mount service CIs via `$base_ci->make_node(...)`.
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

		// Route each message in order through the one request graph. A batch
		// (e.g. `[connect_worker_input, dump_metadata]`) runs serially in this
		// single process, so an earlier command's side effect — mounting the
		// worker Partition — is visible to the later command's routing.
		$out->reset();
		$last = null;
		foreach ( $messages as $msg ) {
			// Default FROM to `_http` so the CI's TO=FROM response routes
			// back to our registered HTTP_Out. Pivoted IPC commands supply
			// their own FROM (`_http/<ssePid>`) — leave it alone.
			if ( '' === $msg[ Message::FROM ] ) {
				$msg[ Message::FROM ] = '_http';
			}
			$router->fill( $msg );
			$last = $msg;
		}

		if ( ! $out->sent_headers ) {
			// Async / IPC case — no in-process response landed. 202 ack keyed
			// off the LAST message (the real command; any leading setup commands
			// such as connect_worker_input return '' and never reply).
			\status_header( 202 );
			\header( 'Content-Type: application/json' );
			// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
			echo \wp_json_encode( [ 'queued' => true, 'id' => null === $last ? '' : $last[ Message::ID ] ] );
		}
		$this->finish();
	}

	/**
	 * Decode the request body into an ordered list of Messages. The body is
	 * JSONL — one packed Message per line. A single command is one line; a
	 * batch is several (e.g. `connect_worker_input` then the real command),
	 * dispatched in order so they run serially in this one process. Each line
	 * goes through `Message::unpacked()` — the only JSON boundary; there is no
	 * array-of-messages wrapper. Blank lines are skipped.
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
	 * Lazy-construct the request-scope graph if it's not already in
	 * Core's registry. Idempotent — call sites that already built the
	 * graph (e.g. CLI, workers, or tests that wire it up explicitly)
	 * pay nothing here.
	 *
	 * Returns the base CommandInterpreter so callers can hand it to
	 * the `newspack_nodes/request_graph_ready` hook for application-
	 * level CI mounting via `$base_ci->make_node(...)`.
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
		// TIMESTAMP slot is already seeded by Message::new_message — no need to overwrite.
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
