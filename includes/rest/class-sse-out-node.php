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
use Newspack_Nodes\Config;
use Newspack_Nodes\Consumer_Node;
use Newspack_Nodes\Log_Discovery;
use Newspack_Nodes\Core;
use Newspack_Nodes\Event_Framework;
use Newspack_Nodes\HTTP_Filter_Node;
use Newspack_Nodes\Message;
use Newspack_Nodes\Node;
use Newspack_Nodes\Node_Names;
use Newspack_Nodes\Router_Node;
use Newspack_Nodes\Worker_Should_Stop;

\defined( 'ABSPATH' ) || exit;

class SSE_Out_Node extends Node {

	/** Flush-comment total byte size. Must stay under PIPE_BUF (4096 on Linux). */
	public const FLUSH_SIZE = 4096;

	/** Idle heartbeat cadence (ms); data flushes every tick regardless. 2s. */
	public const HEARTBEAT_MS = 2000;

	/** @var non-falsy-string */
	public const REST_NAMESPACE = 'newspack-nodes/v1';

	/** @var non-falsy-string Late-static-bound so a subclass overrides just the route. */
	public const ROUTE = '/messages/stream';

	/** Explicit sentinel lease for direct, unmetered test/default streams. */
	private const UNMETERED_LEASE = [
		'slot'  => -1,
		'owner' => 93939397,
	];

	/**
	 * Allow-list of event names emitted without sanitization (O(1) hot-path).
	 *
	 * @var array<string,int>
	 */
	private const SAFE_EVENTS = [
		'hello'      => 1,
		'msg'        => 1,
		'heartbeat'  => 1,
		'connected'  => 1,
		'disconnect' => 1,
		'retry'      => 1,
		'timeout'    => 1,
	];

	/**
	 * SSE slot-pool seams. The application wires these in to gate concurrent
	 * SSE connections; unset → acquire returns an explicit unmetered lease,
	 * release/check are no-ops.
	 *
	 * acquire: `function ( int $partition ): array|false` (-1 shared browser
	 * pool, >=0 per-partition; false → HTTP 429 before headers).
	 *
	 * @var \Closure(int): (array{slot:int,owner:int}|false)|null
	 */
	public static ?\Closure $acquire_slot = null;

	/**
	 * check: `function ( array $lease, int $partition ): bool` (false aborts).
	 *
	 * @var \Closure(array{slot:int,owner:int}, int): bool|null
	 */
	public static ?\Closure $check_slot   = null;

	/**
	 * release: `function ( array $lease, int $partition ): void` (drain `finally`).
	 *
	 * @var \Closure(array{slot:int,owner:int}, int): void|null
	 */
	public static ?\Closure $release_slot = null;

	/**
	 * Failure-only inspection:
	 * `function ( array $lease, int $partition ): array`.
	 *
	 * @var \Closure(array{slot:int,owner:int}, int): array<string,int|string>|null
	 */
	public static ?\Closure $inspect_slot = null;

	/**
	 * Narrow log seam for asserting the exact redacted context in tests.
	 * Production leaves it null and writes one JSON-encoded error-log line.
	 *
	 * @var \Closure(array<string,mixed>): void|null
	 */
	public static ?\Closure $diagnostic_log = null;

	/** Has anything been emitted since the last flush? */
	protected bool $needs_flush = false;

	/** When this stream last carried DATA; heartbeats deliberately don't count. */
	protected float $last_data = 0.0;

	/** Whether this stream attached to a worker's IPC channel (see `open_subscription`). */
	private bool $is_interactive = false;

	/** Test seam: overrides `Bootstrap::base_dir()`. */
	private ?string $base_dir = null;

