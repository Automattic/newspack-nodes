<?php
/**
 * HTTP_In: double-duty Node + `/command` controller. As a Node its `fill()`
 * writes the `/command` response body (200 status header on first fill, then
 * packed-Message bytes); as a controller it registers `POST /command` and
 * routes the decoded batch through the substrate's Router.
 *
 * Uniformly routes via the substrate's Router (no IPC vs local branches —
 * worker `Partition` Nodes handle IPC). The per-request controller instance
 * registers itself as the `_http` Node; an interpreter response with TO=FROM walks back
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

	/**
	 * Rate-limit window for the `/command` endpoint, in seconds. One-second
	 * buckets are tight enough to bound a runaway script and generous enough
	 * that a normal dashboard burst (mount-time fan-out + a few user clicks)
	 * never grazes the cap.
	 */
	public const RATE_LIMIT_WINDOW_S = 1;

	/**
	 * Default per-user burst budget per RATE_LIMIT_WINDOW_S. The topology
	 * console fans out a handful of `list` requests on mount (classes,
	 * topologies, layouts, ...) and dispatches commands at the speed the
	 * operator types — well under 30/s in practice. The cap exists to bound
	 * a buggy script hammering the endpoint, not to throttle normal use.
	 * High-throughput sites can tune via the
	 * `newspack_nodes/command_rate_limit` filter.
	 */
	public const RATE_LIMIT_BURST = 30;

	public bool $sent_headers = false;

	/**
	 * Clock seam for the rate limit. The PHPUnit suite assigns a fake
	 * timestamp here so a test can simulate a 1 req/sec stream across many
	 * seconds without sleeping. Production leaves it null and reads
	 * `microtime( true )` live.
	 *
	 * @var float|null
	 */
	public static ?float $clock_now_seam = null;

	/**
	 * Test-mode bypass for the rate limit. The PHPUnit suite sets this to
	 * true so a test run that fires >RATE_LIMIT_BURST `/command` calls in
	 * one second isn't throttled mid-suite. Production never flips it.
	 */
	public static bool $rate_limit_disabled = false;

	/** @var \Closure status-header seam */
	private \Closure $send_header;

	private bool $test_mode = false;

	public function __construct( ?\Closure $send_header = null ) {
		$this->send_header = $send_header ?? static function ( int $code ): void {
			\status_header( $code );
		};
		// Chain to the base ctor (no-op today — no handler-bearing node_schema
		// verbs — but keeps the :config auto-wire available if any are added).
		parent::__construct();
	}

	/** Node egress (terminal, not forwarded): writes the `/command` HTTP response. */
	public function fill( array &$message ): void {
		++$this->counter;
		if ( ! $this->sent_headers ) {
			( $this->send_header )( 200 );
			$this->sent_headers = true;
		}
		// JSONL: one packed Message per line. A command can emit MORE than one
		// message into the body (e.g. a `log`/stderr line plus the verb response),
		// so the client splits on newlines and unpacks each line — never JSON.parse
		// the whole body. packed() is single-line JSON (newlines in values are
		// escaped), so `\n` is an unambiguous record separator.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo Message::packed( $message ) . "\n";
	}

	public function reset(): void {
		$this->sent_headers = false;
	}

	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => '/command response-writer Node (registered as `_http` at request scope).',
			'arguments'        => [],
			'commands'       => [],
			'has_target'  => false,
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
				'permission_callback' => [ $this, 'check_permission' ],
			]
		);
	}

	/**
	 * Permission check: manage_options THEN per-user rate limit. Capability
	 * is verified first so an unauthenticated burst can't poison the
	 * transient table (same ordering Spawn_Controller uses).
	 *
	 * @param \WP_REST_Request $req Request.
	 * @return bool|\WP_Error
	 */
	public function check_permission( \WP_REST_Request $req ) {
		if ( ! \function_exists( 'current_user_can' ) || ! \current_user_can( 'manage_options' ) ) {
			return false;
		}
		return $this->check_rate_limit();
	}

	/**
	 * Per-user rolling-window rate limit. Increments a transient counter
	 * keyed by user id; returns WP_Error('rate_limited', 429) when the
	 * window's budget is exhausted. No-op without the transient API (test
	 * contexts that skip stubbing) or when `$rate_limit_disabled` is set.
	 *
	 * @return true|\WP_Error
	 */
	protected function check_rate_limit() {
		if ( self::$rate_limit_disabled ) {
			return true;
		}
		if ( ! \function_exists( 'get_transient' ) || ! \function_exists( 'set_transient' ) ) {
			return true;
		}

		/**
		 * Tunable burst budget per RATE_LIMIT_WINDOW_S. Defaults to
		 * RATE_LIMIT_BURST; high-throughput sites raise it.
		 *
		 * @param int $burst Max `/command` POSTs per user per window.
		 */
		$burst = (int) \apply_filters( 'newspack_nodes/command_rate_limit', self::RATE_LIMIT_BURST );
		if ( $burst < 1 ) {
			$burst = 1;
		}

		$user_id = \function_exists( 'get_current_user_id' ) ? (int) \get_current_user_id() : 0;
		// Bucket by floor(microtime) — each clock-second is an independent
		// counter, so a steady stream at <BURST/sec stays at count=1 in each
		// bucket forever instead of accumulating in a single transient that
		// the old code kept refreshing on every write (the implementation
		// before this gave a 429 to a 1 req/sec client after ~30 seconds).
		$now     = self::$clock_now_seam ?? \microtime( true );
		$bucket  = (int) \floor( $now );
		$key     = "newspack_nodes_cmd_rl:{$user_id}:{$bucket}";
		$count   = (int) \get_transient( $key );
		if ( $count >= $burst ) {
			return new \WP_Error(
				'rate_limited',
				'Too many /command requests; please slow down.',
				[ 'status' => 429 ]
			);
		}
		// TTL is 2x the window: long enough to outlive the bucket so an in-
		// flight check still sees a stale count, short enough that abandoned
		// buckets get GC'd by the transient store without manual cleanup.
		\set_transient( $key, $count + 1, self::RATE_LIMIT_WINDOW_S * 2 );
		return true;
	}

	public function dispatch( \WP_REST_Request $request ): void {
		$messages = $this->messages_from_body( (string) $request->get_body() );

		// Lazy-init the request-scope graph (idempotent), then let applications
		// mount service interpreters via the request_graph_ready hook.
		$base_interpreter = $this->ensure_request_graph();
		\do_action( 'newspack_nodes/request_graph_ready', $base_interpreter );

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

		// This request process is a command VERIFIER: the request-scope base_interpreter
		// (and any patron interpreters it mounts) must HMAC-check every command. Set the
		// process-wide policy once before routing.
		Command_Interpreter_Node::$default_authorize = Command_Auth::verifier();

		// Route messages in order through the one request graph: a batch runs
		// serially, so an earlier command's side effect is visible to a later one.
		// Sink through the base CommandInterpreter (mirroring the client's
		// Shell → interpreter → _router spine): the interpreter interprets an empty-TO command
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
			// downstream verifier interpreters (request-scope + worker) accept it; the
			// signature covers semantics only, so the later FROM/TO peeling is fine.
			// Non-command messages (TM_BYTESTREAM/INFO, or responses) are left alone.
			if ( ( $msg[ Message::TYPE ] & Message::TM_COMMAND ) && ! ( $msg[ Message::TYPE ] & Message::TM_RESPONSE ) ) {
				Command_Auth::sign( $msg );
			}
			$base_interpreter->fill( $msg );
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
		$base_interpreter = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( ! $base_interpreter instanceof Command_Interpreter_Node ) {
			$base_interpreter = new Command_Interpreter_Node();
			$base_interpreter->name( Node_Names::COMMAND_INTERPRETER );
			$base_interpreter->sink( $router );
		}
		// The controller instance IS the _http egress Node (deliberately the same object).
		if ( ! Core::node( Node_Names::HTTP ) instanceof self ) {
			$this->name( Node_Names::HTTP );
		}
		return $base_interpreter;
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
