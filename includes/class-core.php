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
		// Default handler writes through PHP's error log — that's intentional
		// for worker stderr. Override via set_stderr_handler() in tests.
		// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
		self::$stderr_handler = static fn ( string $msg ) => \error_log( \rtrim( $msg ) );
		self::$now            = \microtime( true );
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
		( self::$stderr_handler )( $msg . "\n" );
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
	 * Suppress until 10th occurrence (within 300s); emit once at that point.
	 */
	public static function print_least_often( string $text ): void {
		$key = '_least_' . $text;
		$row = self::$print_table[ $key ] ?? [ 'first_seen' => self::$now, 'count' => 0, 'emitted' => false ];

		++$row['count'];

		if ( $row['count'] >= 10 && ! $row['emitted'] ) {
			self::emit_stderr( $text );
			$row['emitted'] = true;
		}

		self::$print_table[ $key ] = $row;
	}
}

// Initialize singletons on plugin load.
Core::reset();
