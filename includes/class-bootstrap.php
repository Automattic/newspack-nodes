<?php
/**
 * Bootstrap: plugin-level glue.
 *
 * Expands the `newspack_nodes/topologies` filter to flat worker descriptors,
 * and exposes init helpers (REST routes, supervisor cron tick).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\HTTP_In_Node;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\Rest\Spawn_Controller;

\defined( 'ABSPATH' ) || exit;

class Bootstrap {
	/**
	 * Active topology set: the `newspack_nodes/topologies` catalog filtered by the operator overlay.
	 *
	 * Overlay option false = full catalog, [] = none, array = that subset (non-catalog names synthesized).
	 */
	public static function get_topologies(): array {
		$catalog = (array) \apply_filters( 'newspack_nodes/topologies', [] );
		$option  = \function_exists( 'get_option' )
			? \get_option( 'newspack_nodes_topologies', false )
			: false;
		if ( false === $option ) {
			return $catalog;
		}
		if ( ! \is_array( $option ) ) {
			return $catalog;
		}
		$default_np = (int) ( Config::load_config()['num_partitions'] ?? 1 );
		$active = [];
		foreach ( $option as $name ) {
			if ( ! \is_string( $name ) || '' === $name ) {
				continue;
			}
			if ( isset( $catalog[ $name ] ) ) {
				$active[ $name ] = $catalog[ $name ];
				continue;
			}
			$synthesized = Topology_Registry::synthesize_entry( $name, $default_np, Lock_Node::STALE_TIMEOUT );
			if ( null !== $synthesized ) {
				$active[ $name ] = $synthesized;
			}
		}
		return $active;
	}

	/** Full topology catalog (ignores the operator overlay); the admin checkboxes render against this. */
	public static function get_topology_catalog(): array {
		return (array) \apply_filters( 'newspack_nodes/topologies', [] );
	}

	/** Expand topologies to flat worker descriptors, one per partition (count clamped to MAX_PARTITIONS). */
	public static function expand_workers(): array {
		$topologies = self::get_topologies();
		$workers    = [];
		foreach ( $topologies as $type => $config ) {
			$count = (int) ( $config['num_partitions'] ?? 1 );
			$count = \min( Supervisor_Base::MAX_PARTITIONS, \max( 1, $count ) );
			for ( $p = 0; $p < $count; ++$p ) {
				$workers[] = [
					'type'          => $type,
					'partition'     => $p,
					'topology'      => $config['topology'] ?? '',
					'stale_timeout' => $config['stale_timeout'] ?? Lock_Node::STALE_TIMEOUT,
				];
			}
		}
		return $workers;
	}

	/** Logging gate (filter, default true); false makes the supervisor unschedule + exit. */
	public static function is_logging_enabled(): bool {
		return (bool) \apply_filters( 'newspack_nodes/enable_logging', true );
	}

	/** Configured base directory for runtime state (locks/, ipc/). */
	public static function base_dir(): string {
		return (string) ( Config::load_config()['base_directory'] ?? '/tmp/newspack-nodes' );
	}

	/** Build a Supervisor using NONCE_SALT for HMAC (placeholder fallback only in tests). */
	public static function supervisor(): Supervisor {
		$nonce_salt = \defined( 'NONCE_SALT' ) ? \NONCE_SALT : 'fallback-salt-please-set-NONCE_SALT';
		return new Supervisor( self::base_dir(), $nonce_salt );
	}

	/** Register substrate REST routes — wired to `rest_api_init`. */
	public static function register_rest_routes(): void {
		( new Spawn_Controller( self::supervisor() ) )->register_routes();
		( new SSE_Out_Node() )->register_routes();
		( new HTTP_In_Node() )->register_routes();
	}

	/** Supervisor cron tick: run Supervisor::run() (595s loop). Cron is the cold-start backstop. */
	public static function run_supervisor_tick(): void {
		if ( ! self::is_logging_enabled() ) {
			self::unschedule_supervisor();
			return;
		}
		// Leave the cron scheduled so a re-enabled gate is picked up next tick.
		if ( empty( self::expand_workers() ) ) {
			return;
		}
		// Tag the env var BEFORE the wrapping action so listeners build scope with worker_type set.
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = 'supervisor';
		$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = '0';
		\do_action( 'newspack_nodes/before_supervisor_run' );
		try {
			self::supervisor()->run();
		} finally {
			\do_action( 'newspack_nodes/after_supervisor_run' );
		}
	}

	/**
	 * Mount one worker's input Partition by reader id (format-validated, idempotent).
	 *
	 * @return bool True iff the partition is now mounted.
	 */
	public static function register_worker_partition( string $worker_id, string $base_dir ): bool {
		if ( ! \preg_match( '/^[a-z0-9_-]+\.p\d+$/', $worker_id ) ) {
			return false;
		}
		if ( Core::node( $worker_id ) instanceof Partition_Node ) {
			return true;
		}
		// A live worker holds a lock dir; its input dir is what we mount.
		if ( ! \is_dir( "{$base_dir}/locks/{$worker_id}.lock.d" ) ) {
			return false;
		}
		$input_dir = "{$base_dir}/ipc/{$worker_id}/input";
		if ( ! \is_dir( $input_dir ) ) {
			return false;
		}
		( new Partition_Node( $input_dir, 0 ) )->name( $worker_id );
		return true;
	}

	/** Mount every live worker's input Partition; returns the count registered. */
	public static function register_worker_partitions( string $base_dir ): int {
		$count = 0;
		foreach ( \glob( "{$base_dir}/locks/*.lock.d", \GLOB_ONLYDIR ) ?: [] as $lock_dir ) {
			if ( self::register_worker_partition( \basename( $lock_dir, '.lock.d' ), $base_dir ) ) {
				++$count;
			}
		}
		return $count;
	}

	/** Unschedule the supervisor cron event. */
	public static function unschedule_supervisor(): void {
		if ( ! \function_exists( 'wp_next_scheduled' ) || ! \function_exists( 'wp_unschedule_event' ) ) {
			return;
		}
		$next = \wp_next_scheduled( 'newspack_nodes/supervisor' );
		if ( $next ) {
			\wp_unschedule_event( $next, 'newspack_nodes/supervisor' );
		}
	}

	/**
	 * Register a 60-second cron interval for the supervisor tick.
	 * Wired to the `cron_schedules` filter from the plugin file.
	 */
	public static function register_cron_schedules( array $schedules ): array {
		if ( ! isset( $schedules['newspack_nodes_minute'] ) ) {
			$schedules['newspack_nodes_minute'] = [
				'interval' => 60,
				'display'  => 'Every Minute (Newspack Nodes)',
			];
		}
		return $schedules;
	}

	/** Activation hook: schedule the supervisor cron at minute cadence. */
	public static function activate(): void {
		if ( ! \wp_next_scheduled( 'newspack_nodes/supervisor' ) ) {
			\wp_schedule_event( \time() + 5, 'newspack_nodes_minute', 'newspack_nodes/supervisor' );
		}
	}

	/** Self-heal (admin_init): re-arm the supervisor cron if it should run but isn't scheduled. */
	public static function self_heal_supervisor_cron(): void {
		if ( ! self::is_logging_enabled() ) {
			return;
		}
		if ( empty( self::get_topologies() ) ) {
			return;
		}
		if ( \wp_next_scheduled( 'newspack_nodes/supervisor' ) ) {
			return;
		}
		self::activate();
	}

	/** Deactivation hook: clear the supervisor cron. */
	public static function deactivate(): void {
		\wp_clear_scheduled_hook( 'newspack_nodes/supervisor' );
	}
}
