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

use Newspack_Nodes\Capabilities;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\CLI;
use Newspack_Nodes\Command_Auth;
use Newspack_Nodes\Command_Interpreter_Node;
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

	/** Flush-comment total byte size. Must stay under PIPE_BUF (4096 on Linux). */
	public const FLUSH_SIZE = 4096;

	// Idle heartbeat cadence (ms); data flushes every tick regardless. 2s.
	public const HEARTBEAT_MS = 2000;

	/** @var non-falsy-string */
	public const REST_NAMESPACE = 'newspack-nodes/v1';

	/** @var non-falsy-string Late-static-bound so a subclass overrides just the route. */
	public const ROUTE = '/messages/stream';

	/**
	 * Allow-list of event names emitted without sanitization (O(1) hot-path).
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

	/**
	 * SSE slot-pool seams. The application wires these in to gate concurrent
	 * SSE connections; unset → acquire returns slot 1, release/check are no-ops.
	 *
	 * acquire: `function ( int $partition ): int|false` (-1 shared browser
	 * pool, >=0 per-partition; false → HTTP 429 before headers).
	 *
	 * @var \Closure(int): (int|false)|null
	 */
	public static ?\Closure $acquire_slot = null;

	/**
	 * check: `function ( int $slot, int $partition ): bool` (false aborts).
	 *
	 * @var \Closure(int, int): bool|null
	 */
	public static ?\Closure $check_slot   = null;

	/**
	 * release: `function ( int $slot, int $partition ): void` (drain `finally`).
	 *
	 * @var \Closure(int, int): void|null
	 */
	public static ?\Closure $release_slot = null;

	/** Has anything been emitted since the last flush? */
	protected bool $needs_flush = false;

	/** Test seam: overrides `Bootstrap::base_dir()`. */
	private ?string $base_dir = null;

	/** Node egress (terminal, not forwarded): emits each Message as an SSE `msg` event. */
	public function fill( array $message ): void {
		++$this->counter;
		$this->send_sse_event( 'msg', $message );
	}

	/**
	 * Stream handler — parses params, sets SSE headers, delegates the drain
	 * loop to `run_stream_loop()`.
	 *
	 * Slot acquisition fires BEFORE `init_sse_headers` so a rate-limited
	 * stream can still return a JSON `WP_Error` (HTTP 429).
	 *
	 * @return \WP_Error|void WP_Error on rate-limit (429); otherwise streams and exits.
	 */
	public function stream( \WP_REST_Request $request ) {
		$subscribe     = $request->get_param( 'subscribe' );
		$positions_raw = $request->get_param( 'positions' ) ?? '';
		$subs          = $this->parse_subscriptions( Core::as_string( $subscribe ) );
		$positions     = $this->parse_positions( Core::as_string( $positions_raw ) );
		$interval      = self::HEARTBEAT_MS;

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

		\set_time_limit( 0 );
		$this->init_sse_headers();
		$this->run_stream_loop( $subs, $positions, $interval, $slot, $partition );
		exit;
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
	 * Decode the `positions` query parameter (JSON object keyed by
	 * subscription name). Null when omitted/empty/malformed → tail-seek all.
	 *
	 * @return array<array-key, mixed>|null
	 */
	public function parse_positions( string $raw ): ?array {
		if ( '' === $raw ) {
			return null;
		}
		$decoded = \json_decode( $raw, true );
		return \is_array( $decoded ) ? $decoded : null;
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
	 * @param array<int,string>             $subs      Subscription names.
	 * @param array<array-key, mixed>|null  $positions Per-subscription saved positions.
	 * @param int                      $interval  Heartbeat / flush cadence ms.
	 * @param int                      $slot      Acquired slot index (default 1 = unmetered).
	 * @param int                      $partition Slot-pool partition (-1 = shared browser).
	 */
	public function run_stream_loop( array $subs, ?array $positions, int $interval, int $slot = 1, int $partition = -1 ): void {
		// connected emits outside try (no nodes yet); own SSE event type.
		$this->send_sse_event( 'connected', $this->build_connected_msg( $slot, $subs, $interval ) );
		// A bare flush() doesn't clear proxy buffers; FLUSH_SIZE padding does.
		$this->flush_if_needed();

		$consumers = [];
		try {
			// Build INSIDE try so finally cleans up (else _router collides).
			( new Router_Node() )->name( Node_Names::ROUTER );

			// SSE-process interpreter → _router; authorize with the verifier.
			Command_Interpreter_Node::$default_authorize = Command_Auth::verifier();
			$interpreter = new Command_Interpreter_Node();
			$interpreter->name( Node_Names::COMMAND_INTERPRETER );
			$interpreter->sink( Core::node( Node_Names::ROUTER ) );

			// This controller IS the SSE egress Node; reached by TO=_sse.
			$this->name( Node_Names::SSE );
			$this->sink( $interpreter );

			$http_filter = new HTTP_Filter_Node( (int) \getmypid() );
			$http_filter->name( Node_Names::OUTPUT );
			$http_filter->sink( $this );
			// SSE egress plumbing — patron-linked so dump_metadata hides it.
			$http_filter->patron( $this );

			// Consumers sink to a plain Node; keep the _router round-trip.
			$default_route = new Node();
			$default_route->name( '_default_route' );
			$default_route->sink( $interpreter );
			$default_route->target( Node_Names::SSE );
			$default_route->patron( $this );

			$glob_subs  = [];
			$glob_owned = [];
			foreach ( $subs as $sub ) {
				$is_glob = \str_contains( $sub, '*' );
				if ( $is_glob ) {
					$glob_subs[] = $sub;
				}
				// Positions are a FLAT { dir: pos } map; pass the whole thing.
				$opened = $this->open_subscription(
					$sub,
					\is_array( $positions ) ? $positions : null
				);
				foreach ( $opened as $c ) {
					$name = $c->stamped_as();
					$this->attach_consumer( $c, $consumers, $default_route );
					if ( $is_glob && isset( $consumers[ $name ] ) ) {
						$glob_owned[ $name ] = true;
					}
				}
			}

			// Heartbeat every $interval ms so an idle-but-live stream ≠ dead.
			$heartbeat_interval = \max( 0.1, $interval / 1000.0 );
			$last_heartbeat     = \microtime( true );
			Event_Framework::instance()->drain(
				function () use ( &$last_heartbeat, &$consumers, &$glob_owned, $glob_subs, $default_route, $heartbeat_interval, $slot, $partition ): bool {
					$check = self::$check_slot;
					if ( null !== $check && ! $check( $slot, $partition ) ) {
						return false;
					}
					if ( \connection_aborted() ) {
						return false;
					}
					$now = \microtime( true );
					if ( ( $now - $last_heartbeat ) >= $heartbeat_interval ) {
						$this->send_sse_event( 'heartbeat', $this->build_heartbeat_msg( $now ) );
						// Self-heal glob subs against the live filesystem.
						if ( ! empty( $glob_subs ) ) {
							$this->reconcile_glob_consumers( $glob_subs, $consumers, $glob_owned, $default_route );
						}
						$last_heartbeat = $now;
					}
					// Flush before sleep so this tick reaches the client.
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
			$interpreter = Core::node( Node_Names::COMMAND_INTERPRETER );
			if ( $interpreter instanceof Command_Interpreter_Node ) {
				$interpreter->remove_node();
			}
			$http = Core::node( Node_Names::OUTPUT );
			if ( $http instanceof HTTP_Filter_Node ) {
				$http->remove_node();
			}
			$router = Core::node( Node_Names::ROUTER );
			if ( $router instanceof Router_Node ) {
				$router->remove_node();
			}
			// Drop the _sse egress name mapping (controller instance persists).
			Core::unregister_node( Node_Names::SSE );
			$release = self::$release_slot;
			if ( null !== $release ) {
				$release( $slot, $partition );
			}
		}
	}

	/**
	 * Emit a single SSE event. SAFE_EVENTS pass through; anything else is
	 * sanitized via `sanitize_event_name()`. JSON-encodes the payload.
	 *
	 * @param string            $event   Event name.
	 * @param array<int, mixed> $message 7-field positional Message.
	 */
	protected function send_sse_event( string $event, array $message ): void {
		$event = $this->sanitize_event_name( $event );
		if ( '' === $event ) {
			throw new \InvalidArgumentException( 'SSE event name is empty after sanitization; refusing to emit a nameless event.' );
		}
		$json    = Message::packed( $message );
		$payload = "event: {$event}\ndata: {$json}\n\n";
		// SSE wire must reach the client byte-for-byte; escaping corrupts it.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo $payload;
		@\flush();
		$this->needs_flush = true;
	}

	/**
	 * Strip everything outside [a-zA-Z0-9_-] from an unsafe event name (SSE
	 * `event:` line injection defense). SAFE_EVENTS pass through verbatim.
	 *
	 * @param string $event Caller-supplied event name.
	 * @return string Sanitized event name (may be empty).
	 */
	protected function sanitize_event_name( string $event ): string {
		if ( isset( self::SAFE_EVENTS[ $event ] ) ) {
			return $event;
		}
		return (string) \preg_replace( '/[^a-zA-Z0-9_-]/', '', $event );
	}

	/**
	 * Resolve a subscription to one-or-more `Consumer`s, layout-agnostically.
	 *
	 * `$sub` is a concrete resource dir NAME or a glob over one — no `.p{N}`
	 * parsing. An exact name with a live IPC worker (`{base}/ipc/{sub}/output`)
	 * tails that; otherwise it globs `{base}/logs/{sub}` (exact name → itself,
	 * `firehose.*` → one Consumer per matching partition dir), each stamped +
	 * resume-keyed by its concrete dir basename. A traversal-guarded pattern
	 * (name-char lead, no `/`, no `..`, `*` the only wildcard) confines glob to
	 * logs/ipc; anything else throws. `$positions` (keyed by dir basename) seed
	 * each cursor; absent → tail-seek. A valid pattern matching nothing → [].
	 *
	 * @param string                      $sub       Subscription name or glob.
	 * @param array<array-key,mixed>|null $positions Saved positions, keyed by dir basename.
	 *
	 * @return array<int,Consumer_Node>
	 *
	 * @throws \InvalidArgumentException When `$sub` fails the traversal guard.
	 */
	public function open_subscription( string $sub, ?array $positions ): array {
		$base = $this->base_dir ?? Bootstrap::base_dir();

		// Traversal guard: must start with a name char (blocks `.*` / `..`).
		if ( ! \preg_match( '/^[a-z0-9_-][a-z0-9_.*-]*$/D', $sub ) || \str_contains( $sub, '..' ) ) {
			throw new \InvalidArgumentException(
				\esc_html( "invalid subscription: {$sub}" )
			);
		}

		// Exact IPC reader wins: a live worker's output partition.
		if ( ! \str_contains( $sub, '*' ) ) {
			$ipc_output = "{$base}/ipc/{$sub}/output";
			if ( \is_dir( $ipc_output ) ) {
				$consumer = new Consumer_Node();
				$consumer->arguments( [ $ipc_output ] );
				$consumer->next_offset( 'end' );
				$consumer->set_stamp_as( $sub );
				return [ $consumer ];
			}
		}

		// Log feed: one Consumer per glob-matched dir (exact name → itself).
		$consumers = [];
		foreach ( self::matched_log_dirs( $base, $sub ) as $dir ) {
			$name        = \basename( $dir );
			$consumers[] = $this->log_consumer_for( $dir, $name, $positions );
		}
		return $consumers;
	}

	/**
	 * Concrete log-partition dirs under `{base}/logs` matching a subscription
	 * pattern; an exact name matches itself. Layout-agnostic — the partition
	 * token sits wherever the producer put it in the dir name.
	 *
	 * @return array<int,string> Absolute dir paths, sorted (glob's default order).
	 */
	private static function matched_log_dirs( string $base, string $sub ): array {
		$matches = \glob( "{$base}/logs/{$sub}", \GLOB_ONLYDIR );
		return false === $matches ? [] : $matches;
	}

	/**
	 * Self-heal glob subscriptions against the live filesystem: open a Consumer
	 * for each newly-appeared matching dir (tail-seek — it appeared after connect)
	 * and remove_node one whose dir vanished (partitions increasing OR decreasing).
	 * Only glob-OPENED names (`$glob_owned`) are removed — an exact IPC/log
	 * subscription is never touched. A `glob()` I/O error skips the removal pass
	 * (keep what we have) so a transient logs/ read failure can't tear down and
	 * re-tail every partition, only re-add on a trusted (error-free) scan.
	 *
	 * @api Called on the drain heartbeat; also unit-tested directly.
	 *
	 * @param array<int,string>           $glob_subs  Subscriptions containing `*`.
	 * @param array<string,Consumer_Node> $consumers  Live map (by dir basename), mutated in place.
	 * @param array<string,bool>          $glob_owned Names opened by a glob (removable), mutated in place.
	 */
	public function reconcile_glob_consumers( array $glob_subs, array &$consumers, array &$glob_owned, Node $route ): void {
		$base    = $this->base_dir ?? Bootstrap::base_dir();
		$wanted  = [];
		$glob_ok = true;
		foreach ( $glob_subs as $sub ) {
			$matches = \glob( "{$base}/logs/{$sub}", \GLOB_ONLYDIR );
			if ( false === $matches ) {
				$glob_ok = false; // I/O error — not a trustworthy "nothing wanted".
				continue;
			}
			foreach ( $matches as $dir ) {
				$wanted[ \basename( $dir ) ] = $dir;
			}
		}
		foreach ( $wanted as $name => $dir ) {
			if ( ! isset( $consumers[ $name ] ) ) {
				$this->attach_consumer( $this->log_consumer_for( $dir, $name, null ), $consumers, $route );
				if ( isset( $consumers[ $name ] ) ) {
					$glob_owned[ $name ] = true;
				}
			}
		}
		if ( ! $glob_ok ) {
			return; // partial view: add only this round, never remove.
		}
		foreach ( $consumers as $name => $c ) {
			if ( isset( $wanted[ $name ] ) || ! isset( $glob_owned[ $name ] ) ) {
				continue;
			}
			$c->remove_node();
			unset( $consumers[ $name ], $glob_owned[ $name ] );
		}
	}

	/**
	 * Build a Consumer tailing one concrete log-partition dir, stamped +
	 * resume-keyed by its basename (matching the FROM the browser parses).
	 *
	 * @param array<array-key,mixed>|null $positions Saved positions by dir name.
	 */
	private function log_consumer_for( string $dir, string $name, ?array $positions ): Consumer_Node {
		$consumer = new Consumer_Node();
		$consumer->arguments( [ $dir ] );
		$consumer->next_offset(
			isset( $positions[ $name ] ) ? self::position_arg( $positions[ $name ] ) : 'end'
		);
		$consumer->set_stamp_as( $name );
		return $consumer;
	}

	/**
	 * Name a Consumer by its dir-basename stamp, wire it into the SSE graph, and
	 * add it to the live $consumers map. Skips a name already open (dedup).
	 *
	 * @param array<string,Consumer_Node> $consumers Live map, mutated in place.
	 */
	private function attach_consumer( Consumer_Node $c, array &$consumers, Node $route ): void {
		$name = $c->stamped_as();
		if ( '' === $name || isset( $consumers[ $name ] ) ) {
			return;
		}
		$c->name( $name );
		$c->sink( $route );
		$c->patron( $this );
		$consumers[ $name ] = $c;
	}

	/**
	 * Narrow a saved-position value to the `string|array<string,mixed>` shape
	 * `Consumer_Node::next_offset()` accepts; non-array scalars pass as a magic
	 * string, anything else falls back to 'start' (next_offset's default case).
	 *
	 * @param mixed $position Raw per-partition position.
	 * @return array<array-key,mixed>|string
	 */
	protected static function position_arg( $position ) {
		if ( \is_array( $position ) ) {
			return $position;
		}
		return Core::as_string( $position, 'start' );
	}

	/**
	 * Build the `connected` Message envelope the SSE client expects first:
	 * session pid (attached-command FROM stamp), slot index, the opened
	 * subscriptions (echoed back), and the heartbeat/flush interval.
	 *
	 * @param array<int,string> $subs
	 * @return array<int, mixed> The 7-field positional Message.
	 */
	private function build_connected_msg( int $slot, array $subs, int $interval ): array {
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_INFO;
		// connected fires before the drain seeds Core::$now; use microtime().
		$message[ Message::TIMESTAMP ] = 0.0 !== Core::$now ? Core::$now : \microtime( true );
		$message[ Message::FROM ]      = '_stream';
		$message[ Message::KEY ]       = 'connected';
		// TM_INFO values are STRINGS: flat KEY VALUE, space-free tokens.
		$message[ Message::VALUE ]     = \implode( ' ', [
			'PID',           (string) \getmypid(),
			'SLOT',          (string) $slot,
			'SUBSCRIPTIONS', \implode( ',', $subs ),
			'INTERVAL',      (string) $interval,
		] );
		return $message;
	}

	/**
	 * Build a `heartbeat` Message envelope
	 *
	 * @param float $now Current timestamp.
	 * @return array<int, mixed> The 7-field positional Message.
	 */
	private function build_heartbeat_msg( float $now ): array {
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_INFO;
		$message[ Message::FROM ]      = '_stream';
		$message[ Message::KEY ]       = 'heartbeat';
		$message[ Message::VALUE ]     = (string) $now;
		return $message;
	}

	/**
	 * Disable every buffering layer between PHP and the browser so SSE events
	 * stream incrementally (output buffers, zlib, mod_deflate, nginx).
	 */
	protected function init_sse_headers(): void {
		// phpcs:disable WordPress.PHP.IniSet.Risky
		@\ini_set( 'zlib.output_compression', false );
		@\ini_set( 'implicit_flush', true );
		// phpcs:enable

		while ( \ob_get_level() > 0 ) {
			\ob_end_clean();
		}

		if ( \function_exists( 'apache_setenv' ) ) {
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.runtime_configuration_apache_setenv
			@\apache_setenv( 'no-gzip', '1' );
		}

		\header( 'Content-Type: text/event-stream' );
		\header( 'Cache-Control: no-cache, no-store, must-revalidate' );
		\header( 'Connection: keep-alive' );
		\header( 'X-Accel-Buffering: no' );
		\header( 'Content-Encoding: none' );
	}

	/**
	 * If anything has been sent since the last flush, emit a FLUSH_SIZE SSE
	 * comment to push pending events past any proxy/TLS buffer. Idempotent.
	 *
	 * Wire format: `:` + (FLUSH_SIZE-3) dots + "\n\n". NO space after the
	 * colon — framing the dashboard React hooks expect.
	 */
	protected function flush_if_needed(): void {
		if ( ! $this->needs_flush ) {
			return;
		}
		// SSE comment line — must reach the client byte-for-byte.
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo ':' . \str_repeat( '.', self::FLUSH_SIZE - 3 ) . "\n\n";
		@\flush();
		$this->needs_flush = false;
	}

	/** @api Support for unit tests. */
	public function set_base_dir( string $dir ): void {
		$this->base_dir = $dir;
	}

	public function register_routes(): void {
		\register_rest_route(
			static::REST_NAMESPACE,
			static::ROUTE,
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'stream' ],
				// Capability-only gate; NO nonce (breaks cross-server pull).
				'permission_callback' => static fn () => \function_exists( 'current_user_can' ) && Capabilities::can( Capabilities::READ ),
				'args'                => [
					'subscribe' => [ 'required' => true, 'type' => 'string' ],
					'positions' => [ 'required' => false, 'type' => 'string' ],
				],
			]
		);
	}
}
