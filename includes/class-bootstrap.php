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
use Newspack_Nodes\Rest\Log_Stream_Out_Node;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\Rest\Spawn_Controller;

\defined( 'ABSPATH' ) || exit;

class Bootstrap {

	/** Site Health test id (also the `test` field WP echoes back on the result). */
	public const SITE_HEALTH_TEST = 'newspack_nodes_fleet';

	/**
	 * `\Memcached`-construction seam. Lazily-defaulted to a closure that builds
	 * the real handle. Tests reassign in setUp to return an in-memory double so
	 * the server-parsing + empty-check + context-aware-failure path runs as real
	 * production code rather than being mocked away.
	 *
	 * Signature: `function (): \Memcached`.
	 *
	 * @var (\Closure(): \Memcached)|null
	 */
	public static ?\Closure $memcached_factory = null;

	/**
	 * Supervisor enable/disable test seam. Production leaves this null (enabled) —
	 * the supervisor has no production off-switch (no config field, no caller).
	 * Tests set false to exercise the disabled path. Replaced the test-only
	 * `newspack_nodes/enable_supervisor` filter.
	 *
	 * @var bool|null
	 */
	public static ?bool $supervisor_enabled_override = null;

	/**
	 * Supervisor-construction seam. Lazily-defaulted to a closure building the
	 * real Supervisor. Tests reassign to inject a double so run_supervisor_tick()'s
	 * wrapper (env tagging, before/after actions, finally-on-throw) is testable
	 * without running the real 595s spawn loop — DI of a subsystem the wrapper
	 * doesn't own, not a behavior gate.
	 *
	 * Signature: `function (): Supervisor`.
	 *
	 * @var (\Closure(): Supervisor)|null
	 */
	public static ?\Closure $supervisor_factory = null;

	/** Guards ensure_runtime_wired() so repeat entry-point calls in one request are no-ops. */
	private static bool $runtime_wired = false;

	/** Tracks the event entering schedule_event so a late falsy veto still has context. */
	private static bool $schedule_event_context_is_supervisor = false;

