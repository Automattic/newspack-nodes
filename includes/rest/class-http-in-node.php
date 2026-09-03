<?php
/**
 * `POST /newspack-nodes/v1/command`: the substrate's command door, and the
 * `_output` Node that writes its response body.
 *
 * The controller decodes a JSONL batch of packed Messages and fills each one
 * into the request-scope base interpreter. The same instance registers itself as
 * `_output`, so an interpreter reply addressed TO=FROM (ADR-7) walks the
 * `_output` boundary back to this object and its `fill()` writes the reply into
 * the HTTP body. Both halves live in one class because the status code depends
 * on what the routing did, and only the object that wrote the body knows whether
 * a status is still available to send.
 *
 * Routing is uniform: every message goes through Router, and no branch sorts
 * local work from IPC, because a worker's input `Partition` Node IS the IPC hop.
 *
 * Each incoming message is stamped with the `_output` boundary name. A client
 * sends a bare reply path — `_output`, `_sse:{pid}/{node}`, or an empty FROM —
 * and never spells the boundary itself, so a plain reply comes straight back
 * down this response body while a session-scoped `_sse:{pid}` reply reaches the
 * right browser tab through `HTTP_Filter_Node` in the SSE stream process.
 *
 * The door verifies and never signs (ADR-15). Conferring authority on arrival
 * would make the boundary an oracle, since anything reaching it would acquire
 * authority whatever put it there; an unsigned wire command is refused instead.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Capabilities;

use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;

\defined( 'ABSPATH' ) || exit;

/**
 * The `/command` controller and the `_output` egress Node it registers itself as.
 *
 * The status goes out once, at whichever comes first: `fill()` sends it as a
 * reply opens the body, and `dispatch()` sends it after the batch when nothing
 * wrote back. 200 means a reply is already on the wire, 401 that a command in
 * the batch failed verification, and 202 that the batch routed onward and its
 * replies are due on the client's open SSE stream.
 */
class HTTP_In_Node extends Node {

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

	/**
	 * Rate-limit window for the `/command` endpoint, in seconds. One-second
	 * buckets are tight enough to bound a runaway script and generous enough
	 * that a normal dashboard burst (mount-time fan-out + a few user clicks)
	 * never grazes the cap.
	 */
	public const RATE_LIMIT_WINDOW_S = 1;

	/** REST namespace the route registers under. */
	public const REST_NAMESPACE = 'newspack-nodes/v1';

	/** Route within that namespace; the full path is `/newspack-nodes/v1/command`. */
	public const ROUTE = '/command';

	/**
	 * Clock seam for the rate limit. The PHPUnit suite assigns a fake
	 * timestamp here so a test can simulate a 1 req/sec stream across many
	 * seconds without sleeping. Production leaves it null and reads the live
	 * clock via Core::right_now().
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

	/**
	 * Whether this request's status line has been sent. `fill()` sets it as it
	 * opens the body; `dispatch()` reads it to decide whether a status is still
	 * available once the batch has routed.
	 */
	public bool $sent_headers = false;

	/**
	 * Whether any command in this request failed verification. Both status
	 * decisions read it, so a batch carrying one refusal answers 401 rather than
	 * a reassuring 200 or 202.
	 */
	public bool $refused_a_command = false;

	/**
	 * Status-header seam. It replaces the one `\status_header()` call, so the
	 * surrounding decision — which code, and whether the body has opened — runs
	 * as real production code under test. The PHPUnit suite injects a recorder
	 * and asserts on the codes emitted.
	 *
	 * Signature: `function ( int $code ): void`.
	 *
	 * @var \Closure
	 */
	private \Closure $send_header;

	/** When true, `finish()` returns instead of calling `exit`, so a test can assert on what dispatch left behind. */
	private bool $test_mode = false;

	/**
	 * Build the controller, defaulting the status seam to `\status_header()`.
	 *
	 * @param \Closure|null $send_header Seam `function ( int $code ): void`; null takes the production default.
	 */
	public function __construct( ?\Closure $send_header = null ) {
		$this->send_header = $send_header ?? static function ( int $code ): void {
			\status_header( $code );
		};
		// Chain to the base ctor: it seeds the declared-event allow-list.
		parent::__construct();
	}

