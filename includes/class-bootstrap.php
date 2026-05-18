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
 *  - run_supervisor_tick() invokes Supervisor::run() (the long-running 595s
 *    in-process tick loop), not a single iteration. Cron is the backstop;
 *    the supervisor's own loop is the primary scheduling mechanism.
 *  - is_logging_enabled() gates the supervisor: false → unschedule + return
 *    cleanly (spec line 846).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Rest\Command_Controller;
use Newspack_Nodes\Rest\Messages_Stream_Controller;
use Newspack_Nodes\Rest\SpawnController;
use Newspack_Nodes\Rest\TopologyStreamController;

\defined( 'ABSPATH' ) || exit;

class Bootstrap {
	/**
	 * Filter-driven topology catalog. The application publishes its full
	 * file-default set via `newspack_nodes/topologies` — that's the catalog
	 * of what topologies exist and their default per-topology metadata. The
	 * substrate owns the operator overlay: `newspack_nodes_topologies` is a
	 * substrate option set by the admin checkboxes. When present, it
	 * filters the catalog down to the active subset. `false` (option never
	 * written) means "use the full catalog" — gives a sensible starter set
	 * on a fresh install without shadowing operator choices. `[]` is a
	 * valid stored value (operator unchecked everything), distinct from
	 * `false`.
	 *
	 * Operator selections that name a TSL file the application didn't
	 * publish in its catalog (the admin UI renders every registered TSL,
	 * not just catalog entries) fall back to `Topology_Registry` lookup —
	 * the entry is synthesized from the TSL frontmatter with the same
	 * shape the application produces, so the supervisor can spawn it.
	 * Synthesized entries inherit the substrate's live `num_partitions`
	 * setting as the default partition count — operators expect the
	 * admin's num_partitions slider to size every fleet they check, not
	 * just the ones the app pre-blessed. Names that don't resolve to a
	 * TSL file are dropped, guarding against typos / stale option values.
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
			$synthesized = Topology_Registry::synthesize_entry( $name, $default_np, Lock::STALE_TIMEOUT );
			if ( null !== $synthesized ) {
				$active[ $name ] = $synthesized;
			}
		}
		return $active;
	}

	/**
	 * Full topology catalog (ignores the active-overlay option). Substrate
	 * admin's Topologies checkboxes render against this so operators can
	 * see every available topology, including ones currently unchecked.
	 */
	public static function get_topology_catalog(): array {
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
	 * Register substrate REST routes — wired to `rest_api_init`.
	 */
	public static function register_rest_routes(): void {
		( new SpawnController( self::supervisor() ) )->register_routes();
		( new TopologyStreamController() )->register_routes();
		( new Messages_Stream_Controller() )->register_routes();
		( new Command_Controller() )->register_routes();
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
		// Don't run the supervisor if there's nothing to supervise. With every
		// topology gated off (enable_workers/enable_jobs/enable_aggregator all
		// false, etc.), `expand_workers()` returns []. The supervisor would
		// otherwise still spin up its 595s tick loop, heartbeat, fire
		// supervisor_periodic, and self-respawn — all pointless when no
		// workers exist to spawn or to consume the periodic-hook output.
		// Leave the cron scheduled so the next minute-tick after the operator
		// flips a gate back on picks up the new topology fleet automatically —
		// unscheduling would require plugin re-activation to re-arm.
		// Cost of a minute-cadence no-op tick is negligible.
		if ( empty( self::expand_workers() ) ) {
			return;
		}
		// Tag the env var BEFORE firing the wrapping action so a listener
		// (event-logger-nodes wraps this with begin_job_context) builds its
		// fresh request scope with `worker_type='supervisor'` already set.
		// Without this, the cron-backstop path logs the 595s tick as an
		// untagged /wp-cron.php request that counts in global averages.
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
	 * Scan {base_dir}/locks/*.lock.d/ and register one substrate Partition
	 * Node per live worker. The Partition is named after the worker's
	 * reader id (e.g. `firehose-workers.p0`) and pointed at the worker's
	 * input partition directory. Router's existing TO-peel dispatch then
	 * routes IPC commands uniformly — `Router::fill` resolves the head
	 * to the registered Partition, which writes the message to disk.
	 *
	 * Returns the number of Partitions registered (= live workers found
	 * with both a lock dir AND an ipc/.../input dir).
	 */
	public static function register_worker_partitions( string $base_dir ): int {
		$count = 0;
		foreach ( \glob( "{$base_dir}/locks/*.lock.d", \GLOB_ONLYDIR ) ?: [] as $lock_dir ) {
			$reader_id = \basename( $lock_dir, '.lock.d' );
			$input_dir = "{$base_dir}/ipc/{$reader_id}/input";
			if ( ! \is_dir( $input_dir ) ) {
				continue;
			}
			$p = new Partition( $input_dir, 0 );
			$p->name( $reader_id );
			++$count;
		}
		return $count;
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
	 * Self-heal: re-arm the supervisor cron if it should be running but isn't.
	 *
	 * The activation hook only fires on plugin (re)activation. If the cron
	 * event gets cleared by anything else — DB rebuild, `wp cron event delete`,
	 * hosting platform reset — workers stop ticking until the operator
	 * deactivates and reactivates the plugin. Hook this on `admin_init` so
	 * the next wp-admin pageview re-arms the schedule automatically.
	 *
	 * Three short-circuits keep this cheap and idempotent:
	 *   - logging disabled → operator intent says "don't run"
	 *   - no topologies selected → nothing to supervise
	 *   - cron already scheduled → already healthy
	 *
	 * Only when all three pass do we call activate() to re-schedule.
	 */
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

	/**
	 * Deactivation hook: clear the supervisor cron.
	 */
	public static function deactivate(): void {
		\wp_clear_scheduled_hook( 'newspack_nodes/supervisor' );
	}
}
