<?php
/**
 * SSE_Out: double-duty Node + `/messages/stream` controller. As a Node its
 * `fill()` emits each Message as an SSE `msg` event (the egress writer the
 * SSE-process graph sinks into); as a controller it registers
 * `GET /messages/stream` and runs the drain loop.
 *
 * One SSE endpoint for every subscription the dashboards need (firehose /
 * errors / completed / IPC worker outputs). The resolver treats log
 * partitions and worker IPC partitions uniformly — both surface as
 * `Consumer` instances the caller drains in a single loop.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
use Newspack_Nodes\Config;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\HTTP_Filter_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;

\defined( 'ABSPATH' ) || exit;

class SSE_Out_Node extends Node {
	use SSE_Stream_Trait;

	public const REST_NAMESPACE = 'newspack-nodes/v1';
	public const ROUTE          = '/messages/stream';

	// Idle-keepalive heartbeat cadence (ms). Data flushes every drain tick regardless;
	// this only paces the idle heartbeat. 2s matches the dashboards' refresh.
	public const HEARTBEAT_MS = 2000;

	/** Test seam: overrides `Bootstrap::base_dir()`. */
	private ?string $base_dir = null;

	/** Test seam: overrides `Config::load_config()['num_partitions']`. */
	private ?int $num_partitions = null;

	/**
	 * `Cli::attach_to_worker` seam. Lazily defaulted; tests reassign in setUp.
	 *
	 * Signature: `function ( string $worker_id, string $base_dir ): array`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $attach_to_worker = null;

	/**
	 * SSE slot-pool seams. The application wires these in to gate concurrent
	 * SSE connections; unset → acquire returns slot 1, release/check are no-ops.
	 *
	 *   * acquire: `function ( int $partition ): int|false` (-1 shared browser
	 *     pool, >=0 per-partition; false → HTTP 429 before headers).
	 *   * release: `function ( int $slot, int $partition ): void` (drain `finally`).
	 *   * check:   `function ( int $slot, int $partition ): bool` (false aborts).
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $acquire_slot = null;
	public static ?\Closure $release_slot = null;
	public static ?\Closure $check_slot   = null;

	/**
	 * Test seam: bounded drain loop. Production loops on `connection_aborted()`;
	 * test_mode counts iterations so ob_get_clean() can capture SSE bytes.
	 */
	private bool $test_mode = false;
	private int  $test_iterations = 0;

	/** Node egress (terminal, not forwarded): emits each Message as an SSE `msg` event. */
	public function fill( array &$message ): void {
		++$this->counter;
		$this->send_sse_event( 'msg', $message );
	}

	public function set_base_dir( string $dir ): void {
		$this->base_dir = $dir;
	}

	public function set_num_partitions( int $n ): void {
		$this->num_partitions = $n;
	}

	public function set_test_mode( bool $on ): void {
		$this->test_mode = $on;
	}

	public function set_test_iterations( int $n ): void {
		$this->test_iterations = $n;
	}

	public function register_routes(): void {
		\register_rest_route(
			self::REST_NAMESPACE,
			self::ROUTE,
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'stream' ],
				// Capability-only gate (auth resolved upstream by the REST dispatcher).
				// Don't add a nonce check — it would break the cross-server SSE pull.
				'permission_callback' => static fn () => \current_user_can( 'manage_options' ),
				'args'                => [
					'subscribe' => [ 'required' => true, 'type' => 'string' ],
					'positions' => [ 'required' => false, 'type' => 'string' ],
				],
			]
		);
	}

	/**
	 * Split the CSV `subscribe` query parameter into trimmed subscription
	 * names. Empty/blank entries dropped so stray commas don't produce ghosts.
	 *
	 * @return array<int,string>
	 */
	public function parse_subscriptions( string $raw ): array {
		if ( '' === $raw ) {
			return [];
		}
		$parts = \array_map( 'trim', \explode( ',', $raw ) );
		return \array_values( \array_filter( $parts, static fn ( $s ) => '' !== $s ) );
	}

	/**
	 * Resolve a subscription name to one-or-more `Consumer`s.
	 *
	 * Two shapes: `{type}.p{N}` (IPC reader, resolved via
	 * `Cli::attach_to_worker`) and `{a-z0-9_-}` (log feed, one Consumer per
	 * partition under `{base}/logs/{name}.log`). Anything else throws
	 * `InvalidArgumentException` (path-traversal guard for query input).
	 * `$positions` (keyed by partition) seed each cursor; absent → tail-seek.
	 *
	 * @param string                $sub       Subscription name.
	 * @param array<int,mixed>|null $positions Saved positions, indexed by partition.
	 *
	 * @return array<int,Consumer_Node>
	 *
	 * @throws \InvalidArgumentException When `$sub` matches no allowed shape.
	 */
	public function open_subscription( string $sub, ?array $positions ): array {
		$base = $this->base_dir ?? Bootstrap::base_dir();

		if ( \preg_match( '/^([a-z0-9_-]+)\.p(\d+)$/', $sub, $m ) ) {
			$attach = self::$attach_to_worker ?? static function ( string $worker_id, string $base_dir ): array {
				return ( new CLI( $base_dir ) )->attach_to_worker( $worker_id );
			};
			try {
				$ipc = $attach( $sub, $base );
				// Empty offsetlog_base_dir disables checkpointing — ephemeral sessions tail-seek.
				$consumer = new Consumer_Node( $ipc['output'], 0, '' );
				$consumer->next_offset( 'end' );
				$consumer->set_stamp_as( $sub );
				return [ $consumer ];
			} catch ( \InvalidArgumentException $e ) {
				// No live worker (no lock dir). If its IPC output dir still exists, the
				// worker is down-but-restarting (e.g. mid fleet-restart): tail THAT so
				// the session re-binds when the worker respawns and appends replies —
				// the live console recovers without a page reload / topology switch.
				$ipc_output = "{$base}/ipc/{$sub}/output";
				if ( \is_dir( $ipc_output ) ) {
					$consumer = new Consumer_Node( $ipc_output, 0, '' );
					$consumer->next_offset( 'end' );
					$consumer->set_stamp_as( $sub );
					return [ $consumer ];
				}
				// Genuinely no worker IPC — fall through to the log-file path. This is the
				// aggregator hub's path: `firehose.p0` has no worker but a log dir exists.
				$log_name  = $m[1];
				$partition = (int) $m[2];
				$log_base  = "{$base}/logs/{$log_name}.log";
				$consumer  = new Consumer_Node( $log_base, $partition, '' );
				if ( isset( $positions[ $partition ] ) ) {
					$consumer->next_offset( $positions[ $partition ] );
				} else {
					$consumer->next_offset( 'end' );
				}
				$consumer->set_stamp_as( $sub );
				return [ $consumer ];
			}
		}

		if ( \preg_match( '/^[a-z0-9_-]+$/', $sub ) ) {
			$log_base   = "{$base}/logs/{$sub}.log";
			$partitions = $this->num_partitions ?? (int) ( Config::load_config()['num_partitions'] ?? 1 );
			$consumers  = [];
			for ( $p = 0; $p < $partitions; $p++ ) {
				$consumer = new Consumer_Node( $log_base, $p, '' );
				if ( isset( $positions[ $p ] ) ) {
					$consumer->next_offset( $positions[ $p ] );
				} else {
					$consumer->next_offset( 'end' );
				}
				// Stamp `{sub}.p{N}` so the dashboard JS can parse partition from the Message FROM field.
				$consumer->set_stamp_as( "{$sub}.p{$p}" );
				$consumers[] = $consumer;
			}
			return $consumers;
		}

		throw new \InvalidArgumentException(
			\esc_html( "invalid subscription: {$sub}" )
		);
	}

	/**
	 * Decode the `positions` query parameter (JSON object keyed by
	 * subscription name). Null when omitted/empty/malformed → tail-seek all.
	 *
	 * @return array<string,array>|null
	 */
	public function parse_positions( string $raw ): ?array {
		if ( '' === $raw ) {
			return null;
		}
		$decoded = \json_decode( $raw, true );
		return \is_array( $decoded ) ? $decoded : null;
	}

	/**
	 * Stream handler — parses params, sets SSE headers, delegates the drain
	 * loop to `run_stream_loop()`.
	 *
	 * Slot acquisition fires BEFORE `init_sse_headers` so a rate-limited
	 * stream can still return a JSON `WP_Error` (HTTP 429).
	 */
	public function stream( \WP_REST_Request $request ) {
		$subs      = $this->parse_subscriptions( (string) $request->get_param( 'subscribe' ) );
		$positions = $this->parse_positions( (string) ( $request->get_param( 'positions' ) ?? '' ) );
		$interval  = self::HEARTBEAT_MS;

		$partition = $this->subscription_partition( $subs );
		$acquire   = self::$acquire_slot ?? static fn ( int $p ): int => 1;
		$slot      = $acquire( $partition );
		if ( false === $slot ) {
			return new \WP_Error(
				'too_many_connections',
				'Maximum concurrent SSE streams reached. Close other tabs or wait.',
				[ 'status' => 429 ]
			);
		}

		$this->init_sse_headers();
		$this->run_stream_loop( $subs, $positions, $interval, $slot, $partition );
		exit;
	}

	/**
	 * Compute the partition the slot pool keys on. IPC-shape (`{type}.p{N}`)
	 * → that partition (first wins); log-shape or empty → `-1` (browser pool).
	 *
	 * @param array<int,string> $subs
	 */
	private function subscription_partition( array $subs ): int {
		foreach ( $subs as $sub ) {
			if ( \preg_match( '/^[a-z0-9_-]+\.p(\d+)$/', $sub, $m ) ) {
				return (int) $m[1];
			}
		}
		return -1;
	}

	/**
	 * Drain loop body — split out from `stream()` so tests can call without
	 * the headers / exit. Emits the `connected` envelope, builds the
	 * SSE-process substrate graph, opens one-or-more Consumers per
	 * subscription, and drains until the should_continue gate flips false.
	 * Cleanup in `finally` removes every node. The drain predicate consults
	 * `$check_slot` each iteration; `finally` calls `$release_slot`.
	 *
	 * @param array<int,string>        $subs      Subscription names.
	 * @param array<string,array>|null $positions Per-subscription saved positions.
	 * @param int                      $interval  Heartbeat / flush cadence ms.
	 * @param int                      $slot      Acquired slot index (default 1 = unmetered).
	 * @param int                      $partition Slot-pool partition (-1 = shared browser).
	 */
	public function run_stream_loop( array $subs, ?array $positions, int $interval, int $slot = 1, int $partition = -1 ): void {
		// `connected` emits before the graph is built (registers no nodes), so it stays outside try.
		$this->send_sse_event( 'msg', $this->build_connected_msg( $slot, $subs, $interval ) );
		// A bare flush() doesn't clear fastcgi/nginx buffers; the FLUSH_SIZE padding does.
		$this->flush_if_needed();

		$consumers = [];
		try {
			// Build INSIDE the try so finally cleans up even when open_subscription
			// throws — otherwise the next request hits a `_router already registered` collision.
			( new Router_Node() )->name( Node_Names::ROUTER );
			// This controller IS the SSE egress Node; reached by TO=`_sse`. Named so
			// broadcasts (and this process's stderr) route to the client through it.
			$this->name( Node_Names::SSE );
			$http_filter = new HTTP_Filter_Node( (int) \getmypid() );
			$http_filter->name( Node_Names::HTTP );
			$http_filter->sink( $this );

			// SSE-process CI (Tachikoma rule #2: things sink into _command_interpreter
			// → _router). A worker can drive it (`cmd _repl/_command_interpreter …`);
			// such stream commands are HMAC-signed (the cli signed them; LOCAL is
			// stripped at the wire), so authorize with the verifier like the worker.
			Command_Interpreter_Node::$default_authorize = Command_Auth::verifier();
			$ci = new Command_Interpreter_Node();
			$ci->name( Node_Names::COMMAND_INTERPRETER );
			$ci->sink( Core::node( Node_Names::ROUTER ) );

			// The ONE exceptional non-CI sink: Consumers sink HERE, not straight into
			// the CI, because a Consumer would FORCE TO=target() on EVERY message if it
			// had a target (it does that to keep commands/requests from leaking out of
			// non-IPC partitions) — which would clobber reply breadcrumbs. A plain Node
			// uses the DEFAULT fill(): it stamps TO=`_sse` only when TO is EMPTY, else
			// leaves TO and forwards. So: empty-TO worker broadcasts (stderr/events) →
			// TO=`_sse` → egress; non-empty-TO replies keep their breadcrumb → `_http`.
			// A command addressed `_command_interpreter` (TO non-empty here) is NOT
			// stamped; the CI forwards it to `_router`, which peels `_command_interpreter`
			// and re-delivers it to the CI with TO now empty — THEN it interprets. So the
			// _router round-trip is load-bearing; don't "simplify" it away.
			$default_route = new Node();
			$default_route->name( '_default_route' );
			$default_route->sink( $ci );
			$default_route->target( Node_Names::SSE );

			foreach ( $subs as $sub ) {
				$pos = $positions[ $sub ] ?? null;
				foreach ( $this->open_subscription( $sub, $pos ) as $c ) {
					// A log sub yields one Consumer per partition, so suffix the index
					// to keep names unique (Node::name throws on collision).
					$c->name( $sub . ':consumer:' . \count( $consumers ) );
					$c->sink( $default_route );
					$consumers[] = $c;
				}
			}

			// Heartbeat every $interval ms so dashboards can tell an idle-but-live
			// stream from a dead one (quiet topologies would otherwise go dark).
			$heartbeat_interval = \max( 0.1, $interval / 1000.0 );
			$last_heartbeat     = \microtime( true );
			$iterations         = 0;
			Event_Framework::instance()->drain(
				function () use ( &$iterations, &$last_heartbeat, $heartbeat_interval, $slot, $partition ): bool {
					if ( $this->test_mode && ++$iterations > $this->test_iterations ) {
						return false;
					}
					$check = self::$check_slot;
					if ( null !== $check && ! $check( $slot, $partition ) ) {
						return false;
					}
					if ( ! $this->test_mode && \connection_aborted() ) {
						return false;
					}
					$now = \microtime( true );
					if ( ( $now - $last_heartbeat ) >= $heartbeat_interval ) {
						$this->send_sse_event(
							'heartbeat',
							[ 'ts' => $now ]
						);
						$last_heartbeat = $now;
					}
					// Flush before the framework sleeps so this tick's msgs + heartbeats reach the client.
					$this->flush_if_needed();
					return true;
				}
			);
		} finally {
			foreach ( $consumers as $c ) {
				$c->remove_node();
			}
			$default_route = Core::node( '_default_route' );
			if ( $default_route instanceof Node ) {
				$default_route->remove_node();
			}
			$ci = Core::node( Node_Names::COMMAND_INTERPRETER );
			if ( $ci instanceof Command_Interpreter_Node ) {
				$ci->remove_node();
			}
			$http = Core::node( Node_Names::HTTP );
			if ( $http instanceof HTTP_Filter_Node ) {
				$http->remove_node();
			}
			$router = Core::node( Node_Names::ROUTER );
			if ( $router instanceof Router_Node ) {
				$router->remove_node();
			}
			// Drop the `_sse` egress name mapping (the controller instance persists).
			Core::unregister_node( Node_Names::SSE );
			$release = self::$release_slot;
			if ( null !== $release ) {
				$release( $slot, $partition );
			}
		}
	}

	/**
	 * Build the `connected` Message envelope the SSE client expects first:
	 * session pid (pivoted-command FROM stamp), slot index, the opened
	 * subscriptions (echoed back), and the heartbeat/flush interval.
	 *
	 * @param array<int,string> $subs
	 */
	private function build_connected_msg( int $slot, array $subs, int $interval ): array {
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_INFO;
		// connected fires before the drain loop seeds `Core::$now`; fall back to microtime().
		$msg[ Message::TIMESTAMP ] = 0.0 !== Core::$now ? Core::$now : \microtime( true );
		$msg[ Message::FROM ]      = '_stream';
		$msg[ Message::KEY ]       = 'connected';
		$msg[ Message::VALUE ]     = [
			'pid'           => \getmypid(),
			'slot'          => $slot,
			'subscriptions' => $subs,
			'interval'      => $interval,
		];
		return $msg;
	}
}