	/**
	 * Write one message into the `/command` response body. Terminal egress: this
	 * Node forwards nothing onward.
	 *
	 * The status rides out with the first message, because once the body starts
	 * the status line is spent — a refusal discovered later in the batch can no
	 * longer change it. `authorize_and_latch()` raises its latch ahead of the
	 * verifier for exactly that reason.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
		if ( ! $this->sent_headers ) {
			// Decided here: once the body starts, the status is spent.
			( $this->send_header )( $this->refused_a_command ? 401 : 200 );
			$this->sent_headers = true;
		}
		// JSONL: one packed Message per line; split on \n, never JSON.parse.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo Message::packed( $message ) . "\n";
	}

	/**
	 * Gate the request on the fleet site, then the READ role, then the per-user
	 * rate limit. Capability is verified before the rate limit so an
	 * unauthenticated burst cannot poison the transient table — the ordering
	 * `Spawn_Controller` uses.
	 *
	 * The door demands the LEAST any verb behind it needs, and authority is then
	 * decided per verb: by each Service CI's declared role and, for the base
	 * interpreter's graph vocabulary, by the MANAGE floor `ensure_request_graph()`
	 * pins on it. Demanding MANAGE here would make the strictest verb set the
	 * privilege level of every caller, leaving the log aggregator holding an
	 * administrator's application password to pull a read-only stream.
	 *
	 * @param \WP_REST_Request $req Request; the gate reads nothing from it.
	 * @return bool|\WP_Error True to proceed, false without the READ role, a 403 off the fleet site, a 429 over budget.
	 */
	public function check_permission( \WP_REST_Request $req ) {
		$gate = Bootstrap::fleet_gate();
		if ( null !== $gate ) {
			return $gate;
		}
		if ( ! Capabilities::can( Capabilities::READ ) ) {
			return false;
		}
		return $this->check_rate_limit();
	}

	/**
	 * Per-user rate limit over fixed one-second buckets. Increments a transient
	 * counter keyed by user id and bucket, and returns
	 * `WP_Error( 'rate_limited', 429 )` once that bucket's budget is spent.
	 *
	 * Independent buckets are what keep a steady one-request-per-second client at
	 * count 1 forever. One counter whose TTL every write renews instead climbs
	 * monotonically, and 429s a client that never exceeded one request a second.
	 *
	 * No-op when `$rate_limit_disabled` is set, and no-op without the transient
	 * API — a test context that stubs neither `get_transient` nor `set_transient`.
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
		$burst = \apply_filters( 'newspack_nodes/command_rate_limit', self::RATE_LIMIT_BURST );
		if ( $burst < 1 ) {
			$burst = 1;
		}

		$user_id = \function_exists( 'get_current_user_id' ) ? \get_current_user_id() : 0;
		// Bucket by floor(microtime): steady <BURST/s stays count=1.
		$now     = self::$clock_now_seam ?? Core::right_now();
		$bucket  = (int) \floor( $now );
		$key     = "newspack_nodes_cmd_rl:{$user_id}:{$bucket}";
		$raw_count = \get_transient( $key );
		$count     = Core::as_int( $raw_count );
		if ( $count >= $burst ) {
			return new \WP_Error(
				'rate_limited',
				'Too many /command requests; please slow down.',
				[ 'status' => 429 ]
			);
		}
		// TTL 2x window: outlives the bucket, then the store GCs it.
		\set_transient( $key, $count + 1, self::RATE_LIMIT_WINDOW_S * 2 );
		return true;
	}

	/**
	 * Route one POSTed batch and answer it.
	 *
	 * The batch fills the base interpreter in the order posted, serially: a
	 * client that sends `connect_worker_input` ahead of the command it enables
	 * depends on that order holding.
	 *
	 * The reply decides the status. A synchronous reply walks back to `fill()`,
	 * which has already sent 200 or 401; when nothing writes back, the work
	 * routed onward and this answers 202, its replies due on the client's open
	 * SSE stream. A request-scope graph missing `_router` or `_output` answers
	 * 500 through `emit_error()` instead.
	 *
	 * @param \WP_REST_Request $request Request whose body is the JSONL batch.
	 * @throws \InvalidArgumentException When the body carries no parseable Message.
	 */
	public function dispatch( \WP_REST_Request $request ): void {
		$messages = $this->messages_from_body( $request->get_body() );

		// Lazy-init the request-scope graph (idempotent); apps mount via hook.
		$base_interpreter = $this->ensure_request_graph();

		$router = Core::node( Node_Names::ROUTER );
		$out    = Core::node( Node_Names::OUTPUT );
		if ( ! $router instanceof Router_Node || ! $out instanceof self ) {
			$this->emit_error(
				$messages[ \array_key_last( $messages ) ] ?? Message::new_message(),
				'request-scope graph not initialized (missing _router or _output)'
			);
			$this->finish();
			return;
		}

		// This request process is a command VERIFIER: HMAC-check every command.
		Command_Interpreter_Node::$default_authorize = $this->fresh_verifier();

		// Route the batch in order through the base interpreter (serial).
		$out->reset();
		foreach ( $messages as $message ) {
			// Stamp with _output constant, not $this->name (pre-built differs).
			$this->stamp_message( $message, Node_Names::OUTPUT );
			// Ingress does NOT sign: authority comes from the minter.
			$base_interpreter->fill( $message );
		}

		if ( ! $out->sent_headers ) {
			// Nothing written back: say 401, else ack the onward route.
			( $this->send_header )( $this->refused_a_command ? 401 : 202 );
		}
		$this->finish();
	}

