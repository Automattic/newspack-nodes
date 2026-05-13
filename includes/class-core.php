<?php
/**
 * Core: global registries + clock + closing queue + stderr.
 *
 * Per-process singleton state for the node-graph runtime.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Core {
	/** @var array<string,object> */
	public static array $nodes_by_name = [];
	/** @var array<int,object> */
	public static array $nodes_by_fd = [];
	/** @var array<int,object> */
	public static array $nodes_by_id = [];

	/** @var float Microsecond-resolution timestamp; updated by the event loop or set explicitly in tests. */
	public static float $now = 0.0;

	/**
	 * Process start time. Stamped at every Core::reset() (worker bootstrap,
	 * test setUp); the `uptime` verb subtracts this from $now to render
	 * `up N days, HH:MM:SS` Tachikoma-style.
	 */
	public static float $init_time = 0.0;

	public static bool $shutting_down = false;

	/**
	 * Deferred-cleanup queue. Public so EventFramework's hot drain loop can
	 * read/shift it directly without paying a method-call frame per tick.
	 * Sibling to Core::$now and Core::$shutting_down (also public for
	 * the same reason).
	 *
	 * @var array<int, callable>
	 */
	public static array $closing = [];

	/** @var array<string,array{first_seen:float,count:int,emitted:bool}> */
	private static array $print_table = [];

	/** @var callable */
	private static $stderr_handler;

	/**
	 * Re-entry guard for emit_stderr(). The default handler routes through a
	 * `_repl` Partition; a fault inside that path (Partition write failure,
	 * Router throw, a node's fill() rate-limit-logging its own error) calls
	 * back into print_less_often → emit_stderr and recurses. Custom handlers
	 * set via set_stderr_handler() can recurse the same way. Guarded at the
	 * dispatcher (not inside one handler) so the protection applies uniformly.
	 *
	 * @var bool
	 */
	private static bool $in_stderr = false;

	/**
	 * Monotonic counter for shell message IDs. Reset by Core::reset() in tests.
	 * Single static int; integer increment is the cheapest possible counter.
	 */
	private static int $msg_counter = 0;

	public static function reset(): void {
		self::$nodes_by_name  = [];
		self::$nodes_by_fd    = [];
		self::$nodes_by_id    = [];
		self::$shutting_down  = false;
		self::$closing        = [];
		self::$print_table    = [];
		self::$msg_counter    = 0;
		self::$in_stderr      = false;
		// Default handler: when a worker has wired up the `_repl` conduit, route
		// stderr-style diagnostics through it as TM_BYTESTREAM addressed to
		// `_repl`. The worker's `_router` peels `_repl` and dispatches into
		// the Partition; downstream cli/SSE readers see the message with
		// empty TO, which the Dumper always renders — unaddressed broadcast,
		// no `show_sse` opt-in needed (stderr is an alarm, not observability).
		// Falls back to PHP's error_log when there's no _repl (request scope,
		// tests, CLI tools). Override via set_stderr_handler() in tests.
		self::$stderr_handler = static function ( string $msg ): void {
			$repl = self::$nodes_by_name['_repl'] ?? null;
			if ( null !== $repl ) {
				$m                       = Message::new_message();
				$m[ Message::TYPE ]      = Message::TM_BYTESTREAM;
				$m[ Message::TIMESTAMP ] = self::$now;
				$m[ Message::TO ]        = '_repl';
				$m[ Message::VALUE ]     = $msg;
				$repl->fill( $m );
				return;
			}
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \rtrim( $msg ) );
		};
		self::$now            = \microtime( true );
		self::$init_time      = self::$now;
	}

	/** Pre-increment monotonic message-id counter. */
	public static function msg_counter(): int {
		return ++self::$msg_counter;
	}

	public static function register_node( string $name, object $node ): void {
		self::$nodes_by_name[ $name ] = $node;
	}

	public static function unregister_node( string $name ): void {
		unset( self::$nodes_by_name[ $name ] );
	}

	public static function node( string $name ): ?object {
		return self::$nodes_by_name[ $name ] ?? null;
	}

	/**
	 * Tear down every registered node. Call from worker shutdown so each
	 * Partition's `remove_node()` runs — that's where Partition closes its
	 * file handles and releases its write_lock + heartbeat. Without this,
	 * the next worker spawn races a heartbeat that takes ~stale_timeout
	 * seconds to age out before the new Partition can acquire the lock.
	 *
	 * Snapshot the registry first so each remove_node()'s unregister doesn't
	 * mutate the iteration source.
	 */
	public static function cleanup_all_nodes(): void {
		$nodes = self::$nodes_by_name;
		foreach ( $nodes as $node ) {
			if ( \is_object( $node ) && \method_exists( $node, 'remove_node' ) ) {
				try {
					$node->remove_node();
				} catch ( \Throwable $e ) {
					// Best-effort teardown; one node's failure shouldn't block the rest.
					self::print_less_often( 'cleanup_all_nodes: ' . $e->getMessage() );
				}
			}
		}
	}

	public static function push_closing( callable $cb ): void {
		self::$closing[] = $cb;
	}

	public static function run_closing(): void {
		while ( ! empty( self::$closing ) ) {
			$cb = \array_shift( self::$closing );
			$cb();
		}
	}

	public static function set_stderr_handler( callable $h ): void {
		self::$stderr_handler = $h;
	}

	private static function emit_stderr( string $msg ): void {
		if ( self::$in_stderr ) {
			// Re-entry: the active handler itself triggered another stderr
			// emission (e.g., the _repl Partition write inside the default
			// handler failed and called print_less_often). Recursing back
			// through the handler would deadlock or stack-overflow; emit
			// straight to PHP's error_log as the last-resort sink.
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \rtrim( $msg ) );
			return;
		}
		self::$in_stderr = true;
		try {
			( self::$stderr_handler )( $msg . "\n" );
		} finally {
			// Reset even if the handler throws — otherwise a single bad
			// emission permanently latches every future stderr to the
			// error_log fallback.
			self::$in_stderr = false;
		}
	}

	/**
	 * Emit text on first call; suppress identical text within 60s window.
	 */
	public static function print_less_often( string $text ): void {
		$key = $text;
		$row = self::$print_table[ $key ] ?? [ 'first_seen' => 0.0, 'count' => 0, 'emitted' => false ];

		if ( ! $row['emitted'] || ( self::$now - $row['first_seen'] >= 60.0 ) ) {
			self::emit_stderr( $text );
			$row['first_seen'] = self::$now;
			$row['emitted']    = true;
			$row['count']      = 1;
		} else {
			++$row['count'];
		}
		self::$print_table[ $key ] = $row;
	}

	/**
	 * Suppress until the 10th occurrence within a 60s window, then emit and
	 * suppress further emissions for another 60s. Workers live ~10 minutes,
	 * so a longer squelch could mean a single emission per worker lifetime
	 * for rare-but-real noise — 60s gives enough visibility to catch
	 * intermittent issues without flooding stderr on a tight loop.
	 */
	public static function print_least_often( string $text ): void {
		$key = '_least_' . $text;
		$row = self::$print_table[ $key ] ?? [ 'first_seen' => self::$now, 'count' => 0, 'emitted' => false ];

		// Window expired since last emission → start a fresh count.
		if ( $row['emitted'] && ( self::$now - $row['first_seen'] >= 60.0 ) ) {
			$row['first_seen'] = self::$now;
			$row['count']      = 0;
			$row['emitted']    = false;
		}

		++$row['count'];

		if ( $row['count'] >= 10 && ! $row['emitted'] ) {
			self::emit_stderr( $text );
			$row['first_seen'] = self::$now;
			$row['emitted']    = true;
		}

		self::$print_table[ $key ] = $row;
	}
}

// Initialize singletons on plugin load.
Core::reset();
