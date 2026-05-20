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

	/**
	 * Process-global Shell variable map. `<varname>` interpolation in
	 * Shell::interpolate reads from here, and the Shell `var name =
	 * value` builtin writes here. Topology_Loader pre-populates
	 * predefined entries like `partition` before parsing a TSL file
	 * so the topology can refer to them via `<partition>`.
	 *
	 * @var array<string,string>
	 */
	public static array $var = [];

	/**
	 * Process-global runtime-config map. `<config:foo>` interpolation
	 * in Shell::interpolate reads `Core::$config['foo']`. Distinct
	 * namespace from $var: $var is mutable from TSL via the `var name
	 * = value` builtin; $config originates PHP-side (Topology_Loader
	 * populates it from substrate Config::load_config) and TSL is
	 * read-only against it.
	 *
	 * @var array<string,mixed>
	 */
	public static array $config = [];

	/** @var array<string> */
	public static array $recent_log = [];

	/** @var array<string,array{timestamp:float,count:int}> */
	public static array $recent_log_timers = [];

	/** @var float Seconds before a rate-limiter entry is eligible for pruning. */
	public static float $log_timeout = 60;

	/** @var callable */
	private static $stderr_handler;

	/**
	 * Re-entry guard for stderr(). The default handler routes through a
	 * `_repl` Partition; a fault inside that path (Partition write failure,
	 * Router throw, a node's fill() rate-limit-logging its own error) calls
	 * back into print_less_often → stderr and recurses. Custom handlers
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
		self::$nodes_by_name     = [];
		self::$nodes_by_fd       = [];
		self::$nodes_by_id       = [];
		self::$shutting_down     = false;
		self::$closing           = [];
		self::$recent_log        = [];
		self::$recent_log_timers = [];
		self::$msg_counter       = 0;
		self::$in_stderr         = false;
		self::$var               = [];
		self::$config            = [];
		// Default handler: when a worker has wired up the `_repl` conduit, route
		// stderr-style diagnostics through it as TM_BYTESTREAM addressed to
		// `_repl`. The worker's `_router` peels `_repl` and dispatches into
		// the Partition; downstream cli/SSE readers see the message with
		// empty TO, which the Dumper always renders — unaddressed broadcast
		// (stderr is an alarm, not observability).
		// Falls back to PHP's error_log when there's no _repl (request scope,
		// tests, CLI tools). Override via set_stderr_handler() in tests.
		self::$stderr_handler = static function ( string $msg ): void {
			$repl = self::$nodes_by_name['_repl'] ?? null;
			if ( null !== $repl ) {
				$m                       = Message::new_message();
				$m[ Message::TYPE ]      = Message::TM_BYTESTREAM;
				$m[ Message::TIMESTAMP ] = self::$now;
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
			if ( \method_exists( $node, 'remove_node' ) ) {
				try {
					$node->remove_node();
				} catch ( \Throwable $e ) {
					// Best-effort teardown; one node's failure shouldn't block the rest.
					self::stderr( 'cleanup_all_nodes: ' . $e->getMessage() );
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

	/**
	 * Emit once at the 10th identical occurrence; suppress otherwise. The
	 * entry is re-windowed when prune_logs() ages it out (Router tick), so a
	 * recurring message re-emits each timeout window. Mirrors Perl Tachikoma
	 * Node::print_least_often.
	 */
	public static function print_least_often( string $text ): void {
		$row = self::$recent_log_timers[ $text ] ?? null;
		if ( null !== $row ) {
			++$row['count'];
			if ( 10 === $row['count'] ) {
				self::stderr( $text );
			}
		} else {
			$row = [ 'timestamp' => self::$now, 'count' => 1, ];
		}
		self::$recent_log_timers[ $text ] = $row;
	}

	/**
	 * Emit text on first sight; suppress identical text thereafter. The entry
	 * is re-windowed when prune_logs() ages it out (Router tick), so a
	 * recurring message re-emits each timeout window. Mirrors Perl Tachikoma
	 * Node::print_less_often.
	 */
	public static function print_less_often( string $text ): void {
		$row = self::$recent_log_timers[ $text ] ?? null;
		if ( null !== $row ) {
			++$row['count'];
		} else {
			self::stderr( $text );
			$row = [ 'timestamp' => self::$now, 'count' => 1, ];
		}
		self::$recent_log_timers[ $text ] = $row;
	}

	public static function stderr( string $text ): void {
		if ( '' === $text ) {
			return;
		}
		if ( self::$in_stderr ) {
			// Re-entry: the active handler itself triggered another stderr
			// emission (e.g., the _repl Partition write inside the default
			// handler failed and called print_less_often). Recursing back
			// through the handler would deadlock or stack-overflow; emit
			// straight to PHP's error_log as the last-resort sink.
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \rtrim( $text ) );
			return;
		}
		self::$in_stderr = true;
		try {
			$line               = \rtrim( $text ) . "\n";
			self::$recent_log[] = $line;
			// Bounded tail for the REPL (Perl Tachikoma caps @RECENT_LOG at 100).
			while ( \count( self::$recent_log ) > 100 ) {
				\array_shift( self::$recent_log );
			}
			( self::$stderr_handler )( $line );
		} finally {
			// Reset even if the handler throws — otherwise a single bad
			// emission permanently latches every future stderr to the
			// error_log fallback.
			self::$in_stderr = false;
		}
	}

	/**
	 * Evict rate-limiter entries older than the timeout, so a recurring-but-
	 * stale message re-emits next time it fires. The Router calls this each
	 * tick (mirrors Perl Tachikoma Router::update_logs).
	 */
	public static function prune_logs(): void {
		foreach ( self::$recent_log_timers as $key => $row ) {
			if ( self::$now - $row['timestamp'] > self::$log_timeout ) {
				unset( self::$recent_log_timers[ $key ] );
			}
		}
	}
}

// Initialize singletons on plugin load.
Core::reset();
