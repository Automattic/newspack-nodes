<?php
/**
 * Bootstrap: plugin-level glue.
 *
 * Reads the `newspack_nodes/topologies` filter and expands it to a flat list of
 * worker descriptors (one per partition). Also exposes init helpers used by
 * the main plugin file: REST route registration and supervisor cron tick.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\SpawnController;

\defined( 'ABSPATH' ) || exit;

class Bootstrap {
	public static function get_topologies(): array {
		return (array) \apply_filters( 'newspack_nodes/topologies', [] );
	}

	public static function expand_workers(): array {
		$topologies = self::get_topologies();
		$workers    = [];
		foreach ( $topologies as $type => $config ) {
			$count = (int) ( $config['num_partitions'] ?? 1 );
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
	 * Resolve the configured base directory for runtime state (locks/, ipc/).
	 * Filterable so deployments can move it (e.g., /volumes/pyrobase/tmp/...).
	 */
	public static function base_dir(): string {
		return (string) \apply_filters( 'newspack_nodes/base_dir', '/tmp/newspack-nodes' );
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
	 * Supervisor tick: iterate workers, spawn any that need it.
	 * Wire to `newspack_nodes/supervisor` (a wp_cron-scheduled action).
	 */
	public static function run_supervisor_tick(): void {
		$supervisor = self::supervisor();
		$workers    = self::expand_workers();
		$now        = \microtime( true );
		$spawn_url  = \rest_url( 'newspack-nodes/v1/workers/spawn' );
		$token      = $supervisor->generate_spawn_token( (int) $now );

		foreach ( $workers as $w ) {
			if ( ! $supervisor->worker_needs_spawn( $w, $now ) ) {
				continue;
			}
			if ( $supervisor->is_recently_spawned( $w['type'], $w['partition'], $now ) ) {
				continue;
			}
			\wp_remote_post(
				$spawn_url,
				[
					'method'   => 'POST',
					'timeout'  => 1,
					'blocking' => false,
					'body'     => [
						'type'      => $w['type'],
						'partition' => $w['partition'],
						'nonce'     => $token,
					],
				]
			);
			$supervisor->record_spawn( $w['type'], $w['partition'], $now );
		}
	}

	/**
	 * Activation hook: schedule the supervisor cron (hourly is fine — workers
	 * self-respawn between ticks; cron is the safety net for cold starts).
	 */
	public static function activate(): void {
		if ( ! \wp_next_scheduled( 'newspack_nodes/supervisor' ) ) {
			\wp_schedule_event( \time() + 5, 'hourly', 'newspack_nodes/supervisor' );
		}
	}

	/**
	 * Deactivation hook: clear the supervisor cron.
	 */
	public static function deactivate(): void {
		\wp_clear_scheduled_hook( 'newspack_nodes/supervisor' );
	}
}
