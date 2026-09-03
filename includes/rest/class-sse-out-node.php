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

/**
 * One request, one stream, one graph. The controller names itself `_sse`, so
 * whatever the graph routes there arrives in `fill()` and goes out on the open
 * response. The Router, command interpreter, HTTP filter and per-subscription
 * Consumers around it are built inside the drain's `try` and removed in its
 * `finally`, which is what leaves the process registry empty for the next
 * stream even when the drain throws.
 *
 * `Log_Stream_Out_Node` extends it with `ROUTE` and `open_subscription()` as
 * its only overrides, so the two endpoints stay identical on the wire.
 */
class SSE_Out_Node extends Node {

	/**
	 * Total byte size of the padding comment `flush_if_needed()` writes. 4096
	 * clears the response buffers nginx and CloudFront hold a small event in;
	 * short of that, a dashboard shows nothing until enough real events
	 * accumulate to fill one.
	 */
	public const FLUSH_SIZE = 4096;

	/**
	 * Heartbeat cadence in milliseconds. Pending events are flushed on every
	 * drain tick, so this paces the idle keepalive alone.
	 */
	public const HEARTBEAT_MS = 2000;

	/**
	 * The REST namespace every substrate route registers under.
	 *
	 * @var non-falsy-string
	 */
	public const REST_NAMESPACE = 'newspack-nodes/v1';

	/**
	 * The path this controller answers on. `register_routes()` reads it
	 * late-static, so a subclass changes its endpoint by redeclaring this one
	 * constant and inherits every wire behaviour unchanged.
	 *
	 * @var non-falsy-string
	 */
	public const ROUTE = '/messages/stream';

	/**
	 * The lease an unmetered stream carries: what `stream()` uses when no slot
	 * pool is wired, and what `run_stream_loop()` defaults to. Slot -1 sits
	 * outside every pool's range, and the owner is an arbitrary positive
	 * integer because `require_lease()` refuses a non-positive one.
	 */
	private const UNMETERED_LEASE = [
		'slot'  => -1,
		'owner' => 93939397,
	];

	/**
	 * Event names `sanitize_event_name()` passes through untouched. Keyed
	 * rather than listed so the check on the emit path is one `isset()`.
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
	 * The four slot-pool seams that gate concurrent streams, installed by
	 * `SSE_Slot_Pool::wire()` from `Bootstrap::register_rest_routes()`. REST
	 * registration is the only wiring site, because reading these properties
	 * any earlier force-loads this controller on admin and cron requests that
	 * never stream. Left null, `acquire` hands back the unmetered sentinel
	 * lease and the other three do nothing.
	 *
	 * Acquire runs once per stream: `function ( int $partition ): array|false`,
	 * taking the partition the subscriptions name, or -1 when none names one.
	 * It is called before any header is sent, so `false` can still answer 429.
	 * The shipped pool ignores the partition and pools slots host-wide.
	 *
	 * @var \Closure(int): (array{slot:int,owner:int}|false)|null
	 */
	public static ?\Closure $acquire_slot = null;

	/**
	 * Consulted on every drain tick to confirm the stream still holds the exact
	 * lease it acquired; false takes the `disconnect` close. It only reads —
	 * refreshing the TTL belongs to the client heartbeat, and refreshing it
	 * here would let a stream nobody is reading hold its slot indefinitely.
	 *
	 * @var \Closure(array{slot:int,owner:int}, int): bool|null
	 */
	public static ?\Closure $check_slot   = null;

	/**
	 * Called from the drain's `finally`, so neither a clean close nor a throw
	 * leaves the slot held until its TTL expires.
	 *
	 * @var \Closure(array{slot:int,owner:int}, int): void|null
	 */
	public static ?\Closure $release_slot = null;

	/**
	 * Read only once a check has already failed, to name the cache backend and
	 * the lease state in the diagnostic line. The healthy path never pays it.
	 *
	 * @var \Closure(array{slot:int,owner:int}, int): array<string,int|string>|null
	 */
	public static ?\Closure $inspect_slot = null;

	/**
	 * Log seam narrow enough for a test to assert the exact redacted context.
	 * Production leaves it null and writes one JSON line through the node
	 * stderr chain.
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

	/**
	 * Whether the subscribed logs are appended by more than one process, which
	 * the CLIENT asserts (`multi_writer=1`): a shared log's write-side is on
	 * this server, but nothing on disk records that it is shared, and this
	 * endpoint opens Consumers for matched dirs with no topology in the picture.
	 * A wrong assertion costs the reader a grace window, never correctness.
	 */
	private bool $multi_writer = false;