	/**
	 * Reset the refusal latch and hand back this request's authorize policy.
	 *
	 * @return \Closure(Command_Interpreter_Node,array<int,mixed>):bool
	 */
	private function fresh_verifier(): \Closure {
		$this->refused_a_command = false;
		return \Closure::fromCallable( [ $this, 'authorize_and_latch' ] );
	}

	/**
	 * Decode the JSONL request body into an ordered list of Messages: one packed
	 * Message per line through `Message::unpacked()`, blank lines skipped.
	 *
	 * @param string $body Raw request body.
	 * @return array<int,array<int,mixed>> The batch, in the order posted.
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
	 * Build the request-scope graph if this process has none yet (idempotent),
	 * and name this instance `_output` so replies land in the HTTP body.
	 *
	 * Only the naming is this door's own. `Bootstrap::mount_request_graph()`
	 * builds `_router` and `_command_interpreter` and fires
	 * `newspack_nodes/request_graph_ready` for the service CIs, shared with every
	 * other command door so no door ends up with a different verb surface behind
	 * it.
	 *
	 * @return Command_Interpreter_Node The base interpreter the batch fills.
	 */
	private function ensure_request_graph(): Command_Interpreter_Node {
		$base_interpreter = Bootstrap::mount_request_graph();
		// The graph vocabulary declares no per-verb roles; pin it at MANAGE.
		$base_interpreter->required_capability = Capabilities::MANAGE;
		// A pre-built _output holds the name; the batch answers through it.
		if ( ! Core::node( Node_Names::OUTPUT ) instanceof self ) {
			$this->name( Node_Names::OUTPUT );
		}
		return $base_interpreter;
	}

	/**
	 * End the request. Production calls `exit` so the REST server cannot append
	 * its own JSON envelope to the JSONL body already written; test mode returns
	 * instead, leaving the process alive for assertions.
	 */
	private function finish(): void {
		if ( ! $this->test_mode ) {
			exit;
		}
	}

	/**
	 * Answer 500 with one TM_RESPONSE|TM_ERROR frame addressed back along the
	 * triggering message's FROM, so a client reads the failure as a Message
	 * rather than as an HTML error page it cannot unpack.
	 *
	 * @param array<int,mixed> $message The Message that triggered the error.
	 * @param string           $err     Reason, carried in the frame's VALUE.
	 */
	private function emit_error( array $message, string $err ): void {
		\status_header( 500 );
		\header( 'Content-Type: application/json' );
		$r                   = Message::new_message();
		$r[ Message::TYPE ]  = Message::TM_RESPONSE | Message::TM_ERROR;
		$r[ Message::FROM ]  = '_command';
		$r[ Message::TO ]    = $message[ Message::FROM ];
		$r[ Message::ID ]    = $message[ Message::ID ];
		$r[ Message::VALUE ] = $err;
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo Message::packed( $r );
	}

	/**
	 * This request's authorize policy: `Command_Auth`'s verifier, latching any
	 * refusal so `dispatch()` answers 401 instead of a reassuring 202.
	 *
	 * The latch is raised BEFORE the verifier runs and lowered only on success,
	 * because the verifier logs its refusal through the interpreter and that log
	 * line can reach `fill()` and open the body — by which point the status is
	 * spent.
	 *
	 * Named rather than an inline closure for the same reason
	 * `Command_Auth::authorize_command` is: the int-keyed Message type is honored
	 * end to end.
	 *
	 * @param Command_Interpreter_Node $interpreter Node handling the command.
	 * @param array<int,mixed>         $message     Command to authorize.
	 * @return bool True when the command may dispatch.
	 */
	public function authorize_and_latch( Command_Interpreter_Node $interpreter, array $message ): bool {
		$refused_before          = $this->refused_a_command;
		$this->refused_a_command = true;
		$ok                      = ( Command_Auth::verifier() )( $interpreter, $message );
		$this->refused_a_command = $refused_before || ! $ok;
		return $ok;
	}

	/**
	 * Clear the sent-status latch. `dispatch()` calls it on the `_output` node it
	 * resolved, so a second batch in the same process starts with its status
	 * still available to send.
	 */
	public function reset(): void {
		$this->sent_headers = false;
	}

	/**
	 * Toggle test mode, which makes `finish()` return instead of calling `exit`.
	 *
	 * @api Support for unit tests.
	 * @param bool $on True to return from `finish()`.
	 */
	public function set_test_mode( bool $on ): void {
		$this->test_mode = $on;
	}

	/**
	 * Register `POST /newspack-nodes/v1/command`. It declares no `args`: the body
	 * is a JSONL batch that `messages_from_body()` parses itself.
	 *
	 * @api Wired from Bootstrap::register_rest_routes().
	 */
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
	 * Hidden from the palette and target-less: this Node exists only as the
	 * `_output` boundary of a `/command` request, so nothing builds one through
	 * `make_node` and it has nowhere to forward.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return [
			'category'    => 'Hidden',
			'description' => '/command response-writer Node (registered as `_output` at request scope).',
			'arguments'   => [],
			'commands'    => [],
			'has_target'  => false,
		];
	}
}