	/** Supervisor cron tick: run Supervisor::run() (595s loop). Cron is the cold-start backstop. */
	public static function run_supervisor_tick(): void {
		self::ensure_runtime_wired();
		if ( ! self::is_supervisor_enabled() ) {
			self::unschedule_supervisor();
			return;
		}
		if ( empty( self::expand_workers() ) ) {
			return;
		}
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
	 * Wire the substrate runtime: node-class namespaces, the `<config:…>` token
	 * namespace, the stock-topology dir, and the shared `Core::$memd` handle.
	 *
	 * Idempotent and lazy — called from the entry points that actually use the
	 * node graph / cache (`rest_api_init`, admin, WP-CLI, the supervisor tick),
	 * NOT at plugin-file scope. A plain frontend page view touches none of these,
	 * so it no longer autoloads the Config System + Command_Interpreter_Node +
	 * Topology_Registry or builds a `\Memcached` connection it never uses. This is
	 * the per-request hot-path the v0.13.0 Config System regressed.
	 */
	public static function ensure_runtime_wired(): void {
		if ( self::$runtime_wired ) {
			return;
		}
		self::$runtime_wired = true;
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Rest\\' );
		Config::register_token_namespace();
		Topology_Registry::register_builtin_dir( \dirname( __DIR__ ) . '/topologies' );
		Topology_Registry::register_user_dir( Bootstrap::base_dir() . '/topologies' );
		\add_filter( 'newspack_nodes/registered_log_producers', [ self::class, 'register_log_producers' ] );
		// Fleet alerting: Site Health test + rate-limited alert emission.
		\add_filter( 'site_status_tests', [ self::class, 'register_site_health_tests' ] );
		\add_action( 'newspack_nodes/supervisor_periodic', [ Alerts::class, 'emit' ] );
		if ( \function_exists( 'get_option' ) ) {
			self::init_memcached();
		}
		// Footgun: don't wire SSE_Slot_Pool here; force-loads SSE REST routes.
	}

	/**
	 * Build the one shared `\Memcached` handle on `Core::$memd` from the
	 * substrate's own `memcache_servers` config. The substrate owns this — every
	 * substrate path that needs caching (command-auth nonce single-use, SSE slot
	 * pool, Consumer cursor publish) reads `Core::$memd` and must not depend on
	 * an application plugin to populate it.
	 *
	 * Empty/invalid server list sets `Core::$memd = null` — deliberately NOT a
	 * fallback handle. Null is what the consumers' own fail paths key on:
	 * command-auth refuses + logs once (single-use unverifiable), stats fail
	 * soft, SSE slots fail closed. A non-null fallback (e.g. an unreachable
	 * localhost) would suppress command-auth's `instanceof` warning and silently
	 * fail closed instead — the exact bug this replaces. No-op when the PECL
	 * `\Memcached` class is absent.
	 */
	public static function init_memcached(): void {
		if ( ! \class_exists( '\Memcached' ) ) {
			return;
		}
		$servers = Config::value( 'memcache_servers' );
		if ( ! \is_array( $servers ) || empty( $servers ) ) {
			Core::$memd = null;
			return;
		}
		$factory = self::$memcached_factory ?? static fn (): \Memcached => new \Memcached();
		$memd    = $factory();
		/** @var int|float|string|bool|null $server */
		foreach ( $servers as $server ) {
			$parts = \explode( ':', (string) $server );
			$memd->addServer( $parts[0], (int) ( $parts[1] ?? 11211 ) );
		}
		Core::$memd = empty( $memd->getServerList() ) ? null : $memd;
	}

	/** Supervisor enable gate (default true); false makes the supervisor unschedule + exit. */
	public static function is_supervisor_enabled(): bool {
		return self::$supervisor_enabled_override ?? true;
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
	 * Expand topologies to flat worker descriptors, one per partition (count clamped to MAX_PARTITIONS).
	 *
	 * @return array<int, array{type: string, partition: int, topology: mixed, stale_timeout: mixed}>
	 */
	public static function expand_workers(): array {
		$topologies = self::get_topologies();
		$workers    = [];
		foreach ( $topologies as $type => $config ) {
			$config   = Core::arr( $config );
			$np_raw   = $config['num_partitions'] ?? 1;
			$count    = Core::num_int( $np_raw, 1 );
			$count    = \min( Supervisor_Base::MAX_PARTITIONS, \max( 1, $count ) );
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

	/**
	 * Active topology set: the `newspack_nodes/topologies` catalog filtered by the operator overlay.
	 *
	 * Overlay option false = full catalog, [] = none, array = that subset (non-catalog names synthesized).
	 *
	 * @return array<string, mixed> Topology name => entry (keys are always non-empty strings).
	 */
	public static function get_topologies(): array {
		$catalog = self::get_topology_catalog();
		// Active set = `topologies` config key; empty default spawns nothing.
		$active_names = Config::value( 'topologies' );
		if ( ! \is_array( $active_names ) ) {
			$active_names = [];
		}
		$np_raw     = Config::value( 'num_partitions' );
		$default_np = Core::num_int( $np_raw, 1 );
		$active     = [];
		foreach ( $active_names as $name ) {
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

	/**
	 * Full topology catalog (ignores the operator overlay); the admin checkboxes render against this.
	 *
	 * @return array<array-key, mixed> Topology name => entry.
	 */
	public static function get_topology_catalog(): array {
		self::ensure_runtime_wired();
		return (array) \apply_filters( 'newspack_nodes/topologies', [] );
	}

	/** Build a Supervisor using NONCE_SALT for HMAC (factory seam injectable by tests). */
	public static function supervisor(): Supervisor {
		$factory = self::$supervisor_factory ?? static fn (): Supervisor => new Supervisor( self::base_dir(), \NONCE_SALT );
		return $factory();
	}

	/** Configured base directory for runtime state (locks/, ipc/). */
	public static function base_dir(): string {
		return Config::get_base_directory();
	}

	/** Self-heal (admin_init): re-arm the supervisor cron if it should run but isn't scheduled. */
	public static function self_heal_supervisor_cron(): void {
		if ( ! self::is_supervisor_enabled() ) {
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

	/** Activation hook: schedule the supervisor cron at minute cadence. */
	public static function activate(): void {
		if ( ! \wp_next_scheduled( 'newspack_nodes/supervisor' ) ) {
			$result = \wp_schedule_event( \time() + 5, 'newspack_nodes_minute', 'newspack_nodes/supervisor', [], true );
			if ( \is_wp_error( $result ) ) {
				Core::print_less_often(
					'supervisor cron schedule failed: ',
					\sprintf(
						'code=%s message=%s schedule=newspack_nodes_minute',
						$result->get_error_code(),
						$result->get_error_message()
					)
				);
			}
		}
	}

	/**
	 * Canonical partition count for a topology: the catalog entry's count, else
	 * the TSL frontmatter (`var num_partitions`), else the config default —
	 * clamped to [1, MAX_PARTITIONS] exactly like expand_workers, so the count
	 * the Path menu shows can never disagree with what the supervisor SPAWNS.
	 * This is the SINGLE derivation the admin localizer and the `topologies.list`
	 * verb both call.
	 *
	 * @param string $name Topology name.
	 * @return int Partition count in [1, MAX_PARTITIONS].
	 */
	public static function num_partitions_for( string $name ): int {
		$np_raw     = Config::value( 'num_partitions' );
		$default_np = Core::num_int( $np_raw, 1 );
		$count      = $default_np;

		$catalog_entry = self::get_topology_catalog()[ $name ] ?? null;
		if (
			\is_array( $catalog_entry ) &&
			isset( $catalog_entry['num_partitions'] ) &&
			\is_scalar( $catalog_entry['num_partitions'] )
		) {
			$count = (int) $catalog_entry['num_partitions'];
		} else {
			$synth = Topology_Registry::synthesize_entry( $name, $default_np, Lock_Node::STALE_TIMEOUT );
			if (
				null !== $synth &&
				isset( $synth['num_partitions'] ) &&
				\is_scalar( $synth['num_partitions'] )
			) {
				$count = (int) $synth['num_partitions'];
			}
		}

		return \min( Supervisor_Base::MAX_PARTITIONS, \max( 1, $count ) );
	}

	/**
	 * Veto-time diagnostic for the supervisor cron, registered on
	 * pre_schedule_event AND pre_reschedule_event at PHP_INT_MAX - 2. When an
	 * earlier callback short-circuits OUR event with false or a WP_Error,
	 * log the active filter chain — the culprit is in it by definition.
	 * These filters run inside wp_schedule_event/wp_reschedule_event, which
	 * every cron runner still calls (Cron Control short-circuits these same
	 * filters on Atomic), unlike the wp-cron.php-only error actions.
	 *
	 * @param mixed $pre   Short-circuit value accumulated by earlier callbacks.
	 * @param mixed $event Event object (hook, timestamp, schedule, args, interval).
	 * @return mixed $pre, unchanged.
	 */
	public static function log_supervisor_schedule_veto( $pre, $event ) {
		$hook = self::event_hook( $event );
		if ( 'newspack_nodes/supervisor' !== $hook ) {
			return $pre;
		}
		// null = nobody intervened; truthy non-error = another runner took it.
		if ( false !== $pre && ! \is_wp_error( $pre ) ) {
			return $pre;
		}

		$filter = (string) \current_filter();
		$reason = \is_wp_error( $pre ) ? $pre->get_error_code() . ': ' . $pre->get_error_message() : 'false';
		Core::print_less_often(
			'supervisor cron vetoed: ',
			\sprintf(
				'filter=%s value=%s callbacks=[%s]',
				$filter,
				$reason,
				self::describe_hook_callbacks( $filter )
			)
		);
		return $pre;
	}

	/** Extract an event object's hook field, if present. */
	private static function event_hook( mixed $event ): string {
		return \is_object( $event ) && isset( $event->hook ) && \is_string( $event->hook ) ? $event->hook : '';
	}

	/** Describe callbacks registered on a WordPress hook without dumping payload data. */
	private static function describe_hook_callbacks( string $hook_name ): string {
		global $wp_filter;

		if ( ! \is_array( $wp_filter ) || empty( $wp_filter[ $hook_name ] ) ) {
			return 'none';
		}

		$hook_obj = $wp_filter[ $hook_name ];
		if ( ! \is_object( $hook_obj ) || ! isset( $hook_obj->callbacks ) || ! \is_array( $hook_obj->callbacks ) ) {
			return 'uninspectable';
		}
		$callbacks = $hook_obj->callbacks;

		$names = [];
		foreach ( $callbacks as $priority => $priority_callbacks ) {
			if ( ! \is_array( $priority_callbacks ) ) {
				continue;
			}
			foreach ( $priority_callbacks as $callback ) {
				$function = \is_array( $callback ) && isset( $callback['function'] ) ? $callback['function'] : $callback;
				$names[]  = "{$priority} " . self::describe_callback( $function );
			}
		}

		return empty( $names ) ? 'none' : \implode( ', ', $names );
	}

	/** Return a compact callback name suitable for error logs. */
	private static function describe_callback( mixed $function ): string {
		if ( \is_string( $function ) ) {
			return $function;
		}
		if ( \is_array( $function ) && 2 === \count( $function ) ) {
			$class  = \is_object( $function[0] ) ? self::describe_class_name( \get_class( $function[0] ) ) : ( \is_string( $function[0] ) ? self::describe_class_name( $function[0] ) : '{unknown}' );
			$method = Core::str( $function[1], '{unknown}' );
			return "{$class}::{$method}";
		}
		if ( $function instanceof \Closure ) {
			$ref  = new \ReflectionFunction( $function );
			$file = $ref->getFileName();
			$line = $ref->getStartLine();
			return $file ? '{closure}:' . \basename( $file ) . ":{$line}" : '{closure}';
		}
		if ( \is_object( $function ) ) {
			return self::describe_class_name( \get_class( $function ) ) . '::__invoke';
		}
		return '{unknown}';
	}

	/** Collapse anonymous class names because PHP includes source file metadata in them. */
	private static function describe_class_name( string $class ): string {
		return \str_contains( $class, 'class@anonymous' ) ? '{anonymous}' : $class;
	}

	/**
	 * Late schedule_event diagnostic for supervisor cron vetoes.
	 *
	 * @param mixed $event Event object or falsy veto value after earlier callbacks.
	 * @return mixed $event, unchanged.
	 */
	public static function log_supervisor_schedule_event_veto( $event ) {
		if ( $event ) {
			self::$schedule_event_context_is_supervisor = false;
			return $event;
		}
		if ( ! self::$schedule_event_context_is_supervisor ) {
			return $event;
		}
		self::$schedule_event_context_is_supervisor = false;

		$filter = (string) \current_filter();
		Core::print_less_often(
			'supervisor cron vetoed: ',
			\sprintf(
				'filter=%s value=falsy callbacks=[%s]',
				$filter,
				self::describe_hook_callbacks( $filter )
			)
		);
		return $event;
	}

	/** Register substrate REST routes — wired to `rest_api_init`. */
	public static function register_rest_routes(): void {
		// Slot-pool seams here, not ensure_runtime_wired: SSE_Out is REST-only.
		SSE_Slot_Pool::wire();
		( new Spawn_Controller( self::supervisor() ) )->register_routes();
		( new SSE_Out_Node() )->register_routes();
		( new Log_Stream_Out_Node() )->register_routes();
		( new HTTP_In_Node() )->register_routes();
	}

	/**
	 * Remember the schedule_event context before later callbacks can replace the
	 * event object with a falsy veto value.
	 *
	 * @param mixed $event Event object being filtered.
	 * @return mixed $event, unchanged.
	 */
	public static function remember_schedule_event_context( $event ) {
		self::$schedule_event_context_is_supervisor = 'newspack_nodes/supervisor' === self::event_hook( $event );
		return $event;
	}

	/**
	 * Register the substrate's ONE `direct` Site Health test. Direct (not async):
	 * the check is a handful of filemtime/glob reads, no HTTP.
	 *
	 * @param array<string,mixed> $tests WP Site Health tests (`direct`/`async` buckets).
	 * @return array<string,mixed>
	 */
	public static function register_site_health_tests( array $tests ): array {
		if ( ! \is_array( $tests['direct'] ?? null ) ) {
			$tests['direct'] = [];
		}
		$tests['direct'][ self::SITE_HEALTH_TEST ] = [
			'label' => \__( 'Newspack Nodes fleet health', 'newspack-nodes' ),
			'test'  => [ self::class, 'run_workers_health_test' ],
		];
		return $tests;
	}

	/**
	 * Run the fleet Site Health test: map the Alerts evaluator's worst severity
	 * to a WP Site Health status (critical → critical, warning → recommended,
	 * none → good) and list every alert message in the description.
	 *
	 * @return array<string,mixed> WP Site Health result.
	 */
	public static function run_workers_health_test(): array {
		$alerts = Alerts::evaluate();
		$worst  = Alerts::worst_severity( $alerts );
		$status = [
			Alerts::SEVERITY_CRITICAL => 'critical',
			Alerts::SEVERITY_WARNING  => 'recommended',
		][ $worst ] ?? 'good';

		if ( empty( $alerts ) ) {
			$description = '<p>' . \esc_html__( 'All workers are heartbeating, consumers are keeping up, and no messages are quarantined.', 'newspack-nodes' ) . '</p>';
			$label       = \__( 'Newspack Nodes fleet is healthy', 'newspack-nodes' );
		} else {
			$items = '';
			foreach ( $alerts as $alert ) {
				$items .= '<li>' . \esc_html( Core::as_string( $alert['message'] ?? '' ) ) . '</li>';
			}
			$description = '<ul>' . $items . '</ul>';
			$label       = \__( 'Newspack Nodes fleet has alerts', 'newspack-nodes' );
		}

		return [
			'label'       => $label,
			'status'      => $status,
			'badge'       => [
				'label' => \__( 'Newspack Nodes', 'newspack-nodes' ),
				'color' => [
					'good'        => 'blue',
					'recommended' => 'orange',
				][ $status ] ?? 'red',
			],
			'description' => $description,
			'test'        => self::SITE_HEALTH_TEST,
		];
	}

	/**
	 * Declare the substrate's own non-topology log producers (Job_Intake's
	 * jobintake.p<N>, the Alerts journal's alerts.p0) so Log_Cleaner never
	 * sweeps them on ELN-less installs.
	 *
	 * @param array<int, string> $producers Producers from prior contributors.
	 * @return array<int, string>
	 */
	public static function register_log_producers( array $producers ): array {
		return \array_values( \array_unique( \array_merge( $producers, [ Job_Intake::LOG_BASENAME, Alerts::LOG_BASENAME ] ) ) );
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
		$part = new Partition_Node();
		$part->name( $worker_id );
		// Patron + sink to in-scope interpreter (Rule 4 skips both if none).
		$ci = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( null !== $ci ) {
			$part->patron( $ci );
			$part->sink( $ci );
		}
		$part->arguments( Worker_Base::ipc_partition_args( $input_dir ) );
		return true;
	}

	/**
	 * Register a 60-second cron interval for the supervisor tick.
	 * Wired to the `cron_schedules` filter from the plugin file.
	 *
	 * @param array<string, mixed> $schedules Existing cron schedules.
	 * @return array<string, mixed>
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

	/** Deactivation hook: clear the supervisor cron. */
	public static function deactivate(): void {
		\wp_clear_scheduled_hook( 'newspack_nodes/supervisor' );
	}
}
