<?php
/**
 * HTTP_In: double-duty Node + `/command` controller. As a Node its `fill()`
 * writes the `/command` response body (200 status header on first fill, then
 * packed-Message bytes); as a controller it registers `POST /command` and
 * routes the decoded batch through the substrate's Router.
 *
 * Uniformly routes via the substrate's Router (no IPC vs local branches —
 * worker `Partition` Nodes handle IPC). The per-request controller instance
 * registers itself as the `_http` Node; a CI response with TO=FROM walks back
 * to it and writes the packed Message to the HTTP body. After Router::fill
 * returns:
 *   - sent_headers true  → response already on the wire; exit().
 *   - sent_headers false → async/IPC; emit a 202 ack (real replies arrive
 *                          via the browser's open SSE stream).
 * Every incoming message is stamped with the `_http` boundary name (the client
 * sends a bare reply path — `_output`, `_sse:{pid}/…`, or '' — and never
 * hardcodes `_http`), so a reply's TO=FROM walks `_http/…` back here; a
 * pivoted `_sse:{pid}` reply is demuxed to the SSE process by HTTP_Filter.
 * test_mode returns instead of exit().
 *
 * The `$send_header` constructor argument is a test seam — production passes a
 * closure wrapping `\status_header(...)`; tests inject a recorder so PHPUnit
 * can assert which status codes were emitted.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;

\defined( 'ABSPATH' ) || exit;

class HTTP_In_Node extends Node {
	public const REST_NAMESPACE = 'newspack-nodes/v1';
	public const ROUTE          = '/command';

	public bool $sent_headers = false;

	/** @var \Closure status-header seam */
	private \Closure $send_header;

	private bool $test_mode = false;

	public function __construct( ?\Closure $send_header = null ) {
		// Node has no __construct; skip parent call (matches Callback pattern).
		$this->send_header = $send_header ?? static function ( int $code ): void {
			\status_header( $code );
		};
	}

	/** Node egress (terminal, not forwarded): writes the `/command` HTTP response. */
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
			'description' => '/command response-writer Node (registered as `_http` at request scope).',
			'ctor'        => [],
			'verbs'       => [],
		];
	}

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

		$router = Core::node( Node_Names::ROUTER );
		$out    = Core::node( Node_Names::HTTP );
		if ( ! $router instanceof Router_Node || ! $out instanceof self ) {
			$this->emit_error(
				$messages[ \array_key_last( $messages ) ] ?? Message::new_message(),
				'request-scope graph not initialized (missing _router or _http)'
			);
			$this->finish();
			return;
		}

		// This request process is a command VERIFIER: the request-scope base_ci
		// (and any patron CIs it mounts) must HMAC-check every command. Set the
		// process-wide policy once before routing.
		Command_Interpreter_Node::$default_authorize = Command_Auth::verifier();

		// Route messages in order through the one request graph: a batch runs
		// serially, so an earlier command's side effect is visible to a later one.
		// Sink through the base CommandInterpreter (mirroring the client's
		// Shell → CI → _router spine): the CI interprets an empty-TO command
		// addressed to the request scope itself (`cd /_sse`) and forwards a
		// non-empty TO on to _router. (_router has no sink and would drop empty TO.)
		$out->reset();
		foreach ( $messages as $msg ) {
			// The HTTP boundary stamps its own name onto every incoming message
			// (I/O-boundary stamping), so a reply's TO=FROM walks `_http/…` back
			// here. The client sends a bare reply path (`_output`, `_sse:{pid}/…`,
			// or '') and does NOT hardcode the `_http` prefix; we add it. An empty
			// FROM stamps to just `_http`. Stamp with the constant, not $this->name:
			// when the graph was pre-built, the registered `_http` node is a DIFFERENT
			// instance and $this is unnamed.
			$this->stamp_message( $msg, Node_Names::HTTP );
			// WP already authenticated this request (permission_callback:
			// manage_options). Sign command provenance on the browser's behalf so
			// downstream verifier CIs (request-scope + worker) accept it; the
			// signature covers semantics only, so the later FROM/TO peeling is fine.
			// Non-command messages (TM_BYTESTREAM/INFO, or responses) are left alone.
			if ( ( $msg[ Message::TYPE ] & Message::TM_COMMAND ) && ! ( $msg[ Message::TYPE ] & Message::TM_RESPONSE ) ) {
				Command_Auth::sign( $msg );
			}
			$base_ci->fill( $msg );
		}

		if ( ! $out->sent_headers ) {
			// Async / IPC case: routed onward (worker IPC), so the reply arrives
			// later over the SSE stream — a bare 202 ack with no body. The client
			// treats an empty response as "nothing to route."
			\status_header( 202 );
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
	 * `newspack_nodes/request_graph_ready` hook. This controller instance IS
	 * the `_http` response-writer Node.
	 */
	private function ensure_request_graph(): Command_Interpreter_Node {
		$router = Core::node( Node_Names::ROUTER );
		if ( ! $router instanceof Router_Node ) {
			$router = new Router_Node();
			$router->name( Node_Names::ROUTER );
		}
		$base_ci = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( ! $base_ci instanceof Command_Interpreter_Node ) {
			$base_ci = new Command_Interpreter_Node();
			$base_ci->name( Node_Names::COMMAND_INTERPRETER );
			$base_ci->sink( $router );
		}
		// The controller instance IS the _http egress Node (deliberately the same object).
		if ( ! Core::node( Node_Names::HTTP ) instanceof self ) {
			$this->name( Node_Names::HTTP );
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
