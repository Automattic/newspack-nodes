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
 * Routing is uniform: every message goes through Router, and nothing branches
 * to sort local work from IPC, because a worker's input `Partition` Node IS the
 * IPC hop.
 *
 * Each incoming message is stamped with the `_output` boundary name. A client
 * sends a bare reply path — `_output`, `_sse:{session}/{node}`, or an empty
 * FROM — and never spells the boundary itself, so a plain reply comes straight
 * back down this response body while a session-scoped `_sse:{session}` reply
 * reaches the right browser tab through `HTTP_Filter_Node` in the SSE stream
 * process.
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
use Newspack_Nodes\Partition_Node;
use Newspack_Nodes\Rate_Limit;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Worker_Should_Stop;

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
	 * Default per-user budget of `/command` calls per RATE_LIMIT_WINDOW_S. The
	 * topology console fans out a handful of catalog requests on mount and
	 * dispatches commands at the speed the operator types, well under 30 a
	 * second. The cap bounds a buggy script hammering the endpoint, not normal
	 * use; the `newspack_nodes/command_rate_limit` filter raises it.
	 */
	public const RATE_LIMIT_BURST = 30;

	/**
	 * Slot TTL, in seconds. Memcached counts expiry in whole seconds, so at 1 a
	 * slot frees within the second it was claimed in and the budget is close
	 * to one bucket per cache tick; the gain over a counter is the atomic claim.
	 */
	public const RATE_LIMIT_WINDOW_S = 1;

	/** REST namespace the route registers under. */
	public const REST_NAMESPACE = 'newspack-nodes/v1';

	/** Route within that namespace; the full path is `/newspack-nodes/v1/command`. */
	public const ROUTE = '/command';

	/** Why `door_refusal()` refuses a roleless caller anything else. */
	private const COMMANDS_ALONE = 'a caller holding no role sends a bare command to an interpreter alone';

	/** Why `door_refusal()` refuses a message bound past where the graph meant. */
	private const UNROUTED = 'the door routes a command to an interpreter, or a message to a node this POST mounted';

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
	 * This POST's verifier, which reads each session once for the batch.
	 *
	 * @var ?\Closure(Command_Interpreter_Node,array<int,mixed>):bool
	 */
	private ?\Closure $verify = null;

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
	 * Gate the request on the fleet site, then a signed-in user, then the
	 * per-user rate limit. The login is checked before the rate limit so an
	 * unauthenticated burst cannot spend a user's slots — the ordering
	 * `Spawn_Controller` uses.
	 *
	 * The door demands the LEAST any command behind it needs, and authority is
	 * then decided per command by what its schema declares, which `dispatch()`
	 * holds MANAGE for a command that declares none (ADR-26). A command may
	 * declare a WordPress capability, which any signed-in user may hold, so
	 * the least is a login; every role-declared command still refuses a
	 * caller below its role. Demanding MANAGE here would make the strictest
	 * command set the privilege level of every caller, leaving the log
	 * aggregator holding an administrator's application password to pull a
	 * read-only stream.
	 *
	 * @param \WP_REST_Request $req Request; the gate reads nothing from it.
	 * @return bool|\WP_Error True to proceed, false with nobody signed in, a 403 off the fleet site, a 429 over budget.
	 */
	public function check_permission( \WP_REST_Request $req ) {
		$gate = Bootstrap::fleet_gate();
		if ( null !== $gate ) {
			return $gate;
		}
		if ( 0 === Core::current_user_id() ) {
			return false;
		}
		return $this->check_rate_limit();
	}

	/**
	 * Per-user rate limit through `Rate_Limit::gate()`, keyed by user id. With
	 * no shared cache to claim in, or one whose slot read fails, the door
	 * admits and warns: every dashboard, Status poll and hub push rides
	 * `/command`, and a dead memcached must not take all of them down with it.
	 *
	 * @return true|\WP_Error True to proceed, a 429 over budget.
	 */
	private function check_rate_limit(): true|\WP_Error {
		/**
		 * Tunable budget per RATE_LIMIT_WINDOW_S, clamped to 1 through
		 * `Rate_Limit::MAX_BURST`. Defaults to RATE_LIMIT_BURST.
		 *
		 * @param int $burst Max `/command` POSTs per user per window.
		 */
		$burst = Core::as_int( \apply_filters( 'newspack_nodes/command_rate_limit', self::RATE_LIMIT_BURST ) );
		return Rate_Limit::gate( '/command', 'command:' . Core::current_user_id(), $burst, self::RATE_LIMIT_WINDOW_S );
	}

	/**
	 * Route one POSTed batch and answer it.
	 *
	 * The batch fills the base interpreter in the order posted, serially: a
	 * client that sends `connect_worker_input` ahead of the command it enables
	 * depends on that order holding. What it wrote into a Partition is flushed
	 * before the status is decided, so a failed write never answers 202.
	 *
	 * Each message the door will not route (`door_refusal()`) is refused at
	 * its turn, so a mount earlier in the batch opens the way for a message
	 * after it, and answered with a refusal frame after the batch
	 * (`boundary_refusal()`).
	 *
	 * The reply decides the status. A synchronous reply walks back to `fill()`,
	 * which has already sent 200 or 401; when the request gets no synchronous
	 * reply, the work routed onward and this answers 202, its replies due on
	 * the client's open SSE stream. A request-scope graph missing `_router` or
	 * `_output` answers 500 through `emit_error()` instead.
	 *
	 * @param \WP_REST_Request $request Request whose body is the JSONL batch.
	 * @throws \InvalidArgumentException When the body carries no parseable Message.
	 * @throws \Throwable What flushing the Partitions the batch wrote threw.
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
		$refused  = [];
		$roleless = null === Capabilities::highest_held();
		foreach ( $messages as $message ) {
			$reason = self::door_refusal( $message, $roleless );
			if ( null !== $reason ) {
				$refused[] = [ $message, $reason ];
				continue;
			}
			$this->stamp_message( $message, Node_Names::OUTPUT );
			// Ingress does NOT sign: authority comes from the minter.
			$base_interpreter->fill( $message );
		}
		self::flush_partitions();
		// After the batch: the 401 latch must settle first.
		foreach ( $refused as [ $message, $reason ] ) {
			$this->drop_message( $message, $reason );
			$out->fill( self::boundary_refusal( $message, $reason ) );
		}

		if ( ! $out->sent_headers ) {
			// Nothing written back: say 401, else ack the onward route.
			( $this->send_header )( $this->refused_a_command ? 401 : 202 );
		}
		$this->finish();
	}

	/**
	 * Land what the batch wrote into a Partition — a worker's IPC input above
	 * all. A request runs no event loop, so a Partition's flush timer never
	 * fires, and the explicit flush is the only one: every Partition is
	 * attempted, and every failure escapes after the last.
	 *
	 * @throws \Throwable What the flushes threw, combined by `Worker_Should_Stop::raise()`.
	 */
	private static function flush_partitions(): void {
		Worker_Should_Stop::raise(
			Worker_Should_Stop::attempt_each(
				\array_filter( Core::$nodes_by_name, static fn ( Node $node ): bool => $node instanceof Partition_Node ),
				static fn ( Partition_Node $partition ) => $partition->flush()
			)
		);
	}

	/**
	 * Why the door will not route $message, or null when it routes. The door
	 * routes a message only where the request graph meant it to go
	 * (ADR-23). For a caller holding a role that is:
	 *
	 * - a TO whose head names no node, an empty TO included, which only the
	 *   bounce or the Router answers: the base interpreter bounces a TM_PING
	 *   or TM_EOF and hands the rest to the Router, which answers
	 *   NOT_AVAILABLE;
	 * - a request command TO one interpreter by its bare name, which verifies
	 *   the command and gates it on its declared role;
	 * - any message TO a node a gated mount built in this POST
	 *   (`Bootstrap::door_mounted()`), a worker's input or a Table, past
	 *   whose head the worker or the mount answers for it.
	 *
	 * A request-scope node a mount did not build, such as a producer's own
	 * Topic, and a path through an interpreter, which forwards unverified,
	 * are refused. A caller holding no role may send a bare TM_COMMAND to an
	 * interpreter or to a name holding nothing alone, since its `none`
	 * session runs `wp:` commands alone. The path check is asked, not
	 * attempted: see `boundary_refusal()`.
	 *
	 * @param array<int,mixed> $message  A posted message.
	 * @param bool             $roleless Whether the caller holds no role.
	 * @return string|null The refusal, as the frame's VALUE says it.
	 */
	private static function door_refusal( array $message, bool $roleless ): ?string {
		$type            = $message[ Message::TYPE ];
		[ $head, $rest ] = Message::split_first( Core::as_string( $message[ Message::TO ] ) );
		$named           = '' === $head ? null : Core::node( $head );
		$to_ci           = '' === $rest && ( null === $named || $named instanceof Command_Interpreter_Node );
		return match ( true ) {
			! self::can_stamp( $message, Node_Names::OUTPUT ) => 'path exceeded ' . Node::MAX_FROM_SIZE . ' bytes',
			$roleless => Message::TM_COMMAND === $type && $to_ci ? null : self::COMMANDS_ALONE,
			null === $named, Message::is_request_command( $type ) && $to_ci, Bootstrap::door_mounted( $head ) => null,
			default => self::UNROUTED,
		};
	}

	/**
	 * The reply a message refused AT the boundary gets, addressed back along the
	 * FROM the client sent — unstamped, because stamping may be what failed.
	 *
	 * Without it the batch answers as if it routed: `stamp_message()` warns to
	 * stderr, the request-scope stderr sink writes that warning into `_output`,
	 * and the client reads a 200 carrying a `stderr` frame that retires no ask.
	 * A client tracking replies by ID then waits for one that will never come.
	 *
	 * The boundary ASKS `Node::can_stamp()` rather than attempting the stamp,
	 * and both the diagnostic and this frame are emitted after the batch: once a
	 * request graph exists `Core::stderr` routes into `_output`, and `fill()`
	 * decides the status on its first write, so a drop warned inside the loop
	 * opened the response body and spent the status on 200 before a later
	 * unauthorized command could raise the 401 latch. The latch is NOT raised
	 * here — neither an overflowing path nor an unroutable message is a
	 * signature failure, and a 401 makes `HTTP_Out_Node` forget its
	 * session and re-handshake, which for a message the client keeps sending
	 * is a loop.
	 *
	 * @param array<int,mixed> $message The message the boundary refused.
	 * @param string           $reason  Why, as the frame's VALUE says.
	 * @return array<int,mixed> A TM_RESPONSE|TM_ERROR frame carrying its ID.
	 */
	private static function boundary_refusal( array $message, string $reason ): array {
		$r                   = Message::new_message();
		$r[ Message::TYPE ]  = Message::TM_RESPONSE | Message::TM_ERROR;
		$r[ Message::FROM ]  = Node_Names::OUTPUT;
		$r[ Message::TO ]    = $message[ Message::FROM ];
		$r[ Message::ID ]    = $message[ Message::ID ];
		$r[ Message::VALUE ] = "{$reason}\n";
		return $r;
	}

	/**
	 * Reset the refusal latch, build this POST's batch verifier, and hand
	 * back this request's authorize policy.
	 *
	 * @return \Closure(Command_Interpreter_Node,array<int,mixed>):bool
	 */
	private function fresh_verifier(): \Closure {
		$this->refused_a_command = false;
		$this->verify            = Command_Auth::batch_verifier();
		return \Closure::fromCallable( [ $this, 'authorize_and_latch' ] );
	}

	/**
	 * Decode the JSONL request body into an ordered list of Messages: one packed
	 * Message per line through `Message::unpacked()`, blank lines skipped.
	 *
	 * @param string $body Raw request body.
	 * @return array<int,array<int,mixed>> The batch, in the order posted.
	 * @throws \InvalidArgumentException When every line fails to parse to a
	 *                                   Message.
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
	 * This door owns only the naming. `Bootstrap::mount_request_graph()`
	 * builds `_router` and `_command_interpreter` and fires
	 * `newspack_nodes/request_graph_ready` for the service CIs, shared with every
	 * other command door so a door never ends up with a different command surface
	 * behind it.
	 *
	 * @return Command_Interpreter_Node The base interpreter the batch fills.
	 */
	private function ensure_request_graph(): Command_Interpreter_Node {
		$base_interpreter = Bootstrap::mount_request_graph();
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
	 * because an environment fault the verifier reports to stderr — no cache to
	 * claim the nonce in, a session store that will not answer — can reach
	 * `fill()` and open the body, by which point the status is spent. Its
	 * refusal reasons never do: `Command_Auth` writes them to the error log
	 * alone, so every command it judges and refuses answers the same bytes.
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
		$ok                      = ( $this->verify ?? Command_Auth::batch_verifier() )( $interpreter, $message );
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
	 * `_output` boundary of a `/command` request, so it is never built through
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