	/**
	 * Node egress, and terminal: write the Message to the response as an SSE
	 * `msg` event instead of forwarding it. Each one counts as data, which is
	 * what defers the idle close.
	 *
	 * @param array<int,mixed> $message The 7-field positional message array.
	 */
	public function fill( array $message ): void {
		++$this->counter;
		$this->last_data = Core::$now ?: Core::right_now();
		$this->send_sse_event( 'msg', $message );
	}

	/**
	 * The REST handler: read the query parameters, take a slot, then run the
	 * stream to its end and exit.
	 *
	 * Acquisition happens BEFORE `init_sse_headers()` so a refused stream can
	 * still answer with a JSON `WP_Error`. Once the event-stream headers are
	 * out, 429 is no longer sayable.
	 *
	 * @param \WP_REST_Request $request Request carrying `subscribe`, `positions` and `multi_writer`.
	 * @return \WP_Error|void WP_Error when no slot is free (429); otherwise streams and exits.
	 */
	public function stream( \WP_REST_Request $request ) {
		$subscribe     = $request->get_param( 'subscribe' );
		$positions_raw = $request->get_param( 'positions' ) ?? '';
		$subs          = $this->parse_subscriptions( Core::as_string( $subscribe ) );
		// `positions` is the ONLY resume input; the client assembles it.
		$positions     = $this->parse_positions( Core::as_string( $positions_raw ) );
		$interval      = self::HEARTBEAT_MS;
		$this->set_multi_writer(
			\rest_sanitize_boolean( Core::as_string( $request->get_param( 'multi_writer' ) ) )
		);

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
	 * names. Blank entries are dropped, so a stray comma cannot conjure a
	 * subscription that then fails the traversal guard.
	 *
	 * @param string $raw The raw query-parameter value.
	 * @return array<int,string> Subscription names, in the order given.
	 */
	public function parse_subscriptions( string $raw ): array {
		if ( '' === $raw ) {
			return [];
		}
		$parts = \array_map( 'trim', \explode( ',', $raw ) );
		return \array_values( \array_filter( $parts, static fn ( $s ) => '' !== $s ) );
	}

	/**
	 * Decode the `positions` query parameter, a JSON object keyed by the stamp
	 * each subscription resolves to. Returns null when the parameter is absent,
	 * empty or not a JSON array, and every subscription then tail-seeks.
	 *
	 * @param string $raw The raw query-parameter value.
	 * @return array<array-key,mixed>|null Saved positions, or null to tail-seek.
	 */
	public function parse_positions( string $raw ): ?array {
		if ( '' === $raw ) {
			return null;
		}
		$decoded = \json_decode( $raw, true );
		return \is_array( $decoded ) ? $decoded : null;
	}

	/**
	 * Pick the partition to hand the slot pool: the number the first IPC-shaped
	 * (`{type}.p{N}`) subscription carries, or -1 when none carries one.
	 *
	 * @param array<int,string> $subs Subscription names.
	 * @return int A partition number, or -1 for a stream that names no partition.
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
	 * Run one stream without the HTTP wrapper: no headers, no `exit`. The
	 * events still go to the output buffer, which is what a test captures.
	 *
	 * It emits the `retry` schedule, builds the SSE-process graph, opens a
	 * Consumer per subscription, emits the `connected` envelope, and drains
	 * until the predicate returns false — consulting `$check_slot` on every
	 * iteration, and calling `$release_slot` from the same `finally` that
	 * removes every node it built.
	 *
	 * A hard PHP, server or process termination bypasses the terminal event,
	 * the diagnostic line and that `finally` alike, so a client still needs an
	 * unexplained-EOF path of its own.
	 *
	 * @param array<int,string>           $subs      Subscription names.
	 * @param array<array-key,mixed>|null $positions Saved positions, keyed by stamp.
	 * @param int                         $interval  Heartbeat cadence in milliseconds.
	 * @param array{slot:int,owner:int}   $lease     The lease this stream holds.
	 * @param int                         $partition The partition the lease was taken for.
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
	 * Put every operation after acquisition inside one diagnostic-and-cleanup
	 * lifetime. The lease is validated in here rather than at the acquire call
	 * so a malformed one is reported through the same diagnostic path as any
	 * other failure, under the lease-less context branch.
	 *
	 * @param array<int,string>           $subs              Subscription names.
	 * @param array<array-key,mixed>|null $positions         Saved positions, keyed by stamp.
	 * @param int                         $interval          Heartbeat cadence in milliseconds.
	 * @param mixed                       $lease             Raw acquire result.
	 * @param int                         $partition         The partition the lease was taken for.
	 * @param bool                        $initialize_stream Whether to send the response headers, which only the REST handler does.
	 *
	 * @throws \Throwable Whatever the stream raised, once the diagnostic line is written.
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

			// The SSE interpreter sinks into _router; verifier gates it.
			Command_Interpreter_Node::$default_authorize = Command_Auth::verifier();
			$interpreter = new Command_Interpreter_Node();
			$interpreter->name( Node_Names::COMMAND_INTERPRETER );
			$interpreter->sink( Core::node( Node_Names::ROUTER ) );

			// This controller IS the SSE egress Node; reached by TO=_sse.
			$this->name( Node_Names::SSE );
			$this->sink( $interpreter );

			$http_filter = new HTTP_Filter_Node( (int) \getmypid() );
			// SSE egress plumbing — patron-linked so dump_metadata hides it.
			$http_filter->patron( $this );
			$http_filter->name( Node_Names::OUTPUT );
			$http_filter->sink( $this );

			// Consumers sink to a plain Node; keep the _router round-trip.
			$default_route = new Node();
			$default_route->patron( $this );
			$default_route->name( '_default_route' );
			$default_route->sink( $interpreter );
			$default_route->target( Node_Names::SSE );

			$glob_subs  = [];
			$glob_owned = [];
			// Own it: never inherit the last stream's attach classification.
			$this->is_interactive = false;
			foreach ( $subs as $sub ) {
				$is_glob = \str_contains( $sub, '*' );
				if ( $is_glob ) {
					$glob_subs[] = $sub;
				}
				// Positions are a FLAT { stamp: pos } map; pass it whole.
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

			// Heartbeat every $interval ms so an idle stream reads as live.
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
					// Idle a window: close clean, the `retry` event reopens it.
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
	 * The subscription dir a FROM breadcrumb names, and the inverse of
	 * `stamp_for()`: a grouped stamp keeps its `{group}/` prefix, a bare-logs
	 * one is the first path segment alone. Reading the leading segments rather
	 * than the whole string is what lets a full routing path resolve too.
	 *
	 * @param string $from A stamp, or a FROM path beginning with one.
	 * @return string The dir name that stamp addresses.
	 */
	private static function dir_from_stamp( string $from ): string {
		$parts = \explode( '/', $from );
		if ( isset( $parts[1] ) && '' !== $parts[1] && \in_array( $parts[0], Log_Discovery::GROUPS, true ) ) {
			return "{$parts[0]}/{$parts[1]}";
		}
		return $parts[0];
	}

	/**
	 * Require the whole two-field lease shape, with no slot-only fallback: a
	 * slot number alone cannot be checked or released against its owner, so
	 * accepting one would hand out a lease nothing can reclaim.
	 *
	 * @param mixed $lease Raw acquire result.
	 * @return array{slot:int,owner:int} The validated lease.
	 *
	 * @throws \UnexpectedValueException When the seam returned any other shape.
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
	 * Emit one SSE event: the sanitized name, then the packed Message as the
	 * `data` field.
	 *
	 * @param string           $event   Event name; a SAFE_EVENTS entry passes through.
	 * @param array<int,mixed> $message The 7-field positional message array.
	 *
	 * @throws \InvalidArgumentException When sanitization leaves the name empty.
	 */
	protected function send_sse_event( string $event, array $message ): void {
		$event = $this->sanitize_event_name( $event );
		if ( '' === $event ) {
			throw new \InvalidArgumentException( 'SSE event name is empty after sanitization; refusing to emit a nameless event.' );
		}
		$json = Message::packed( $message );
		$this->write_wire( "event: {$event}\ndata: {$json}\n\n" );
	}

	/**
	 * Put one framed chunk on the wire and arm the padding flush. The payload
	 * is never escaped: SSE framing is bytes, and escaping would corrupt it.
	 *
	 * @param string $payload One complete SSE frame, terminator included.
	 */
	private function write_wire( string $payload ): void {
		// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo $payload;
		\flush();
		$this->needs_flush = true;
	}

	/**
	 * Strip everything outside `[a-zA-Z0-9_-]` from an event name that is not
	 * on the allow-list. A name carrying a newline would otherwise end the
	 * `event:` line and forge whatever SSE fields followed it.
	 *
	 * @param string $event Caller-supplied event name.
	 * @return string The sanitized name, which may be empty.
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
	 * `$sub` names a concrete resource dir or globs over several; the partition
	 * token is part of that name and is never parsed out. A bare exact name
	 * whose worker holds a live IPC channel (`{base}/ipc/{sub}/output`) tails
	 * that channel. Everything else globs `{base}/{group}/{rest}` and yields
	 * one Consumer per matched dir — itself for an exact name, every partition
	 * dir for `firehose.*` — each stamped and resume-keyed by the stamp
	 * `stamp_for()` builds from its dir basename.
	 *
	 * The remainder after the group prefix must lead with a name character and
	 * contain neither `/` nor `..`, which leaves `*` as the only wildcard and
	 * confines the glob to one level under a browsable root; anything else
	 * throws. A matching `$positions` entry seeds that reader's cursor and an
	 * absent one tail-seeks. A valid pattern matching nothing opens nothing.
	 *
	 * @param string                      $sub       Subscription name or glob.
	 * @param array<array-key,mixed>|null $positions Saved positions, keyed by stamp.
	 *
	 * @return array<int,Consumer_Node> One reader per matched dir, unattached.
	 *
	 * @throws \InvalidArgumentException When `$sub` names a root outside the
	 *                                  browsable groups, or fails the guard.
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

		// Partition feed: one Consumer per matched dir.
		$consumers = [];
		foreach ( self::matched_dirs( $base, $sub )[1] as $dir ) {
			$name        = self::stamp_for( $group, \basename( $dir ) );
			$consumers[] = $this->log_consumer_for( $dir, $name, $positions );
		}
		return $consumers;
	}

	/**
	 * A subscription's root group and the concrete dirs it matches, an exact
	 * name matching itself. Layout-agnostic: the partition token sits wherever
	 * the producer put it in the dir name, so nothing here parses one out. A
	 * glob I/O error yields an empty list.
	 *
	 * @param string $base The runtime base dir the roots sit under.
	 * @param string $sub  Subscription name or glob.
	 * @return array{0:string,1:array<int,string>} The group, then absolute dir paths.
	 */
	private static function matched_dirs( string $base, string $sub ): array {
		[ $group, $rest ] = self::parse_group( $sub );
		$matches          = \glob( "{$base}/{$group}/{$rest}", \GLOB_ONLYDIR );
		return [ $group, false === $matches ? [] : $matches ];
	}

	/**
	 * Self-heal glob subscriptions against the live filesystem: open a Consumer
	 * for each newly-appeared matching dir, tail-seeking it because it appeared
	 * after the connect, and remove the one whose dir has vanished. Partition
	 * counts move in both directions, so both halves are needed.
	 *
	 * Only a stamp a glob opened is removable, so an exact IPC or log
	 * subscription is never touched. A `glob()` I/O error skips the removal
	 * pass and keeps what is already open: a transient read failure under
	 * `logs/` must not tear down and re-tail every partition, so a removal
	 * waits for a scan that came back clean.
	 *
	 * @api Called on the drain heartbeat; also unit-tested directly.
	 *
	 * @param array<int,string>           $glob_subs  Subscriptions containing `*`.
	 * @param array<string,Consumer_Node> $consumers  Live map keyed by stamp, mutated in place.
	 * @param array<string,bool>          $glob_owned Stamps opened by a glob (removable), mutated in place.
	 * @param Node                        $route      The `_default_route` each new Consumer sinks into.
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
	 * Split an optional `{group}/` prefix off a subscription. A bare name
	 * addresses the logs root and stamps bare; `offsets/…` and `deadletter/…`
	 * address their sibling roots and stamp WITH the prefix. `logs/x` is
	 * refused rather than aliased to bare `x`, so one source has one spelling.
	 *
	 * @param string $sub Subscription name or glob.
	 * @return array{0:string,1:string} The root group, then the remainder.
	 *
	 * @throws \InvalidArgumentException On a prefix outside the browsable roots.
	 */
	private static function parse_group( string $sub ): array {
		$slash = \strpos( $sub, '/' );
		if ( false === $slash ) {
			return [ 'logs', $sub ];
		}
		$group = \substr( $sub, 0, $slash );
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
	 * Build a Consumer tailing one concrete log-partition dir, stamped and
	 * resume-keyed by `$name` — the same stamp the browser reads back out of
	 * each message's FROM.
	 *
	 * @param string                      $dir       Absolute path of the partition dir.
	 * @param string                      $name      The stamp this reader carries.
	 * @param array<array-key,mixed>|null $positions Saved positions, keyed by stamp.
	 *
	 * @return Consumer_Node A reader seeded from its saved position, else tail-seeking.
	 */
	private function log_consumer_for( string $dir, string $name, ?array $positions ): Consumer_Node {
		$consumer = new Consumer_Node();
		$consumer->arguments( [ $dir ] );
		$consumer->set_multi_writer( $this->multi_writer );
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
	 * would be hung up on before rendering a line — then wait out the whole
	 * advertised `retry` gap for a stream it just asked for. The window
	 * reclaims tails nobody is reading; an attached console is someone reading.
	 *
	 * @param array<string,Consumer_Node> $consumers Attached consumers, keyed by stamp.
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
	 * Name a Consumer after the stamp it carries, wire it into the SSE graph,
	 * and record it in the live map. A stamp already open is skipped, so two
	 * subscriptions matching the same dir yield one reader, and an unstamped
	 * Consumer is refused rather than registered under an empty name.
	 *
	 * @param Consumer_Node               $c         The reader to attach.
	 * @param array<string,Consumer_Node> $consumers Live map keyed by stamp, mutated in place.
	 * @param Node                        $route     The `_default_route` it sinks into.
	 */
	private function attach_consumer( Consumer_Node $c, array &$consumers, Node $route ): void {
		$name = $c->stamped_as();
		if ( '' === $name || isset( $consumers[ $name ] ) ) {
			return;
		}
		$c->patron( $this );
		$c->name( $name );
		$c->sink( $route );
		$consumers[ $name ] = $c;
	}

	/**
	 * Narrow a saved-position value to a shape `Consumer_Node::next_offset()` accepts:
	 * an exact `{segment, offset}` pair, a numeric SEEK sentinel (`SEEK_START` 0 /
	 * `SEEK_END` -1 / `SEEK_RECENT` -2), or one of the alias words. Anything else
	 * falls back to 'start' (next_offset's default case).
	 *
	 * @param mixed $position Raw per-subscription saved position.
	 * @return array<array-key,mixed>|string|int A value `next_offset()` accepts.
	 */
	protected static function position_arg( $position ) {
		if ( \is_array( $position ) ) {
			return $position;
		}
		// A seek travels as a NUMBER; don't stringify it to reparse it.
		if ( \is_numeric( $position ) ) {
			return Core::num_int( $position, Consumer_Node::SEEK_START );
		}
		return Core::as_string( $position, 'start' );
	}

	/**
	 * Build the `connected` envelope, the first application frame after the
	 * `retry` schedule: the session pid a browser stamps into the FROM of its
	 * attached commands, the lease it holds, the subscriptions echoed back, the
	 * heartbeat cadence, and each subscription's starting cursor.
	 *
	 * @param array{slot:int,owner:int} $lease    The lease this stream holds.
	 * @param array<int,string>         $subs     Subscription names, as asked for.
	 * @param int                       $interval Heartbeat cadence in milliseconds.
	 * @param string                    $cursors  CSV `stamp=segment:offset` pairs, omitted when empty.
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
	 * Build the `heartbeat` envelope that proves an idle stream is still live.
	 * It carries the tick's timestamp and nothing else, and it does not count
	 * as data, so it never defers the idle close.
	 *
	 * @param float $now The current timestamp, as the drain read it.
	 * @return array<int,mixed> The 7-field positional Message.
	 */
	private function build_heartbeat_msg( float $now ): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = '_stream';
		$message[ Message::KEY ]   = 'heartbeat';
		$message[ Message::VALUE ] = (string) $now;
		return $message;
	}

	/**
	 * The reopen schedule, as an EVENT rather than the protocol `retry:` field:
	 * the client owns reconnect, so it needs the interval as data it can read.
	 *
	 * @return array<int,mixed> `retry` Message envelope.
	 */
	private function build_retry_msg(): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = '_stream';
		$message[ Message::KEY ]   = 'retry';
		$message[ Message::VALUE ] = (string) Core::num_int( Config::value( 'sse_retry_ms' ), 0 );
		return $message;
	}

	/**
	 * The terminal frame for a stream whose lease was taken from under it: a
	 * machine KEY the client branches on, and a VALUE it can display. A clean
	 * idle close sends no frame at all, so this one always means failure.
	 *
	 * @return array<int,mixed> The 7-field positional Message.
	 */
	private function build_disconnect_msg(): array {
		$message                   = Message::new_message();
		$message[ Message::TYPE ]  = Message::TM_INFO;
		$message[ Message::FROM ]  = '_stream';
		$message[ Message::KEY ]   = 'slot_lease_lost';
		$message[ Message::VALUE ] = 'SSE slot lease lost';
		return $message;
	}

	/**
	 * Add one lease inspection to the close context, taken only once the lease
	 * is already lost. The backend and lease state are required; the memcached
	 * and APCu fields are copied one allow-listed key at a time, and only when
	 * they arrive with the declared type, so a backend cannot widen the line.
	 *
	 * @param array{slot:int,owner:int} $lease     The lease that went missing.
	 * @param int                       $partition The partition it was taken for.
	 * @param array<int,string>         $subs      Subscription names.
	 * @return array<string,mixed> The redacted diagnostic fields.
	 *
	 * @throws \UnexpectedValueException When the inspection omits either required string.
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
	 * The redacted context both a deliberate close and an exception report.
	 * The owner stays out of it — that is the token `workers heartbeat` proves
	 * the lease with — and the slot and pid already identify the stream.
	 *
	 * @param string                    $reason    Machine-readable close reason.
	 * @param array{slot:int,owner:int} $lease     The lease this stream held.
	 * @param int                       $partition The partition it was taken for.
	 * @param array<int,string>         $subs      Subscription names.
	 * @return array<string,mixed> The redacted diagnostic fields.
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
	 * Report a failed stream as one structured line, or hand the context to the
	 * log seam. Only a lost lease and an unexpected throw report at all; the
	 * caller's own flag keeps a lease loss that then throws to a single line,
	 * and a clean idle close writes nothing.
	 *
	 * @param array<string,mixed> $context Redacted diagnostic fields.
	 *
	 * @throws \RuntimeException When the context will not JSON-encode.
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
	 * If anything has been written since the last flush, pad the response past
	 * the proxy and TLS buffers holding it. Idempotent: with nothing pending it
	 * writes nothing, so calling it on every drain tick costs one boolean.
	 *
	 * The padding is one SSE comment — a colon, `FLUSH_SIZE - 3` dots, then the
	 * blank line — so every SSE parser discards it and no handler ever sees it.
	 * Only the byte count matters, and it must come to exactly FLUSH_SIZE.
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

	/**
	 * Apply the multi-writer seal-grace to every log Consumer this stream opens
	 * (see `Consumer_Node::SEAL_GRACE_SECONDS`). `stream()` sets it from the
	 * request; an IPC attach has one writer and never takes the grace.
	 *
	 * @param bool $flag Whether more than one process appends to these logs.
	 */
	public function set_multi_writer( bool $flag ): void {
		$this->multi_writer = $flag;
	}

	/**
	 * Point the subscription resolver at another runtime base dir.
	 *
	 * @api Support for unit tests.
	 *
	 * @param string $dir Absolute path holding `logs/`, `ipc/` and their siblings.
	 */
	public function set_base_dir( string $dir ): void {
		$this->base_dir = $dir;
	}

	/**
	 * Capability-only gate; NO nonce — a nonce breaks the cross-server pull.
	 * Fronts the fleet, so the multisite guard applies.
	 *
	 * @return bool|\WP_Error True when the caller may read, false when it may
	 *                        not, and a 403 WP_Error on a multisite subsite.
	 */
	public function check_permission() {
		$gate = Bootstrap::fleet_gate();
		if ( null !== $gate ) {
			return $gate;
		}
		return Capabilities::can( Capabilities::READ );
	}

	/**
	 * Register the stream route. Both constants are read late-static, so a
	 * subclass publishes its own path by declaring `ROUTE` and nothing else.
	 */
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
					'subscribe'    => [ 'required' => true, 'type' => 'string' ],
					'positions'    => [ 'required' => false, 'type' => 'string' ],
					'multi_writer' => [ 'required' => false, 'type' => 'boolean' ],
				],
			]
		);
	}
}