	/** Node egress (terminal, not forwarded): emits each Message as an SSE `msg` event. */
	public function fill( array $message ): void {
		++$this->counter;
		$this->last_data = Core::$now ?: Core::right_now();
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
		// `positions` is the ONLY resume input; the client assembles it.
		$positions     = $this->parse_positions( Core::as_string( $positions_raw ) );
		$interval      = self::HEARTBEAT_MS;

		$partition = $this->subscription_partition( $subs );
		$acquire   = self::$acquire_slot ?? static fn ( int $_partition ): array => self::UNMETERED_LEASE;
		$lease     = $acquire( $partition );
		if ( false === $lease ) {
			return new \WP_Error(
				'too_many_connections',
				'Maximum concurrent SSE streams reached. Close other tabs or wait.',
				[ 'status' => 429 ]
			);
		}
		$this->run_acquired_stream( $subs, $positions, $interval, $lease, $partition, true );
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
	 * @return array<array-key,mixed>|null
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
			// A grouped sub pools like its bare sibling: strip the root prefix.
			$slash = \strpos( $sub, '/' );
			if ( false !== $slash && \in_array( \substr( $sub, 0, $slash ), Log_Discovery::GROUPS, true ) ) {
				$sub = \substr( $sub, $slash + 1 );
			}
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
	 * A hard PHP/server/process termination can bypass the terminal event,
	 * diagnostic log, and finally block; the client must retain a distinct
	 * unexplained-EOF path for those failures.
	 *
	 * @param array<int,string>             $subs      Subscription names.
	 * @param array<array-key,mixed>|null  $positions Per-subscription saved positions.
	 * @param int                           $interval  Heartbeat / flush cadence ms.
	 * @param array{slot:int,owner:int}     $lease     Acquired lease (default slot -1 = unmetered).
	 * @param int                           $partition Slot-pool partition (-1 = shared browser).
	 *
	 * @api Direct loop runner for tests that must not send HTTP headers or exit.
	 */
	public function run_stream_loop(
		array $subs,
		?array $positions,
		int $interval,
		array $lease = self::UNMETERED_LEASE,
		int $partition = -1
	): void {
		$this->run_acquired_stream( $subs, $positions, $interval, $lease, $partition, false );
	}

	/**
	 * Protect every operation after acquisition with one diagnostic and cleanup
	 * lifetime. The REST handler includes response setup; direct loop tests do not.
	 *
	 * @param array<int,string>            $subs
	 * @param array<array-key,mixed>|null $positions
	 * @param mixed                        $lease Raw acquire result; validated inside the protected lifetime.
	 */
	private function run_acquired_stream(
		array $subs,
		?array $positions,
		int $interval,
		mixed $lease,
		int $partition,
		bool $initialize_stream
	): void {
		$active_lease       = null;
		$consumers          = [];
		$diagnostic_written = false;
		try {
			Core::right_now(); // seed Core::$now for the drain loop
			$active_lease = self::require_lease( $lease );
			if ( $initialize_stream ) {
				\set_time_limit( 0 );
				\ignore_user_abort( true );
				$this->init_sse_headers();
			}

			// Lead with the reopen schedule; every close relies on it.
			$this->send_sse_event( 'retry', $this->build_retry_msg() );

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
			// Own it: never inherit the last stream's attach classification.
			$this->is_interactive = false;
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

			// @longform Resolve the idle seed FIRST: the lag read behind it
			// normalizes a cursor naming a retention-deleted segment, and a
			// position advertised before that rewind names somewhere the first
			// poll will not read from.
			$idle_since = $this->opened_at_eof_since( $consumers );

			// Own cursors: never advertise the last stream's subscriptions.
			$pairs = [];
			foreach ( $consumers as $name => $c ) {
				$dir = self::dir_from_stamp( $name );
				// Either would desync the envelope's KEY VALUE pairing.
				if ( '' === $dir || \strpbrk( $dir, ' ,' ) ) {
					continue;
				}
				$pairs[] = $dir . '=' . $c->cursor_position();
			}
			// @longform The envelope carries the STARTING resume point, so a
			// stream that closes without delivering a message still leaves the
			// client somewhere to resume — an idle close makes zero-message
			// streams the normal case, and a reopen without one tail-seeks and
			// drops whatever arrived in the gap. From there the client advances
			// its own from each message's ID breadcrumb.
			$this->send_sse_event(
				'connected',
				$this->build_connected_msg(
					$active_lease,
					$subs,
					$interval,
					\implode( ',', $pairs )
				)
			);
			// Padding clears proxy buffers; a bare flush does not.
			$this->flush_if_needed();

			// Heartbeat every $interval ms so an idle-but-live stream ≠ dead.
			$heartbeat_interval = \max( 0.1, $interval / 1000.0 );
			$last_heartbeat     = Core::right_now();
			$this->last_data    = $idle_since ?? $last_heartbeat;
			$idle_timeout       = Core::num_int( Config::value( 'sse_idle_timeout' ), 0 );
			Event_Framework::instance()->drain(
				function () use ( &$last_heartbeat, &$consumers, &$glob_owned, &$diagnostic_written, $glob_subs, $default_route, $heartbeat_interval, $idle_timeout, $active_lease, $partition, $subs ): bool {
					$check = self::$check_slot;
					if ( null !== $check && ! $check( $active_lease, $partition ) ) {
						$this->send_sse_event( 'disconnect', $this->build_disconnect_msg() );
						$this->flush_if_needed();
						$this->write_diagnostic(
							$this->lease_loss_context( $active_lease, $partition, $subs )
						);
						$diagnostic_written = true;
						return false;
					}
					if ( \connection_aborted() ) {
						return false;
					}
					$now = Core::$now; // the enclosing drain refreshes this each tick
					// Idle a window: close clean, let `retry:` reopen it.
					if ( $idle_timeout > 0 && ( $now - $this->last_data ) >= $idle_timeout ) {
						$this->flush_if_needed();
						return false;
					}
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
		} catch ( Worker_Should_Stop $e ) {
			throw $e;
		} catch ( \Throwable $e ) {
			if ( ! $diagnostic_written ) {
				$diagnostic_written = true;
				$context = null === $active_lease
					? [
						'reason'        => 'unexpected_exception',
						'pid'           => \getmypid(),
						'partition'     => $partition,
						'subscriptions' => \array_values( $subs ),
					]
					: $this->stream_context( 'unexpected_exception', $active_lease, $partition, $subs );
				$context['exception_class']   = $e::class;
				$context['exception_message'] = $e->getMessage();
				$this->write_diagnostic( $context );
			}
			throw $e;
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
			if ( null !== $release && null !== $active_lease ) {
				$release( $active_lease, $partition );
			}
		}
	}

	/**
	 * The subscription dir a FROM breadcrumb names — the inverse of
	 * `stamp_for()`: a grouped stamp keeps its `{group}/` prefix, a bare-logs
	 * one is the first path segment alone.
	 */
	private static function dir_from_stamp( string $from ): string {
		$parts = \explode( '/', $from );
		if ( isset( $parts[1] ) && '' !== $parts[1] && \in_array( $parts[0], Log_Discovery::GROUPS, true ) ) {
			return "{$parts[0]}/{$parts[1]}";
		}
		return $parts[0];
	}

	/**
	 * Require the coordinated two-field lease shape; no slot-only fallback.
	 *
	 * @return array{slot:int,owner:int}
	 */
	private static function require_lease( mixed $lease ): array {
		if (
			! \is_array( $lease )
			|| 2 !== \count( $lease )
			|| ! \array_key_exists( 'slot', $lease )
			|| ! \is_int( $lease['slot'] )
			|| $lease['slot'] < -1
			|| ! \array_key_exists( 'owner', $lease )
			|| ! \is_int( $lease['owner'] )
			|| $lease['owner'] <= 0
		) {
			throw new \UnexpectedValueException( 'SSE slot acquisition did not return a complete lease.' );
		}
		return $lease;
	}

	/**
	 * Emit a single SSE event. SAFE_EVENTS pass through; anything else is
	 * sanitized via `sanitize_event_name()`. JSON-encodes the payload.
	 *
	 * @param string           $event   Event name.
	 * @param array<int,mixed> $message 7-field positional Message.
	 */
	protected function send_sse_event( string $event, array $message ): void {
		$event = $this->sanitize_event_name( $event );
		if ( '' === $event ) {
			throw new \InvalidArgumentException( 'SSE event name is empty after sanitization; refusing to emit a nameless event.' );
		}
		$json = Message::packed( $message );
		$this->write_wire( "event: {$event}\ndata: {$json}\n\n" );
	}

	/** Put one framed chunk on the wire. Never escaped — SSE framing is bytes. */
	private function write_wire( string $payload ): void {
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo $payload;
		\flush();
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
	 * tails that; otherwise it globs `{base}/{group}/{rest}` (exact name → itself,
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

		[ $group, $rest ] = self::parse_group( $sub );

		// Traversal guard: must start with a name char (blocks `.*` / `..`).
		if ( ! \preg_match( '/^[a-z0-9_-][a-z0-9_.*-]*$/D', $rest ) || \str_contains( $rest, '..' ) ) {
			throw new \InvalidArgumentException(
				\esc_html( "invalid subscription: {$sub}" )
			);
		}

		// IPC (bare exact subs only): grouped subs never address ipc/.
		if ( $sub === $rest && ! \str_contains( $sub, '*' ) ) {
			$ipc_output = "{$base}/ipc/{$sub}/output";
			if ( \is_dir( $ipc_output ) ) {
				$this->is_interactive = true;
				$consumer             = new Consumer_Node();
				$consumer->arguments( [ $ipc_output ] );
				$consumer->next_offset( 'end' );
				$consumer->set_stamp_as( $sub );
				return [ $consumer ];
			}
		}

		// Partition feed: one Consumer per matched dir (exact name → itself).
		$consumers = [];
		foreach ( self::matched_dirs( $base, $sub )[1] as $dir ) {
			$name        = self::stamp_for( $group, \basename( $dir ) );
			$consumers[] = $this->log_consumer_for( $dir, $name, $positions );
		}
		return $consumers;
	}

	/**
	 * A subscription's root group + its concrete matched partition dirs
	 * (`logs` bare; `offsets/…` / `deadletter/…` prefixed); an exact name
	 * matches itself. Layout-agnostic — the partition token sits wherever the
	 * producer put it in the dir name. Glob I/O errors yield an empty list.
	 *
	 * @return array{0: string, 1: array<int,string>} Group + absolute dir paths.
	 */
	private static function matched_dirs( string $base, string $sub ): array {
		[ $group, $rest ] = self::parse_group( $sub );
		$matches          = \glob( "{$base}/{$group}/{$rest}", \GLOB_ONLYDIR );
		return [ $group, false === $matches ? [] : $matches ];
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
			[ $group, $rest ] = self::parse_group( $sub );
			$matches          = \glob( "{$base}/{$group}/{$rest}", \GLOB_ONLYDIR );
			if ( false === $matches ) {
				$glob_ok = false; // I/O error — not a trustworthy "nothing wanted".
				continue;
			}
			foreach ( $matches as $dir ) {
				$wanted[ self::stamp_for( $group, \basename( $dir ) ) ] = $dir;
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
	 * Split an optional `{group}/` prefix off a subscription: bare = the logs
	 * root (stamped bare, back-compat); `offsets/…` and `deadletter/…` address
	 * their sibling roots (stamped WITH the prefix). Any other prefix throws.
	 *
	 * @return array{0: string, 1: string} The root group + the remainder.
	 *
	 * @throws \InvalidArgumentException On a prefix outside the browsable roots.
	 */
	private static function parse_group( string $sub ): array {
		$slash = \strpos( $sub, '/' );
		if ( false === $slash ) {
			return [ 'logs', $sub ];
		}
		$group = \substr( $sub, 0, $slash );
		// `logs/x` rejected, not aliased to bare `x`: one spelling per source.
		if ( 'logs' === $group || ! \in_array( $group, Log_Discovery::GROUPS, true ) ) {
			throw new \InvalidArgumentException(
				\esc_html( "invalid subscription: {$sub}" )
			);
		}
		return [ $group, \substr( $sub, $slash + 1 ) ];
	}

	/** The stamp for a matched dir: bare-logs stays bare; grouped keeps its prefix. */
	private static function stamp_for( string $group, string $basename ): string {
		return 'logs' === $group ? $basename : "{$group}/{$basename}";
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
	 * Seed for the idle clock: when the newest subscribed source last grew,
	 * or null when any consumer still has bytes to deliver.
	 *
	 * A stream opening at EOF on a source that went quiet ten minutes ago has
	 * already been idle for ten minutes, so `last_data` must say so and let the
	 * window close it on the first tick. Seeding the present instead pins a
	 * child for the whole window per reconnect, which is the residency this is
	 * meant to give back.
	 *
	 * A worker IPC attach never reports idle. That consumer tail-seeks, so it is
	 * caught up the instant it opens, and a console attaching to a quiet worker
	 * would be hung up on before rendering a line — then wait out the full
	 * `retry:` gap for a stream it just asked for. The window reclaims tails
	 * nobody is reading; an attached console is someone reading.
	 *
	 * @param array<string,Consumer_Node> $consumers Attached consumers.
	 *
	 * @return float|null Epoch seconds, or null to fall back to the present.
	 */
	private function opened_at_eof_since( array $consumers ): ?float {
		if ( $this->is_interactive ) {
			return null;
		}
		$newest = null;
		foreach ( $consumers as $c ) {
			$since = $c->idle_since();
			if ( null === $since ) {
				return null;
			}
			$newest = null === $newest ? $since : \max( $newest, $since );
		}
		return $newest;
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
	 * @param array{slot:int,owner:int} $lease
	 * @param array<int,string>         $subs
	 * @return array<int,mixed> The 7-field positional Message.
	 */
	private function build_connected_msg( array $lease, array $subs, int $interval, string $cursors = '' ): array {
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_INFO;
		// connected fires before the drain seeds Core::$now; take a fresh read.
		$message[ Message::TIMESTAMP ] = 0.0 !== Core::$now ? Core::$now : Core::right_now();
		$message[ Message::FROM ]      = '_stream';
		$message[ Message::KEY ]       = 'connected';
		// TM_INFO values are STRINGS: flat KEY VALUE, space-free tokens.
		$message[ Message::VALUE ]     = \implode( ' ', [
			'PID',           (string) \getmypid(),
			'SLOT',          (string) $lease['slot'],
			'OWNER',         (string) $lease['owner'],
			'SUBSCRIPTIONS', \implode( ',', $subs ),
			'INTERVAL',      (string) $interval,
		] );
		// Where each subscription STARTS; the client advances its own after.
		if ( '' !== $cursors ) {
			$message[ Message::VALUE ] .= ' CURSORS ' . $cursors;
		}
		return $message;
	}

	/**
	 * Build a `heartbeat` Message envelope
	 *
	 * @param float $now Current timestamp.
	 * @return array<int,mixed> The 7-field positional Message.
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
	 * The reopen schedule, as an EVENT rather than the protocol `retry:` field:
	 * the client owns reconnect, so it needs the interval as data it can read.
	 *
	 * @return array<int,mixed> `retry` Message envelope.
	 */
	private function build_retry_msg(): array {
		$message                       = Message::new_message();
		$message[ Message::TYPE ]      = Message::TM_INFO;
		$message[ Message::FROM ]      = '_stream';
		$message[ Message::KEY ]       = 'retry';
		$message[ Message::VALUE ]     = (string) Core::num_int( Config::value( 'sse_retry_ms' ), 0 );
		return $message;
	}

	/** @return array<int,mixed> Terminal application-directed disconnect Message. */
	private function build_disconnect_msg(): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = '_stream';
		$message[ Message::KEY ]   = 'slot_lease_lost';
		$message[ Message::VALUE ] = 'SSE slot lease lost';
		return $message;
	}

	/**
	 * Add one failure-only, whitelisted lease inspection to the close context.
	 *
	 * @param array{slot:int,owner:int} $lease
	 * @param array<int,string>         $subs
	 * @return array<string,mixed>
	 */
	private function lease_loss_context( array $lease, int $partition, array $subs ): array {
		$inspect    = self::$inspect_slot;
		$inspection = null === $inspect
			? [ 'backend' => 'unavailable', 'lease_state' => 'backend_read_error' ]
			: $inspect( $lease, $partition );
		if (
			! isset( $inspection['backend'], $inspection['lease_state'] )
			|| ! \is_string( $inspection['backend'] )
			|| ! \is_string( $inspection['lease_state'] )
		) {
			throw new \UnexpectedValueException( 'SSE lease inspection did not return backend and lease_state strings.' );
		}

		$context                = $this->stream_context( 'slot_lease_lost', $lease, $partition, $subs );
		$context['backend']     = $inspection['backend'];
		$context['lease_state'] = $inspection['lease_state'];
		$string_fields          = [ 'memcached_result_message' ];
		$integer_fields         = [
			'memcached_result_code',
			'apcu_expunges',
			'apcu_available_memory_bytes',
		];
		foreach ( $string_fields as $field ) {
			if ( isset( $inspection[ $field ] ) && \is_string( $inspection[ $field ] ) ) {
				$context[ $field ] = $inspection[ $field ];
			}
		}
		foreach ( $integer_fields as $field ) {
			if ( isset( $inspection[ $field ] ) && \is_int( $inspection[ $field ] ) ) {
				$context[ $field ] = $inspection[ $field ];
			}
		}
		return $context;
	}

	/**
	 * Base redacted context shared by deliberate closes and exceptions.
	 *
	 * @param array{slot:int,owner:int} $lease
	 * @param array<int,string>         $subs
	 * @return array<string,mixed>
	 */
	private function stream_context( string $reason, array $lease, int $partition, array $subs ): array {
		return [
			'reason'        => $reason,
			'pid'           => \getmypid(),
			'slot'          => $lease['slot'],
			'partition'     => $partition,
			'subscriptions' => \array_values( $subs ),
		];
	}

	/**
	 * Write exactly one structured line, or hand the redacted context to tests.
	 *
	 * @param array<string,mixed> $context Redacted diagnostic fields.
	 */
	private function write_diagnostic( array $context ): void {
		$diagnostic_log = self::$diagnostic_log;
		if ( null !== $diagnostic_log ) {
			$diagnostic_log( $context );
			return;
		}
		$json = \wp_json_encode( $context, \JSON_UNESCAPED_SLASHES | \JSON_INVALID_UTF8_SUBSTITUTE );
		if ( false === $json ) {
			throw new \RuntimeException( 'Could not encode SSE stream diagnostic context.' );
		}
		$this->stderr( 'SSE stream closed ' . $json );
	}

	/**
	 * Disable every buffering layer between PHP and the browser so SSE events
	 * stream incrementally (output buffers, zlib, mod_deflate, nginx).
	 */
	protected function init_sse_headers(): void {
		// phpcs:disable WordPress.PHP.IniSet.Risky
		\ini_set( 'zlib.output_compression', false );
		\ini_set( 'implicit_flush', true );
		// phpcs:enable

		while ( \ob_get_level() > 0 ) {
			\ob_end_clean();
		}

		if ( \function_exists( 'apache_setenv' ) ) {
			// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.runtime_configuration_apache_setenv
			\apache_setenv( 'no-gzip', '1' );
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
		\flush();
		$this->needs_flush = false;
	}

	/** @api Support for unit tests. */
	public function set_base_dir( string $dir ): void {
		$this->base_dir = $dir;
	}

	/**
	 * Capability-only gate; NO nonce — a nonce breaks the cross-server pull.
	 * Fronts the fleet, so the multisite guard applies.
	 *
	 * @return bool|\WP_Error
	 */
	public function check_permission() {
		$gate = Bootstrap::fleet_gate();
		if ( null !== $gate ) {
			return $gate;
		}
		return Capabilities::can( Capabilities::READ );
	}

	public function register_routes(): void {
		\register_rest_route(
			static::REST_NAMESPACE,
			static::ROUTE,
			[
				'methods'             => 'GET',
				'callback'            => [ $this, 'stream' ],
				// Capability-only gate; NO nonce (breaks cross-server pull).
				'permission_callback' => [ $this, 'check_permission' ],
				'args'                => [
					'subscribe' => [ 'required' => true, 'type' => 'string' ],
					'positions' => [ 'required' => false, 'type' => 'string' ],
				],
			]
		);
	}
}
