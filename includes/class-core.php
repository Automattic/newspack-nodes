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

	/** @var float Microsecond timestamp; updated by event loop or set explicitly in tests. */
	public static float $now = 0.0;
	/** @var float Same as $now (microsecond resolution; do not truncate). */
	public static float $right_now = 0.0;

	public static bool $shutting_down = false;

	/** @var array<callable> */
	private static array $closing = [];

	/** @var array<string,array{first_seen:float,count:int,emitted:bool}> */
	private static array $print_table = [];

	/** @var callable */
	private static $stderr_handler;

	public static function reset(): void {
		self::$nodes_by_name  = [];
		self::$nodes_by_fd    = [];
		self::$nodes_by_id    = [];
		self::$shutting_down  = false;
		self::$closing        = [];
		self::$print_table    = [];
		self::$stderr_handler = static fn ( string $msg ) => \error_log( \rtrim( $msg ) );
		self::update_time();
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

	public static function update_time(): void {
		$t              = \microtime( true );
		self::$right_now = $t;
		self::$now       = $t;
	}

	public static function set_now( float $t ): void {
		self::$right_now = $t;
		self::$now       = $t;
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

		if ( ! $row['emitted'] || ( self::$right_now - $row['first_seen'] >= 60.0 ) ) {
			self::emit_stderr( $text );
			$row['first_seen'] = self::$right_now;
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
		$row = self::$print_table[ $key ] ?? [ 'first_seen' => self::$right_now, 'count' => 0, 'emitted' => false ];

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
