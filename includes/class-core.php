<?php
/**
 * Core: global registries + clock + closing queue + stderr.
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

	/** @var float Microsecond-resolution timestamp; updated by the event loop or in tests. */
	public static float $now = 0.0;

	/** Process start time, stamped each Core::reset(); the `uptime` verb subtracts it from $now. */
	public static float $init_time = 0.0;

	public static bool $shutting_down = false;

	/**
	 * Deferred-cleanup queue; public so the hot drain loop can shift it without a method frame.
	 *
	 * @var array<int, callable>
	 */
	public static array $closing = [];

	/** @var array<string,string> Process-global Shell variable map. */
	public static array $var = [];

	/** @var array<string,mixed> Process-global runtime-config map; read-only from TSL. */
	public static array $config = [];

	/** Process-global shared Memcached handle; set once by the application bootstrap, null when unconfigured. */
	public static ?\Memcached $memd = null;

	/** @var array<string> */
	public static array $recent_log = [];

	/** @var array<string,array{timestamp:float,count:int}> */
	public static array $recent_log_timers = [];

	/** @var float Seconds before a rate-limiter entry is eligible for pruning. */
	public static float $log_timeout = 60;

	/** @var callable */
	private static $stderr_handler;

	/** Re-entry guard for stderr(); the default handler can recurse via _repl write failures. */
	private static bool $in_stderr = false;

	/** Monotonic counter for shell message IDs; reset by Core::reset(). */
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
		self::$memd              = null;
		// Default handler: route through `_repl` if wired, else error_log.
		self::$stderr_handler = static function ( string $msg ): void {
			$repl = self::$nodes_by_name[ Node_Names::REPL ] ?? null;
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

	/** Tear down every registered node; snapshots the registry first so unregister doesn't mutate the iteration source. */
	public static function cleanup_all_nodes(): void {
		$nodes = self::$nodes_by_name;
		foreach ( $nodes as $node ) {
			if ( \method_exists( $node, 'remove_node' ) ) {
				try {
					$node->remove_node();
				} catch ( \Throwable $e ) {
					// Best-effort: one node's failure shouldn't block the rest.
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

	/** Emit once at the 10th identical occurrence; suppress otherwise (re-windowed by prune_logs). */
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

	/** Emit text on first sight; suppress identical text thereafter (re-windowed by prune_logs). */
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
			// Re-entry guard: go straight to error_log to avoid recursion.
			// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
			\error_log( \rtrim( $text ) );
			return;
		}
		self::$in_stderr = true;
		try {
			$line               = \rtrim( $text ) . "\n";
			self::$recent_log[] = $line;
			// Bounded tail for the REPL (Tachikoma caps @RECENT_LOG at 100).
			while ( \count( self::$recent_log ) > 100 ) {
				\array_shift( self::$recent_log );
			}
			( self::$stderr_handler )( $line );
		} finally {
			// Reset even if the handler throws, else stderr latches to fallback forever.
			self::$in_stderr = false;
		}
	}

	/** Evict rate-limiter entries older than the timeout so stale messages re-emit (per Router tick). */
	public static function prune_logs(): void {
		foreach ( self::$recent_log_timers as $key => $row ) {
			if ( self::$now - $row['timestamp'] > self::$log_timeout ) {
				unset( self::$recent_log_timers[ $key ] );
			}
		}
	}
}

Core::reset();
