<?php
/**
 * Messages_Stream_Controller: one SSE endpoint for every subscription the
 * dashboards need (firehose / errors / completed / IPC worker outputs).
 * Replaces six legacy per-feed SSE controllers in
 * `newspack-event-logger-nodes` once M5 lands. The resolver treats log
 * partitions and worker IPC partitions uniformly — both surface as
 * `Consumer` instances the caller drains in a single loop.
 *
 * Task 17 (this file) wires the route, the CSV splitter, and the
 * subscription → Consumer resolver. Task 18 fills in the drain loop;
 * `stream()` returns a `{pending: true}` JSON placeholder until then.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes\Rest;

use Newspack_Nodes\Bootstrap;
use Newspack_Nodes\Callback;
use Newspack_Nodes\Cli;
use Newspack_Nodes\Config;
use Newspack_Nodes\Consumer;
use Newspack_Nodes\Core;
use Newspack_Nodes\EventFramework;
use Newspack_Nodes\HTTP_Filter;
use Newspack_Nodes\Message;
use Newspack_Nodes\Router;

\defined( 'ABSPATH' ) || exit;

class Messages_Stream_Controller {
	use SSE_Helpers_Trait;

	public const REST_NAMESPACE = 'newspack-nodes/v1';
	public const ROUTE          = '/messages/stream';

	/**
	 * Test seam: overrides `Bootstrap::base_dir()` so unit tests can point
	 * the resolver at an isolated temp directory without touching Config.
	 */
	private ?string $base_dir = null;

	/**
	 * Test seam: overrides `Config::load_config()['num_partitions']` so
	 * log-partition subscriptions can be sized in a unit test without
	 * writing a per-test config file.
	 */
	private ?int $num_partitions = null;

	/**
	 * `Cli::attach_to_worker` seam. Lazily defaulted to a closure that
	 * wraps the real call; tests that need IPC isolation reassign in
	 * setUp. See `~/.claude/rules/test-seams.md`.
	 *
	 * Signature: `function ( string $reader_id, string $base_dir ): array`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $attach_to_worker = null;

	/**
	 * SSE slot-pool seams. The substrate stays generic; the application
	 * (newspack-event-logger-nodes) wires these in during bootstrap to
	 * gate concurrent SSE connections via Memcached_Cache.
	 *
	 * When unset (substrate-only test runs, or any environment that does
	 * not want concurrency caps), acquire returns slot 1, release/check
	 * are no-ops, and the stream proceeds without rate-limiting.
	 *
	 *   * acquire: `function ( int $partition ): int|false`
	 *       - `-1` for the shared browser pool, `>=0` for a per-partition
	 *         aggregator pool (RemoteSource cross-server pull).
	 *       - returns the slot index on success, or `false` to signal
	 *         rate-limit (controller returns HTTP 429 before headers).
	 *   * release: `function ( int $slot, int $partition ): void`
	 *       - runs in the drain-loop `finally`, even on disconnect.
	 *   * check:   `function ( int $slot, int $partition ): bool`
	 *       - polled per drain iteration; false aborts the stream.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $acquire_slot = null;
	public static ?\Closure $release_slot = null;
	public static ?\Closure $check_slot   = null;

	/**
	 * Test seam: bounded drain loop. Production loops on
	 * `connection_aborted()` (real streaming); test_mode counts iterations
	 * up to `$test_iterations` and returns so `ob_start()` / `ob_get_clean()`
	 * can capture the emitted SSE bytes synchronously without blocking on a
	 * non-existent HTTP socket.
	 */
	private bool $test_mode = false;
	private int  $test_iterations = 0;

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
				// Capability-only gate. WordPress's REST dispatcher resolves
				// `determine_current_user` BEFORE this fires, so this works
				// transparently for either auth path the dashboards / cross-
				// server pull use:
				//   * cookie + `_wpnonce` (browser EventSource)
				//   * `Authorization: Basic <login:app-password>` via core's
				//     Application Password handler (RemoteSource / StreamMerger)
				// Don't add a nonce check here — that would silently break
				// the cross-server SSE pull.
				'permission_callback' => static fn () => \current_user_can( 'manage_options' ),
				'args'                => [
					'subscribe' => [ 'required' => true,  'type' => 'string' ],
					'interval'  => [ 'required' => false, 'type' => 'integer', 'default' => 500 ],
					'positions' => [ 'required' => false, 'type' => 'string' ],
				],
			]
		);
	}

	/**
	 * Split the CSV `subscribe` query parameter into trimmed subscription
	 * names. Empty input → empty list; empty entries between commas are
	 * dropped so trailing/leading commas don't produce ghost entries.
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
	 * Two shapes are recognized:
	 *   * `{type}.p{N}`         — IPC reader; one Consumer over the
	 *                             worker's output Partition (no offsetlog
	 *                             because cli/SSE sessions are ephemeral).
	 *                             Resolved via `Cli::attach_to_worker` so
	 *                             a missing worker fails fast.
	 *   * `{a-z0-9_-+}`         — log feed; one Consumer per partition
	 *                             rooted at `{base}/logs/{name}.log`. The
	 *                             caller's saved `$positions` (keyed by
	 *                             partition index) seed each Consumer's
	 *                             cursor; partitions without saved
	 *                             positions tail-seek with `'end'`.
	 *
	 * Anything that matches neither shape throws
	 * `InvalidArgumentException` (path-traversal guard for query input).
	 *
	 * @param string                $sub       Subscription name.
	 * @param array<int,mixed>|null $positions Saved positions, indexed by
	 *                                         partition number; each
	 *                                         value is whatever
	 *                                         `Consumer::next_offset`
	 *                                         accepts (magic string or
	 *                                         `{seg,off}` array).
	 *
	 * @return array<int,Consumer>
	 *
	 * @throws \InvalidArgumentException When `$sub` matches no allowed shape.
	 */
	public function open_subscription( string $sub, ?array $positions ): array {
		$base = $this->base_dir ?? Bootstrap::base_dir();

		if ( \preg_match( '/^[a-z0-9_-]+\.p\d+$/', $sub ) ) {
			$attach = self::$attach_to_worker ?? static function ( string $reader_id, string $base_dir ): array {
				return ( new Cli( $base_dir ) )->attach_to_worker( $reader_id );
			};
			$ipc = $attach( $sub, $base );
			// Empty offsetlog_base_dir disables checkpointing — cli/SSE
			// sessions tail-seek and never resume from a saved position.
			$consumer = new Consumer( $ipc['output'], 0, '' );
			$consumer->next_offset( 'end' );
			$consumer->set_stamp_as( $sub );
			return [ $consumer ];
		}

		if ( \preg_match( '/^[a-z0-9_-]+$/', $sub ) ) {
			$log_base   = "{$base}/logs/{$sub}.log";
			$partitions = $this->num_partitions ?? (int) ( Config::load_config()['num_partitions'] ?? 1 );
			$consumers  = [];
			for ( $p = 0; $p < $partitions; $p++ ) {
				$consumer = new Consumer( $log_base, $p, '' );
				if ( isset( $positions[ $p ] ) ) {
					$consumer->next_offset( $positions[ $p ] );
				} else {
					$consumer->next_offset( 'end' );
				}
				// Stamp `{sub}.p{N}` (matching the IPC subscription shape) so
				// the dashboard JS can parse partition out of the Message FROM
				// field without a sidecar metadata channel. The legacy
				// per-feed SSE controllers carried partition in a `{p, line}`
				// batch payload; on the unified endpoint the per-Message
				// envelope IS the wire format, so partition lives in FROM.
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
	 * subscription name, value is `Consumer::next_offset` shape). Returns
	 * null when omitted/empty/malformed — caller treats null as "no saved
	 * positions; tail-seek every partition".
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
	 * Stream handler — parses request params, sets SSE headers, and
	 * delegates the drain loop to `run_stream_loop()`. The loop method is
	 * extracted so tests can exercise the substrate graph build /
	 * connected envelope / Consumer wiring without the headers + `exit`
	 * gymnastics.
	 *
	 * Slot acquisition fires BEFORE `init_sse_headers` so a rate-limited
	 * stream can still return a JSON `WP_Error` (HTTP 429); after headers
	 * are sent the response body is committed to text/event-stream.
	 */
	public function stream( \WP_REST_Request $request ) {
		$subs      = $this->parse_subscriptions( (string) $request->get_param( 'subscribe' ) );
		$positions = $this->parse_positions( (string) ( $request->get_param( 'positions' ) ?? '' ) );
		$interval  = (int) ( $request->get_param( 'interval' ) ?? 500 );

		$partition = $this->subscription_partition( $subs );
		$acquire   = self::$acquire_slot ?? static fn ( int $p ): int|false => 1;
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
	 * Compute the partition number the slot pool should key on. IPC-shape
	 * subscriptions (`{type}.p{N}`) → that partition; log-shape
	 * subscriptions (or empty list) → `-1` for the shared browser pool.
	 * First IPC sub wins if multiple are present.
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
	 * Drain loop body — split out from `stream()` so tests can call
	 * without the headers / exit. Emits the `connected` envelope, builds
	 * the SSE-process substrate graph (`_router`, `_http`, sink), opens
	 * one-or-more Consumers per subscription, and drains via
	 * `EventFramework::drain()` until the should_continue gate flips
	 * false. Cleanup in `finally` removes every node so the next request
	 * starts with a clean substrate.
	 *
	 * The slot/partition pair is provided by `stream()` after a successful
	 * `$acquire_slot` call; the drain predicate consults `$check_slot`
	 * each iteration so a TTL-expired slot terminates the stream, and the
	 * `finally` block calls `$release_slot` on disconnect or normal exit.
	 *
	 * @param array<int,string>             $subs      Subscription names.
	 * @param array<string,array>|null      $positions Per-subscription saved positions.
	 * @param int                            $interval Heartbeat / flush cadence ms.
	 * @param int                            $slot      Acquired slot index (default 1 = unmetered).
	 * @param int                            $partition Slot-pool partition (-1 = shared browser).
	 */
	public function run_stream_loop( array $subs, ?array $positions, int $interval, int $slot = 1, int $partition = -1 ): void {
		// `connected` envelope emits BEFORE the substrate graph is built —
		// it doesn't register any nodes, so it stays outside the try/finally.
		$this->send_sse_event( 'msg', $this->build_connected_msg( $slot, $subs, $interval ) );

		$consumers   = [];
		$direct_sink = null;
		try {
			// SSE-process substrate graph. Same naming convention as worker
			// processes (`_router`, `_http`) so cli REPL inspection of an SSE
			// process feels the same as inspecting a worker. Build INSIDE the
			// try so the finally cleans up even when open_subscription throws
			// (path-traversal InvalidArgumentException) — otherwise the next
			// SSE request hits `node name collision: _router already registered`.
			( new Router() )->name( '_router' );
			$emit = function ( array $m ): void {
				$this->send_sse_event( 'msg', $m );
			};
			( new HTTP_Filter( (int) \getmypid(), $emit ) )->name( '_http' );

			// Sink for non-pivoted SSE traffic (raw log tails, heartbeats).
			// Empty TO → emit directly. Non-empty TO → route through _router
			// so HTTP_Filter can gate per-session pivoted replies.
			$direct_sink = new Callback(
				static function ( array &$m ) use ( $emit ): void {
					if ( '' === $m[ Message::TO ] ) {
						$emit( $m );
						return;
					}
					$router = Core::node( '_router' );
					if ( null !== $router ) {
						$router->fill( $m );
					}
				}
			);
			$direct_sink->name( '_stream_sink' );

			foreach ( $subs as $sub ) {
				$pos = $positions[ $sub ] ?? null;
				foreach ( $this->open_subscription( $sub, $pos ) as $c ) {
					$c->sink( $direct_sink );
					$consumers[] = $c;
				}
			}

			$iterations = 0;
			EventFramework::instance()->drain(
				function () use ( &$iterations, $slot, $partition ): bool {
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
					return true;
				}
			);
		} finally {
			foreach ( $consumers as $c ) {
				$c->remove_node();
			}
			if ( null !== $direct_sink ) {
				$direct_sink->remove_node();
			}
			$http = Core::node( '_http' );
			if ( $http instanceof HTTP_Filter ) {
				$http->remove_node();
			}
			$router = Core::node( '_router' );
			if ( $router instanceof Router ) {
				$router->remove_node();
			}
			$release = self::$release_slot;
			if ( null !== $release ) {
				$release( $slot, $partition );
			}
		}
	}

	/**
	 * Build the `connected` Message envelope the SSE client expects as the
	 * first event on the stream. Carries the session pid (for pivoted
	 * commands' FROM stamp), slot index (M4: concurrency cap), the list
	 * of subscriptions the server actually opened (echo to confirm the
	 * client's request was parsed), and the heartbeat/flush interval.
	 *
	 * @param array<int,string> $subs
	 */
	private function build_connected_msg( int $slot, array $subs, int $interval ): array {
		$msg                       = Message::new_message();
		$msg[ Message::TYPE ]      = Message::TM_INFO;
		// connected fires BEFORE the drain loop seeds `Core::$now`; fall
		// back to microtime() so the envelope carries a real timestamp.
		$msg[ Message::TIMESTAMP ] = 0.0 !== Core::$now ? Core::$now : \microtime( true );
		$msg[ Message::FROM ]      = '_stream';
		$msg[ Message::KEY ]       = 'connected';
		$msg[ Message::VALUE ]     = [
			'pid'           => \getmypid(),
			'slot'          => $slot,
			'subscriptions' => $subs,
			// TODO(M2/M4): $interval is reflected to the client for cadence display, but
			// the drain loop itself doesn't gate on it — Consumer self-paces. Wire to
			// heartbeat tick when M2 dashboards need it.
			'interval'      => $interval,
		];
		return $msg;
	}
}
