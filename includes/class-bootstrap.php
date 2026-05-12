<?php
/**
 * Bootstrap: plugin-level glue.
 *
 * Reads the `newspack_nodes/topologies` filter and expands it to a flat list of
 * worker descriptors (one per partition). Also exposes init helpers used by
 * the main plugin file: REST route registration and supervisor cron tick.
 *
 * Hardening:
 *  - MAX_PARTITIONS=16 cap on partition counts read from topologies. Bounded
 *    loops downstream; matches the supervisor cleanup ceiling. Spec line 844.
 *  - register_standalone_workers() exposes the supervisor (and any future
 *    runtime-internal singleton workers) to SpawnController::validate_worker_type
 *    so SpawnController can accept type='supervisor' without round-tripping
 *    through the topologies filter.
 *  - run_supervisor_tick() invokes Supervisor::run() (the long-running 595s
 *    in-process tick loop), not a single iteration. Cron is the backstop;
 *    the supervisor's own loop is the primary scheduling mechanism.
 *  - is_logging_enabled() gates the supervisor: false → unschedule + return
 *    cleanly (spec line 846).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\SpawnController;

\defined( 'ABSPATH' ) || exit;

class Bootstrap {
	/**
	 * Filter-driven topology registry. Returns the raw filter value.
	 */
	public static function get_topologies(): array {
		return (array) \apply_filters( 'newspack_nodes/topologies', [] );
	}

	/**
	 * Expand topologies to flat worker descriptors, one per partition.
	 *
	 * Partition counts are clamped to MAX_PARTITIONS so the supervisor's
	 * cleanup walk and the spawn endpoint's bounds checks stay within the
	 * documented ceiling regardless of misconfiguration.
	 */
	public static function expand_workers(): array {
		$topologies = self::get_topologies();
		$workers    = [];
		foreach ( $topologies as $type => $config ) {
			$count = (int) ( $config['num_partitions'] ?? 1 );
			$count = \min( SupervisorBase::MAX_PARTITIONS, \max( 1, $count ) );
			for ( $p = 0; $p < $count; ++$p ) {
				$workers[] = [
					'type'          => $type,
					'partition'     => $p,
					'topology'      => $config['topology'] ?? '',
					'stale_timeout' => $config['stale_timeout'] ?? Lock::STALE_TIMEOUT,
				];
			}
		}
		return $workers;
	}

	/**
	 * Register runtime-internal standalone workers (the supervisor itself,
	 * for now) so SpawnController::validate_worker_type can authorize them
	 * without faking a topology entry.
	 *
	 * @return array<string,array> Map of type => config.
	 */
	public static function register_standalone_workers(): array {
		return [
			'supervisor' => [
				'class'      => Supervisor::class,
				'partitions' => false, // singleton — partition is always 0.
			],
		];
	}

	/**
	 * Logging gate. Plugins / config can disable the supervisor without
	 * deactivating the plugin. Implemented as a filter so applications can
	 * tie it to their own settings UI; defaults to enabled.
	 *
	 * Returning false from this filter makes run_supervisor_tick() unschedule
	 * the cron and return early; supervisor's check_config() honors it too.
	 * Spec line 846.
	 */
	public static function is_logging_enabled(): bool {
		return (bool) \apply_filters( 'newspack_nodes/enable_logging', true );
	}

	/**
	 * Resolve the configured base directory for runtime state (locks/, ipc/).
	 * Single source of truth: `Config::load_config()` (file default → WP
	 * options overlay).
	 */
	public static function base_dir(): string {
		return (string) ( Config::load_config()['base_directory'] ?? '/tmp/newspack-nodes' );
	}

	/**
	 * Build a Supervisor instance using the WordPress NONCE_SALT for HMAC.
	 * Falls back to a static placeholder if NONCE_SALT is not defined — this
	 * should only happen in test contexts; production WP always defines it.
	 */
	public static function supervisor(): Supervisor {
		$nonce_salt = \defined( 'NONCE_SALT' ) ? \NONCE_SALT : 'fallback-salt-please-set-NONCE_SALT';
		return new Supervisor( self::base_dir(), $nonce_salt );
	}

	/**
	 * Register the SpawnController routes — wire to `rest_api_init`.
	 */
	public static function register_rest_routes(): void {
		( new SpawnController( self::supervisor() ) )->register_routes();
	}

	/**
	 * Supervisor tick: invoke Supervisor::run() (long-running 595s loop).
	 * Wired to `newspack_nodes/supervisor` via wp_cron at minute cadence.
	 *
	 * Cron is the BACKSTOP — the supervisor's own self-respawn chain (run()
	 * end → POST /spawn → fresh supervisor) is the primary scheduling
	 * mechanism. Cron only catches a dead chain (supervisor crashed and
	 * couldn't fire spawn_next_supervisor).
	 *
	 * If logging is disabled, unschedule the cron and return cleanly.
	 */
	public static function run_supervisor_tick(): void {
		if ( ! self::is_logging_enabled() ) {
			self::unschedule_supervisor();
			return;
		}
		self::supervisor()->run();
	}

	/**
	 * Unschedule the supervisor cron event. Used by the disable-logging path
	 * and the deactivation hook.
	 */
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

	/**
	 * Activation hook: schedule the supervisor cron at minute cadence.
	 * Workers self-respawn between ticks; cron is the safety net for cold starts.
	 */
	public static function activate(): void {
		if ( ! \wp_next_scheduled( 'newspack_nodes/supervisor' ) ) {
			\wp_schedule_event( \time() + 5, 'newspack_nodes_minute', 'newspack_nodes/supervisor' );
		}
	}

	/**
	 * Deactivation hook: clear the supervisor cron.
	 */
	public static function deactivate(): void {
		\wp_clear_scheduled_hook( 'newspack_nodes/supervisor' );
	}
}
