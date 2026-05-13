<?php
/**
 * Topology Console SSE stream.
 *
 * Attaches to a live worker via the same IPC paths `wp nodes cli` uses,
 * issues `ls -al` (initial) + periodic `ls -ct` (live counters) commands,
 * and forwards every Message on the worker's output Partition as an SSE
 * event. Inspect-only; no edit mode in v1.
 *
 * Mirrors the cli's pivoted-REPL contract: same IPC paths, same FROM
 * stamping (`_output/$pid`), same TM_COMMAND → `_command_interpreter`
 * routing. The frontend is essentially a long-lived cli session that
 * happens to render React Flow.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Callback;
use Newspack_Nodes\Cli;
use Newspack_Nodes\Consumer;
use Newspack_Nodes\Core;
use Newspack_Nodes\Message;
use Newspack_Nodes\Partition;

\defined( 'ABSPATH' ) || exit;

class TopologyStreamController {
	use SSE_Stream_Trait;

	public const REST_NAMESPACE = 'newspack-nodes/v1';

	public const STATS_INTERVAL_S     = 1.0;
	public const UPTIME_INTERVAL_S    = 5.0;
	public const HEARTBEAT_INTERVAL_S = 5.0;
	public const LOOP_SLEEP_US        = 50_000;

	private int $test_tick_limit = 0;

	public function set_test_tick_limit( int $n ): void {
		$this->test_tick_limit = $n;
	}

	/** Override seam for tests — production uses Bootstrap::base_dir(). */
	private ?string $base_dir_override = null;

	/**
	 * Override seam for tests — production loops on connection_aborted().
	 * Test mode does one drain pass and returns so ob_start()/ob_get_clean()
	 * can capture the emitted SSE bytes synchronously.
	 */
	private bool $test_mode = false;

	public function set_base_dir( string $dir ): void {
		$this->base_dir_override = $dir;
	}

	public function set_test_mode( bool $on ): void {
		$this->test_mode = $on;
	}

	public function register_routes(): void {
		\register_rest_route(
			self::REST_NAMESPACE,
			'/topology/(?P<topology>[a-z0-9_-]+)/p(?P<partition>\d+)/stream',
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'stream' ],
				'permission_callback' => [ $this, 'stream_permissions_check' ],
				'args'                => [
					'topology'  => [ 'required' => true, 'type' => 'string' ],
					'partition' => [ 'required' => true, 'type' => 'integer' ],
				],
			]
		);
		// Companion POST that writes a single TM_COMMAND on behalf of the
		// REPL footer. FROM is stamped with the sse_pid the frontend captured
		// from the corresponding stream's `hello` event so the worker's
		// reply routes back to the active SSE listener.
		\register_rest_route(
			self::REST_NAMESPACE,
			'/topology/(?P<topology>[a-z0-9_-]+)/p(?P<partition>\d+)/command',
			[
				'methods'             => 'POST',
				'callback'            => [ $this, 'post_command' ],
				'permission_callback' => [ $this, 'stream_permissions_check' ],
				'args'                => [
					'topology'  => [ 'required' => true, 'type' => 'string' ],
					'partition' => [ 'required' => true, 'type' => 'integer' ],
					// One of: 'command' (default), 'ping', 'info',
					// 'bytestream', 'eof', 'request'. Mirrors the message
					// types the cli Shell can build (Shell::ping_node,
					// tell_node, send_node, send_eof, request_node).
					'type'      => [ 'required' => false, 'type' => 'string' ],
					// For 'command' type: verb name. For other types the
					// arguments string is the payload.
					'name'      => [ 'required' => false, 'type' => 'string' ],
					'arguments' => [ 'required' => false, 'type' => 'string' ],
					// Destination path for typed verbs ('tell foo', 'send foo',
					// 'cmd foo verb', etc.). Empty/omitted = address the
					// worker's _command_interpreter directly.
					'to'        => [ 'required' => false, 'type' => 'string' ],
					'sse_pid'   => [ 'required' => true, 'type' => 'integer' ],
				],
			]
		);
	}

	/**
	 * POST companion to the SSE stream. Parses {name, arguments, sse_pid}
	 * from the request body, opens the worker's input Partition, writes a
	 * single TM_COMMAND addressed to _command_interpreter with FROM stamped
	 * as the SSE session's `_output/{sse_pid}` so the reply lands on that
	 * session's reply Consumer.
	 */
	public function post_command( \WP_REST_Request $request ) {
		$topology  = (string) $request->get_param( 'topology' );
		$partition = (int) $request->get_param( 'partition' );
		$type      = \strtolower( (string) ( $request->get_param( 'type' ) ?? 'command' ) );
		$name      = \trim( (string) ( $request->get_param( 'name' ) ?? '' ) );
		$arguments = (string) ( $request->get_param( 'arguments' ) ?? '' );
		$to        = (string) ( $request->get_param( 'to' ) ?? '' );
		$sse_pid   = (int) $request->get_param( 'sse_pid' );

		if ( $sse_pid <= 0 ) {
			return new \WP_Error(
				'missing_sse_pid',
				'sse_pid must be a positive integer (the pid from the hello event)',
				[ 'status' => 400 ]
			);
		}
		if ( 'command' === $type && '' === $name ) {
			return new \WP_Error(
				'empty_command',
				'name is required for type=command',
				[ 'status' => 400 ]
			);
		}

		$base_dir = $this->base_dir_override ?? Bootstrap::base_dir();
		$cli      = new Cli( $base_dir );
		try {
			$ipc = $cli->attach_to_worker( "{$topology}.p{$partition}" );
		} catch ( \InvalidArgumentException $e ) {
			return new \WP_Error(
				'worker_not_found',
				$e->getMessage(),
				[ 'status' => 404 ]
			);
		}

		// User-typed commands carry no KEY — they should look identical
		// to what `wp nodes cli` sends.
		$cmd_out = new Partition( $ipc['input'], 0 );
		$this->write_typed_message( $cmd_out, $type, $name, $arguments, $to, $sse_pid );
		$cmd_out->flush();

		return new \WP_REST_Response( [ 'queued' => true ], 202 );
	}

	/**
	 * Build and write a Message of the requested type to the worker's
	 * input Partition. Mirrors the type-dispatch in cli Shell::interpret()
	 * so the GUI can drive any of the verb shapes the cli supports
	 * without having to write its own Shell from scratch.
	 *
	 * `command` (default) → TM_COMMAND addressed at $to (or
	 *                       `_command_interpreter` if empty).
	 * `ping`              → TM_PING with VALUE = current timestamp;
	 *                       receiving CommandInterpreter bounces TO=FROM.
	 * `info`              → TM_INFO addressed at $to, VALUE = $arguments.
	 * `bytestream`        → TM_BYTESTREAM addressed at $to, VALUE = $arguments.
	 * `eof`               → TM_EOF addressed at $to (drain marker).
	 * `request`           → TM_REQUEST addressed at $to, VALUE = $arguments.
	 */
	private function write_typed_message(
		Partition $cmd_out,
		string $type,
		string $name,
		string $arguments,
		string $to,
		int $sse_pid
	): void {
		$msg                       = Message::new_message();
		$msg[ Message::TIMESTAMP ] = Core::$now;
		$msg[ Message::ID ]        = (string) Core::msg_counter();
		$msg[ Message::FROM ]      = '_output/' . $sse_pid;
		switch ( $type ) {
			case 'ping':
				$msg[ Message::TYPE ]  = Message::TM_PING;
				$msg[ Message::TO ]    = '' !== $to ? $to : '_command_interpreter';
				$msg[ Message::VALUE ] = (string) Core::$now;
				break;
			case 'info':
				$msg[ Message::TYPE ]  = Message::TM_INFO;
				$msg[ Message::TO ]    = $to;
				$msg[ Message::VALUE ] = $arguments;
				break;
			case 'bytestream':
				$msg[ Message::TYPE ]  = Message::TM_BYTESTREAM;
				$msg[ Message::TO ]    = $to;
				$msg[ Message::VALUE ] = $arguments;
				break;
			case 'eof':
				$msg[ Message::TYPE ] = Message::TM_EOF;
				$msg[ Message::TO ]   = $to;
				break;
			case 'request':
				$msg[ Message::TYPE ]  = Message::TM_REQUEST;
				$msg[ Message::TO ]    = $to;
				$msg[ Message::VALUE ] = $arguments;
				break;
			case 'command':
			default:
				$msg[ Message::TYPE ]  = Message::TM_COMMAND;
				$msg[ Message::TO ]    = '' !== $to ? $to : '_command_interpreter';
				$msg[ Message::VALUE ] = (string) \wp_json_encode(
					[
						'name'      => $name,
						'arguments' => $arguments,
						'payload'   => '',
					]
				);
				break;
		}
		$cmd_out->fill( $msg );
	}

	public function stream( \WP_REST_Request $request ) {
		$topology  = (string) $request->get_param( 'topology' );
		$partition = (int) $request->get_param( 'partition' );
		$base_dir  = $this->base_dir_override ?? Bootstrap::base_dir();
		$cli       = new Cli( $base_dir );
		try {
			$ipc = $cli->attach_to_worker( "{$topology}.p{$partition}" );
		} catch ( \InvalidArgumentException $e ) {
			return new \WP_Error(
				'worker_not_found',
				$e->getMessage(),
				[ 'status' => 404 ]
			);
		}
		// Skip init_sse_headers() in test mode — it calls ob_end_clean
		// which would consume our test's outer ob_start() capture buffer.
		if ( ! $this->test_mode ) {
			$this->init_sse_headers();
		}

		$this->send_sse_event(
			'hello',
			[
				'topology'  => $topology,
				'partition' => $partition,
				'pid'       => \getmypid(),
			]
		);

		$cmd_out  = new Partition( $ipc['input'],  0 );
		$reply_in = new Consumer(  $ipc['output'], 0, '' );
		// Tests pre-populate the output Partition with messages BEFORE
		// attaching, so we read from segment start. Production attaches to
		// a live worker and only cares about new traffic — read from end.
		$reply_in->next_offset( $this->test_mode ? 'start' : 'end' );

		// `dump_metadata` is the single per-poll command that gives the
		// GUI everything it needs to render the graph: per-node class,
		// counter, sink, target(s), debug_state, arguments. Replaces
		// the old `ls -als` + `ls -ct` pair. KEY=gui:auto so the
		// frontend routes responses to the canvas-refresh path
		// silently, distinct from user-typed commands which surface
		// in the transcript.
		$this->send_command( $cmd_out, 'dump_metadata', '', null, 'gui:auto' );
		// Initial uptime fire — alongside the first dump_metadata, so the
		// Inspector's Process section has a value to show on first paint.
		$this->send_command( $cmd_out, 'uptime', '', null, 'gui:uptime' );
		$cmd_out->flush();

		$this->drain_and_forward( $reply_in );
		$this->flush_if_needed();

		// Production drain / poll loop. Runs until connection_aborted()
		// (real streaming) or until $test_tick_limit ticks have fired
		// (tests). Tick 1 was the initial ls -al above; each subsequent
		// iteration that hits the STATS_INTERVAL_S window fires one ls -ct.
		$last_stats     = \microtime( true );
		$last_uptime    = \microtime( true );
		$last_heartbeat = \microtime( true );
		$ticks_fired    = 1;

		while ( true ) {
			$now = \microtime( true );

			if ( $now - $last_stats >= self::STATS_INTERVAL_S ) {
				$this->send_command( $cmd_out, 'dump_metadata', '', null, 'gui:auto' );
				$cmd_out->flush();
				$last_stats = $now;
				++$ticks_fired;
			}

			if ( $now - $last_uptime >= self::UPTIME_INTERVAL_S ) {
				$this->send_command( $cmd_out, 'uptime', '', null, 'gui:uptime' );
				$cmd_out->flush();
				$last_uptime = $now;
			}

			if ( $now - $last_heartbeat >= self::HEARTBEAT_INTERVAL_S ) {
				$this->send_sse_event( 'heartbeat', [ 'ts' => $now ] );
				$last_heartbeat = $now;
			}

			$this->drain_and_forward( $reply_in );
			$this->flush_if_needed();

			if ( $this->test_mode ) {
				if ( $ticks_fired >= $this->test_tick_limit ) {
					return null;
				}
				// Force the next iteration to immediately fire a stats
				// tick instead of waiting a real 1s in test time.
				\usleep( 100 );
				$last_stats     = 0.0;
				$last_uptime    = 0.0;
				$last_heartbeat = 0.0;
				continue;
			}

			if ( \connection_aborted() ) {
				return null;
			}

			\usleep( self::LOOP_SLEEP_US );
		}
	}

	/**
	 * Build a TM_COMMAND addressed to the worker's _command_interpreter and
	 * write it to the worker's input Partition. Mirrors what Shell does when
	 * the user types `<verb> <args>` at the cli prompt: FROM=`_output/$pid`
	 * so worker replies route back via the worker-side `_router` peel of
	 * `_output` to TO=$pid, which our reply_in Consumer picks up.
	 *
	 * The optional $route_to_pid argument lets the POST companion stamp
	 * FROM with the SSE session's pid (from its `hello` event) instead of
	 * its own request pid, so worker replies route back to the listener
	 * that's actually streaming to the browser.
	 */
	private function send_command(
		Partition $cmd_out,
		string $name,
		string $arguments,
		?int $route_to_pid = null,
		string $key = ''
	): void {
		$pid                       = $route_to_pid ?? \getmypid();
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_COMMAND;
		$msg[ Message::TIMESTAMP ] = Core::$now;
		$msg[ Message::ID ]        = (string) Core::msg_counter();
		$msg[ Message::FROM ]      = '_output/' . $pid;
		$msg[ Message::TO ]        = '_command_interpreter';
		// KEY is correlation metadata: user-typed commands stamp it with
		// `gui:typed` so the frontend can distinguish their responses
		// from auto-fired snapshot refreshes that leave KEY empty.
		$msg[ Message::KEY ]       = $key;
		$msg[ Message::VALUE ]     = (string) \wp_json_encode(
			[
				'name'      => $name,
				'arguments' => $arguments,
				'payload'   => '',
			]
		);
		$cmd_out->fill( $msg );
	}

	/**
	 * Drain whatever's pending on the worker's output Consumer and forward
	 * each Message as an SSE `msg` event. Wires a Callback sink that calls
	 * back into emit_message_as_sse() per Message.
	 */
	private function drain_and_forward( Consumer $reply_in ): void {
		$controller = $this;
		$sink       = new Callback(
			static function ( array &$message ) use ( $controller ): void {
				$controller->emit_message_as_sse( $message );
			}
		);
		$reply_in->sink( $sink );
		$reply_in->poll();
	}

	/**
	 * Encode a single Message envelope as an SSE `msg` event.
	 *
	 * Public so the Callback closure in drain_and_forward() can reach it
	 * (closure binding through `use ($controller)` keeps it scoped to a
	 * single request lifetime).
	 *
	 * VALUE is decoded one level when it's a JSON envelope (TM_COMMAND
	 * payloads are `{"name":...,"payload":...}` strings on the wire) so
	 * the frontend doesn't double-decode.
	 */
	public function emit_message_as_sse( array $message ): void {
		// Multi-session TO filter — same rule the substrate Dumper applies.
		// PASS when TO is either:
		//   * empty       — async broadcasts, TM_INFO, prompt fan-out,
		//                   debug_state traces. These aren't addressed to
		//                   anyone in particular; every listener sees them.
		//   * _output/$pid or $pid — a reply addressed to THIS SSE session.
		// DROP everything else (other cli/SSE sessions' replies that
		// happen to share this worker's output partition).
		$to           = (string) ( $message[ Message::TO ] ?? '' );
		$pid          = (string) \getmypid();
		$is_broadcast = '' === $to;
		$is_for_us    = (bool) \preg_match(
			'/^(?:_output\/)?' . \preg_quote( $pid, '/' ) . '$/',
			$to
		);
		if ( ! $is_broadcast && ! $is_for_us ) {
			return;
		}

		$value = $message[ Message::VALUE ] ?? '';
		if ( \is_string( $value ) && '' !== $value && ( '{' === $value[0] || '[' === $value[0] ) ) {
			$decoded = \json_decode( $value, true );
			if ( \is_array( $decoded ) ) {
				$value = $decoded;
			}
		}
		$this->send_sse_event(
			'msg',
			[
				'type'  => $message[ Message::TYPE ]      ?? 0,
				'ts'    => $message[ Message::TIMESTAMP ] ?? 0,
				'from'  => $message[ Message::FROM ]      ?? '',
				'to'    => $message[ Message::TO ]        ?? '',
				'id'    => $message[ Message::ID ]        ?? '',
				'key'   => $message[ Message::KEY ]       ?? '',
				'value' => $value,
			]
		);
	}
}
