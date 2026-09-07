<?php
/**
 * The substrate's WordPress boundary.
 *
 * The lifecycle hooks land here — activation and deactivation, `admin_init`,
 * `rest_api_init`, `cron_schedules`, the minute reconcile event, the
 * schedule-veto diagnostics and Site Health — and so does every question about
 * the ACTIVE topology set: which workers exist, how many partitions each
 * carries, which directories they read and write.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

use Newspack_Nodes\Config_System\Restart_Planner;
use Newspack_Nodes\Rest\Auth_Controller;
use Newspack_Nodes\Rest\Health_Cache_Controller;
use Newspack_Nodes\Rest\HTTP_In_Node;
use Newspack_Nodes\Rest\Log_Stream_Out_Node;
use Newspack_Nodes\Rest\SSE_Out_Node;
use Newspack_Nodes\Rest\Spawn_Controller;

\defined( 'ABSPATH' ) || exit;

/**
 * WordPress-facing entry points, plus the derivations every caller makes from
 * the active topology set.
 *
 * Every member is static because WordPress reaches all of them as callbacks —
 * an activation hook, a cron action, filters — with nowhere to hold an
 * instance.
 *
 * Wiring comes in two lazy, idempotent tiers. `ensure_diagnostics_wired()`
 * touches no runtime storage, so Site Health and the cache probe still answer
 * on a misconfigured base directory; `ensure_runtime_wired()` resolves that
 * base and throws when it is unusable. Cron, REST and admin entry points
 * report that refusal once and return rather than let it escape.
 *
 * @phpstan-import-type HealthResult from Health_Checks
 *
 * @phpstan-type Worker_Descriptor array{type: string, partition: int, topology: mixed, stale_timeout: mixed, on_demand_idle: int}
 */
class Bootstrap {

	/** Site Health test id (also the `test` field WP echoes back on the result). */
	public const SITE_HEALTH_TEST = 'newspack_nodes_fleet';

	/** The reconciliation pass's WP-Cron hook — one literal, many call sites. */
	public const CRON_EVENT = 'newspack_nodes/reconcile';

	/** Its recurrence, registered on `cron_schedules`. */
	public const CRON_SCHEDULE = 'newspack_nodes_minute';

	/**
	 * Health-report seam. Lazily-defaulted to a closure calling
	 * `Health_Checks::evaluate()`. Tests reassign it to a fixed result list so
	 * the Site Health rendering — status roll-up, per-result markers, badge
	 * color — runs as real production code rather than being mocked away.
	 *
	 * Signature: `function (): list<HealthResult>`.
	 *
	 * @var (\Closure(): list<HealthResult>)|null
	 */
	public static ?\Closure $health_report_evaluator = null;

	/**
	 * `\Memcached`-construction seam. Lazily-defaulted to a closure that builds
	 * the real handle. Tests reassign it to an in-memory double so the
	 * `host:port` parsing and the empty-server-list null run as real production
	 * code rather than being mocked away.
	 *
	 * Signature: `function (): \Memcached`.
	 *
	 * @var (\Closure(): \Memcached)|null
	 */
	public static ?\Closure $memcached_factory = null;

	/**
	 * Fleet enable/disable test seam. Production leaves this null (enabled) —
	 * the fleet has no production off-switch (no config field, no caller).
	 * Tests set false to exercise the disabled path.
	 *
	 * @var bool|null
	 */
	public static ?bool $fleet_enabled_override = null;

	/**
	 * Spawn-coordinator construction seam. Lazily-defaulted to a closure
	 * building the real one against the configured base dir. Tests reassign to
	 * bind a coordinator to a temp dir without moving the whole runtime.
	 *
	 * Signature: `function (): Spawn_Coordinator`.
	 *
	 * @var (\Closure(): Spawn_Coordinator)|null
	 */
	public static ?\Closure $spawn_coordinator_factory = null;

	/** Guards ensure_runtime_wired() so repeat entry-point calls in one request are no-ops. */
	private static bool $runtime_wired = false;

	/** Guards ensure_diagnostics_wired() so admin + runtime entry points cannot duplicate its filter. */
	private static bool $diagnostics_wired = false;

	/** Tracks the event entering schedule_event so a late falsy veto still has context. */
	private static bool $schedule_event_context_is_reconcile = false;

	/** @var array<string,list<array<array-key,mixed>>>|null Request-static half of the wake map. */
	private static ?array $on_demand_wake_map = null;

	/** Wake-map key prefix; the active set's digest completes it and `Cache_Backend` scopes it. Rows carry offsetlog_dir. */
	private const ON_DEMAND_WAKE_KEY = 'on_demand_wake_v2:';

	/** Seconds a wake map survives an edited `.tsl`; a changed active set keys elsewhere. */
	private const ON_DEMAND_WAKE_TTL_S = 60;

	/**
	 * Resolved partition directory => the on-demand workers that TAIL it.
	 *
	 * The answer to "did this write land somewhere an absent worker is waiting
	 * on", keyed by the concrete path so a writer needs no idea what it wrote.
	 *
	 * Built by SUBSTITUTION, never by parsing: each Consumer source template is
	 * resolved through `Core::resolve_partition_template()` for that worker's
	 * partition — the one place `<partition>` is expanded — so a template that
	 * puts the token anywhere but a `.p<N>` suffix still resolves. A partition
	 * nothing tails is simply absent from the map, which is why no exclusion
	 * rule is needed for offsetlogs, deadletter dirs or scratch.
	 *
	 * Cached in APCu (`local_first`, memcached only as its fallback) because the
	 * derivation globs the user dir and every stock dir and parses every `.tsl`,
	 * while the askers sit on request paths. Host-LOCAL is the correct tier: the
	 * inputs are TSL files on disk, which differ per host. The key carries the
	 * active set, so activation cannot serve a stale answer. Every other input
	 * rides the TTL alone — an edited `.tsl`, the global `num_partitions`, the
	 * fleet-wide `on_demand_idle` — and a stale miss costs one cron-cadence wake.
	 *
	 * @return array<string,list<array<array-key,mixed>>>
	 */
	public static function on_demand_wake_map(): array {
		if ( null !== self::$on_demand_wake_map ) {
			return self::$on_demand_wake_map;
		}
		// The raw CONFIG: building the key must not cost the walk it avoids.
		$cache = Cache_Backend::local_first();
		$key   = Cache_Backend::site_key( self::ON_DEMAND_WAKE_KEY . \md5( (string) \wp_json_encode( Config::value( 'topologies' ) ) ) );
		if ( null !== $cache ) {
			$hit = $cache->get( $key );
			if ( \is_array( $hit ) ) {
				return self::$on_demand_wake_map = self::sanitize_wake_map( $hit );
			}
		}
		$map = [];
		foreach ( self::expand_workers() as $worker ) {
			if ( 0 === self::on_demand_idle_of( $worker ) ) {
				continue;
			}
			$partition = Core::as_int( $worker['partition'] );
			$topology  = Core::as_string( $worker['topology'] );
			foreach ( Topology_Analyzer::consumer_positions( $topology ) as $position ) {
				$dir      = \rtrim( Core::resolve_partition_template( $position['source'], $partition, $topology ), '/' );
				$cursor   = '' === $position['offsetlog']
					? ''
					: \rtrim( Core::resolve_partition_template( $position['offsetlog'], $partition, $topology ), '/' );
				// Paired here so the backlog sweep never re-walks the graph.
				$map[ $dir ][] = $worker + [ 'offsetlog_dir' => $cursor ];
			}
		}
		$cache?->set( $key, $map, self::ON_DEMAND_WAKE_TTL_S );
		return self::$on_demand_wake_map = $map;
	}

	/**
	 * Expand topologies to flat worker descriptors, one per partition (count clamped to MAX_PARTITIONS).
	 *
	 * @return array<int,Worker_Descriptor>
	 */
	public static function expand_workers(): array {
		$topologies = self::get_topologies();
		$workers    = [];
		foreach ( $topologies as $type => $config ) {
			$config = Core::arr( $config );
			$count  = self::partitions_of( $config );
			for ( $p = 0; $p < $count; ++$p ) {
				$workers[] = [
					'type'           => $type,
					'partition'      => $p,
					'topology'       => $config['topology'] ?? '',
					'stale_timeout'  => Lock_Node::stale_timeout_of( $config ),
					'on_demand_idle' => self::on_demand_idle_of( $config ),
				];
			}
		}
		return $workers;
	}

	/**
	 * Seconds a worker stays idle before exiting; 0 means it stays resident.
	 *
	 * The window IS the flag — declaring one opts a topology in — so a descriptor
	 * declaring none falls to $default, and that default is 0 unless the operator
	 * set a fleet-wide window. Reading absence as nonzero would scale to zero a
	 * topology that never opted in.
	 *
	 * @param array<array-key,mixed> $descriptor Topology entry or worker descriptor.
	 * @param int                    $default    Fleet-wide window when the descriptor declares none.
	 */
	public static function on_demand_idle_of( array $descriptor, int $default = 0 ): int {
		return \max( 0, Core::num_int( $descriptor['on_demand_idle'] ?? null, $default ) );
	}

	/**
	 * A cache entry is untrusted shape; keep only `dir => list<descriptor>`.
	 *
	 * @param array<array-key,mixed> $raw Decoded cache value.
	 * @return array<string,list<array<array-key,mixed>>>
	 */
	private static function sanitize_wake_map( array $raw ): array {
		$map = [];
		foreach ( $raw as $dir => $rows ) {
			if ( ! \is_string( $dir ) || ! \is_array( $rows ) ) {
				continue;
			}
			foreach ( $rows as $row ) {
				if ( \is_array( $row ) ) {
					$map[ $dir ][] = $row;
				}
			}
		}
		return $map;
	}

	/**
	 * The stale threshold one topology declares, or the default.
	 *
	 * Every consumer that starts from a TYPE rather than a descriptor reads it
	 * here: `CLI::ls_workers()` behind `wp nodes status`, and the render lease
	 * nuclear-gyrobase hands its Perl child. A consumer that judges staleness
	 * for itself falls back to the flat default, calling a worker on a topology
	 * that raised its threshold dead while the peer scan correctly leaves it
	 * running. One heartbeat, one threshold.
	 *
	 * @param string $type The topology name.
	 * @return int Seconds.
	 * @throws \RuntimeException When the runtime base directory is unusable.
	 */
	public static function stale_timeout_for( string $type ): int {
		$topologies = self::get_topologies();
		if ( ! isset( $topologies[ $type ] ) ) {
			return Lock_Node::STALE_TIMEOUT;
		}
		return Lock_Node::stale_timeout_of( Core::arr( $topologies[ $type ] ) );
	}

	/** Self-heal (admin_init): re-arm the reconcile cron if it should run but isn't scheduled. */
	public static function self_heal_reconcile_cron(): void {
		if ( ! self::is_fleet_enabled() ) {
			return;
		}
		if ( ! self::runtime_base_is_available() ) {
			return;
		}
		if ( empty( self::get_topologies() ) ) {
			return;
		}
		if ( \wp_next_scheduled( self::CRON_EVENT ) ) {
			return;
		}
		self::activate();
	}

	/**
	 * Schedule the reconcile cron at minute cadence — the activation hook, and
	 * the self-heal re-arm. The `true` fifth argument asks `wp_schedule_event()`
	 * for a WP_Error, so a refused schedule reports its own code and message
	 * rather than a bare false.
	 */
	public static function activate(): void {
		if ( ! \wp_next_scheduled( self::CRON_EVENT ) ) {
			$result = \wp_schedule_event( \time() + 5, self::CRON_SCHEDULE, self::CRON_EVENT, [], true );
			if ( \is_wp_error( $result ) ) {
				Core::print_less_often(
					'reconcile cron schedule failed: ',
					\sprintf(
						'code=%s message=%s schedule=' . self::CRON_SCHEDULE,
						$result->get_error_code(),
						$result->get_error_message()
					)
				);
			}
		}
	}

	/**
	 * Concrete dirs the Partition/Topic node `$node` writes across every ACTIVE
	 * topology, indexed by partition. The union: two topologies declaring the
	 * same node at different worker counts each contribute their own.
	 *
	 * This is how a READER finds a resource's partitions. The global
	 * `num_partitions` is not that number — a topology carries its own count,
	 * and a Topic re-partitions above it — so a reader that loops to the global
	 * silently sees only the low partitions.
	 *
	 * @api Called from consumer plugins (cross-repo, invisible here).
	 *
	 * @param string $node Node name as its topology declares it.
	 * @return array<int,string> Partition index => directory.
	 * @throws \RuntimeException When the base directory is unusable, or a topology declares an unknown include, a cycle, or a conflicting make_node.
	 */
	public static function node_dirs( string $node ): array {
		$dirs = [];
		foreach ( \array_keys( self::get_topologies() ) as $name ) {
			foreach ( Topology_Analyzer::resolved_node_dirs( $name, $node, self::num_partitions_for( $name ) ) as $p => $dir ) {
				$dirs[ $p ] ??= $dir;
			}
		}
		\ksort( $dirs );
		return $dirs;
	}

	/**
	 * Worker indices running `$node`, across every ACTIVE topology that declares
	 * it. For per-partition state that never lands on disk — a memcache stats
	 * store keyed by the worker index — where node_dirs() has nothing to expand.
	 *
	 * @api Called from consumer plugins (cross-repo, invisible here).
	 *
	 * @param string $node Node name as its topology declares it.
	 * @return list<int> Partition indices, ascending.
	 * @throws \RuntimeException When the base directory is unusable, or a topology declares an unknown include, a cycle, or a conflicting make_node.
	 */
	public static function node_partitions( string $node ): array {
		$seen = [];
		foreach ( \array_keys( self::get_topologies() ) as $name ) {
			if ( ! Topology_Analyzer::declares_node( $name, $node ) ) {
				continue;
			}
			for ( $p = 0; $p < self::num_partitions_for( $name ); $p++ ) {
				$seen[ $p ] = true;
			}
		}
		$out = \array_keys( $seen );
		\sort( $out );
		return $out;
	}

	/**
	 * Active topology set: the `newspack_nodes/topologies` catalog narrowed to
	 * the names the `topologies` config key selects.
	 *
	 * Anything but a list of names — the empty default included — activates
	 * nothing, so an install spawns no workers until an operator opts one in. A
	 * selected name the catalog does not carry is synthesized from its `.tsl`
	 * frontmatter, and dropped only when no `.tsl` resolves, so a topology
	 * registered after the catalog is published still spawns.
	 *
	 * @return array<string,mixed> Topology name => entry (keys are always non-empty strings).
	 */
	public static function get_topologies(): array {
		$catalog = self::get_topology_catalog();
		// Active set = `topologies` config key; empty default spawns nothing.
		$active_names = Config::value( 'topologies' );
		if ( ! \is_array( $active_names ) ) {
			$active_names = [];
		}
		$default_np   = self::global_num_partitions();
		$default_idle = self::config_on_demand_idle();
		$active       = [];
		foreach ( $active_names as $name ) {
			if ( ! \is_string( $name ) || '' === $name ) {
				continue;
			}
			if ( isset( $catalog[ $name ] ) ) {
				$active[ $name ] = $catalog[ $name ];
				continue;
			}
			$synthesized = Topology_Registry::synthesize_entry( $name, $default_np, Lock_Node::STALE_TIMEOUT, $default_idle );
			if ( null !== $synthesized ) {
				$active[ $name ] = $synthesized;
			}
		}
		return $active;
	}

	/**
	 * A Vault mutation re-credentials the spokes, so every worker holding a
	 * vault-consuming node must RE-READ them rather than serve stale credentials
	 * for the rest of its ~10-minute lifetime. The reload channel, never the
	 * restart one: a credential change must not cost a process recycle.
	 *
	 * Which topologies those are is DERIVED from each active topology's parsed
	 * graph, never a topology name — names are deployment config (renamable,
	 * user-dir-shadowable) and a name-keyed signal drifts silently into a no-op.
	 * `Remote_Source` IS-A `Remote_Link`, so the second declaration is redundant
	 * and stays declared in case that stops being true.
	 *
	 * Best-effort: a Vault save never fails on the signal it triggers.
	 */
	public static function reload_vault_consumers(): void {
		if ( ! self::fleet_site() ) {
			return; // Subsite: the fleet is network-global and runs on the main site.
		}
		try {
			$coordinator = self::spawn_coordinator();
			foreach ( Restart_Planner::topologies_for( [ 'Remote_Link', 'Remote_Source' ] ) as $name ) {
				$count = self::num_partitions_for( $name );
				for ( $p = 0; $p < $count; $p++ ) {
					Lock_Node::request_reload_at( $coordinator->lock_path( $name, $p ) );
				}
			}
		} catch ( \Throwable $e ) {
			Core::print_less_often( 'vault reload failed: ', $e->getMessage() );
		}
	}

	/**
	 * Canonical partition count for a topology: the catalog entry's count, else
	 * the TSL frontmatter (`var num_partitions`), else the global default. Runs
	 * through the same `partitions_of()` derivation `expand_workers()` uses, so
	 * the count the Path menu shows can never disagree with what the fleet
	 * SPAWNS. Every reader comes here — the admin localizer, the
	 * `topologies.list` verb, the retention sweep, the restart planner.
	 *
	 * @param string $name Topology name.
	 * @return int Partition count in [1, MAX_PARTITIONS].
	 */
	public static function num_partitions_for( string $name ): int {
		$entry = self::get_topology_catalog()[ $name ] ?? null;
		if ( ! \is_array( $entry ) || ! isset( $entry['num_partitions'] ) ) {
			$entry = Topology_Registry::synthesize_entry(
				$name,
				self::global_num_partitions(),
				Lock_Node::STALE_TIMEOUT,
				self::config_on_demand_idle()
			);
		}
		return self::partitions_of( \is_array( $entry ) ? $entry : [] );
	}

	/**
	 * One topology entry's partition count: its own `num_partitions`, else the
	 * global default. THE per-topology derivation — `expand_workers()` (what the
	 * fleet spawns) and `num_partitions_for()` (what every reader asks) both
	 * route through it, so a catalog entry that omits the key cannot spawn 1
	 * while every reader sees N.
	 *
	 * @param array<array-key,mixed> $entry Topology catalog entry or worker descriptor.
	 * @return int Partition count in [1, MAX_PARTITIONS].
	 */
	private static function partitions_of( array $entry ): int {
		return self::clamp_partitions( $entry['num_partitions'] ?? null, self::global_num_partitions() );
	}

	/**
	 * The global `num_partitions` option, clamped to the range a worker will
	 * actually consume: `[1, Spawn_Coordinator::MAX_PARTITIONS]`.
	 *
	 * THE accessor for that option, so no producer spells the clamp its own way
	 * or omits the upper bound. Unbounded, an option above the cap has
	 * `Job_Intake` / `Log_Manager` writing `firehose.p16`+ that no worker
	 * consumes and `Log_Cleaner` sweeping as orphans — live-data deletion past
	 * both of the GC's fail-closed gates. Writing beyond the cap is never right:
	 * `partitions_of()` bounds the workers by the same constant, so a partition
	 * past it has no reader.
	 *
	 * @return int The clamped partition count.
	 */
	public static function global_num_partitions(): int {
		return self::clamp_partitions( Config::value( 'num_partitions' ) );
	}

	/**
	 * Clamp a raw partition count into `[1, Spawn_Coordinator::MAX_PARTITIONS]`.
	 * Validated numeric read, so junk (`'9abc'`, `true`, `''`) takes $default
	 * rather than the lenient cast's leading digits.
	 *
	 * @param mixed $raw     Declared count, from an option or TSL frontmatter.
	 * @param int   $default Count to use when $raw declares nothing numeric.
	 */
	private static function clamp_partitions( mixed $raw, int $default = 1 ): int {
		return \min( Spawn_Coordinator::MAX_PARTITIONS, \max( 1, Core::num_int( $raw, $default ) ) );
	}

	/** The operator's fleet-wide idle window; every synthesize_entry caller injects it. */
	public static function config_on_demand_idle(): int {
		return \max( 0, Core::num_int( Config::value( 'on_demand_idle' ), 0 ) );
	}

	/**
	 * Full topology catalog as the `newspack_nodes/topologies` filter publishes
	 * it, before the `topologies` config key narrows it to the active set.
	 *
	 * Wires the runtime first because `ensure_runtime_wired()` is where the user
	 * topology dir is registered, and a catalog built ahead of it misses every
	 * user `.tsl`.
	 *
	 * @return array<array-key,mixed> Topology name => entry.
	 * @throws \RuntimeException When the runtime base directory is unusable.
	 */
	public static function get_topology_catalog(): array {
		self::ensure_runtime_wired();
		return (array) \apply_filters( 'newspack_nodes/topologies', [] );
	}

	/**
	 * The minute-cadence reconciliation pass: revive whatever is down, then keep
	 * house. This is the cold-start tier of ADR-9 — every live worker runs the
	 * same peer scan on its own timer, so the spawn step decides anything only
	 * when none is left, which is why this holds no lock and enters no loop of
	 * its own.
	 *
	 * The four housekeeping chores tolerate minutes of latency (`Log_Cleaner`'s
	 * delete grace alone is an hour), and running them here rather than as a job
	 * on the `job-worker` pool is the point: retention and orphan reaping run
	 * even when the fleet is down, which is when disk most needs reclaiming.
	 *
	 * `$_SERVER['NEWSPACK_NODES_WORKER_TYPE']` labels this pass `reconcile` — the
	 * dimension newspack-event-logger-nodes files its stats under. Nothing compares
	 * against the literal; it is a label, not a worker type.
	 */
	public static function reconcile_fleet(): void {
		if ( ! self::fleet_site() ) {
			return; // Subsite: the fleet is network-global and runs on the main site.
		}
		// @longform Wiring resolves the base and throws when it is unusable.
		// This is a cron callback and the last revival path once no worker is
		// alive, so it reports once and returns, as the REST and self-heal
		// entry points do.
		if ( ! self::runtime_base_is_available() ) {
			return;
		}
		self::ensure_runtime_wired();
		if ( ! self::is_fleet_enabled() ) {
			self::unschedule_reconcile();
			return;
		}
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$_SERVER['NEWSPACK_NODES_WORKER_TYPE']      = 'reconcile';
		$_SERVER['NEWSPACK_NODES_WORKER_PARTITION'] = '0';
		try {
			self::run_reconcile_steps();
		} catch ( \Throwable $e ) {
			// An escape would fatal this cron callback sixty times an hour.
			Core::print_less_often( 'reconcile pass failed: ', $e->getMessage() );
		} finally {
			\do_action( 'newspack_nodes/after_reconcile' );
		}
	}

	/**
	 * Spawn ahead of the janitorial steps — it is the revival path and the only
	 * time-critical one, so housekeeping may never preempt it by throwing. Every
	 * step then stands alone, because each one runs third-party code:
	 * `expand_workers()` fires the `topologies` filter, and `periodic` is
	 * whatever subscribed. One bad provider must not cost the others their
	 * window.
	 */
	private static function run_reconcile_steps(): void {
		// @longform Third-party surface, so it gets its own step: fired bare,
		// a throw escapes the callback and skips the spawn behind it.
		self::reconcile_step( 'before', static fn() => \do_action( 'newspack_nodes/before_reconcile' ) );
		$coordinator = self::spawn_coordinator();
		$base_dir    = self::base_dir();
		self::reconcile_step( 'spawn', static fn() => $coordinator->spawn_due_workers( Core::right_now() ) );
		// Revival too: the only pass that notices an external producer's write.
		self::reconcile_step( 'backlog-wake', static fn() => $coordinator->wake_readers_with_backlog( Core::right_now() ) );
		self::reconcile_step( 'lock-dirs', static fn() => $coordinator->reconcile_lock_dirs() );
		self::reconcile_step( 'retention', static fn() => Log_Cleaner::cleanup_orphan_partitions( $base_dir ) );
		self::reconcile_step( 'orphan-ipc', static fn() => $coordinator->cleanup_orphan_ipc() );
		self::reconcile_step( 'periodic', static fn() => \do_action( 'newspack_nodes/periodic' ) );
	}

	/**
	 * Run one reconciliation step, reporting rather than propagating. No
	 * `Worker_Should_Stop` carve-out (ADR-14): this is a cron request, not a
	 * worker drain loop, so there is no worker for a cooperative stop to reach
	 * and letting one escape would only fatal the callback.
	 *
	 * @param string   $label Step name, for the failure report.
	 * @param callable $work  The step.
	 */
	private static function reconcile_step( string $label, callable $work ): void {
		try {
			$work();
		} catch ( \Throwable $e ) {
			Core::print_less_often( "reconcile step '{$label}' failed: ", $e->getMessage() );
		}
	}

	/** Unschedule the reconcile cron event. */
	public static function unschedule_reconcile(): void {
		if ( ! \function_exists( 'wp_next_scheduled' ) || ! \function_exists( 'wp_unschedule_event' ) ) {
			return;
		}
		$next = \wp_next_scheduled( self::CRON_EVENT );
		if ( $next ) {
			\wp_unschedule_event( $next, self::CRON_EVENT );
		}
	}

	/** Fleet enable gate (default true); false unschedules the cron, blocks the self-heal re-arm and stops the peer scan. */
	public static function is_fleet_enabled(): bool {
		return self::$fleet_enabled_override ?? true;
	}

	/**
	 * Veto-time diagnostic for the reconcile cron, registered on
	 * `pre_schedule_event` AND `pre_reschedule_event` at PHP_INT_MAX - 2. When an
	 * earlier callback short-circuits OUR event with false or a WP_Error, log the
	 * active filter chain — the culprit is in it by definition. These filters run
	 * inside `wp_schedule_event()` and `wp_reschedule_event()`, which every cron
	 * runner calls, unlike `cron_reschedule_event_error` and
	 * `cron_unschedule_event_error`, which only `wp-cron.php` fires.
	 *
	 * @param mixed $pre   Short-circuit value accumulated by earlier callbacks.
	 * @param mixed $event Event object (hook, timestamp, schedule, args, interval).
	 * @return mixed $pre, unchanged.
	 */
	public static function log_reconcile_schedule_veto( $pre, $event ) {
		$hook = self::event_hook( $event );
		if ( self::CRON_EVENT !== $hook ) {
			return $pre;
		}
		// null = nobody intervened; truthy non-error = another runner took it.
		if ( false !== $pre && ! \is_wp_error( $pre ) ) {
			return $pre;
		}

		$filter = (string) \current_filter();
		$reason = \is_wp_error( $pre ) ? $pre->get_error_code() . ': ' . $pre->get_error_message() : 'false';
		Core::print_less_often(
			'reconcile cron vetoed: ',
			\sprintf(
				'filter=%s value=%s callbacks=[%s]',
				$filter,
				$reason,
				self::describe_hook_callbacks( $filter )
			)
		);
		return $pre;
	}

	/**
	 * Late `schedule_event` diagnostic for reconcile cron vetoes. A veto here
	 * replaces the event object with a falsy value, taking the hook name with it,
	 * so the identity comes from the context `remember_schedule_event_context()`
	 * stored at the head of the same filter.
	 *
	 * @param mixed $event Event object, or the falsy veto earlier callbacks left.
	 * @return mixed $event, unchanged.
	 */
	public static function log_reconcile_schedule_event_veto( $event ) {
		if ( $event ) {
			self::$schedule_event_context_is_reconcile = false;
			return $event;
		}
		if ( ! self::$schedule_event_context_is_reconcile ) {
			return $event;
		}
		self::$schedule_event_context_is_reconcile = false;

		$filter = (string) \current_filter();
		Core::print_less_often(
			'reconcile cron vetoed: ',
			\sprintf(
				'filter=%s value=falsy callbacks=[%s]',
				$filter,
				self::describe_hook_callbacks( $filter )
			)
		);
		return $event;
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

	/** Register substrate REST routes — wired to `rest_api_init`. */
	public static function register_rest_routes(): void {
		// The cache probe first: REST init must complete on a refused base.
		( new Health_Cache_Controller( \wp_salt( 'nonce' ) ) )->register_routes();
		self::ensure_diagnostics_wired();
		if ( ! self::runtime_base_is_available() ) {
			return;
		}
		self::ensure_runtime_wired();

		// Slot-pool seams here, not ensure_runtime_wired: SSE_Out is REST-only.
		SSE_Slot_Pool::wire();
		( new Spawn_Controller( self::spawn_coordinator() ) )->register_routes();
		( new Auth_Controller() )->register_routes();
		( new SSE_Out_Node() )->register_routes();
		( new Log_Stream_Out_Node() )->register_routes();
		( new HTTP_In_Node() )->register_routes();
	}

	/**
	 * The request-scope spawn coordinator (factory seam for tests).
	 *
	 * @throws \RuntimeException When the default factory cannot resolve the base directory.
	 */
	public static function spawn_coordinator(): Spawn_Coordinator {
		$factory = self::$spawn_coordinator_factory ?? static fn (): Spawn_Coordinator => new Spawn_Coordinator( self::base_dir() );
		return $factory();
	}

	/**
	 * Wire the substrate runtime: the node-class namespaces `make_node` resolves
	 * against, the `<config:…>` token namespace, the user topology directory,
	 * the substrate's own log-producer and segment-size filters, its
	 * `newspack_nodes/periodic` and `newspack_nodes/vault/changed` subscribers,
	 * and the self-respawn token provider.
	 *
	 * Idempotent and lazy — diagnostic entry points wire only their non-storage
	 * dependencies, while node-graph/storage entry points call this method and
	 * still fail loudly on an unusable base. A plain frontend page view touches
	 * neither tier.
	 *
	 * The flag is set LAST, as in ensure_diagnostics_wired(): base_dir() throws
	 * on an unusable base and Fleet_Node swallows that, so flagging first would
	 * leave a worker half-wired for its whole life with no second chance. Every
	 * step is idempotent, which is what makes the retry safe.
	 *
	 * @throws \RuntimeException When the runtime base directory is unusable.
	 */
	public static function ensure_runtime_wired(): void {
		self::ensure_diagnostics_wired();
		if ( self::$runtime_wired ) {
			return;
		}
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\' );
		Command_Interpreter_Node::register_namespace( 'Newspack_Nodes\\Rest\\' );
		Config::register_token_namespace();
		Topology_Registry::register_user_dir( Bootstrap::base_dir() . '/topologies' );
		\add_filter( 'newspack_nodes/registered_log_producers', [ self::class, 'register_log_producers' ] );
		// Geometry the static TSL scan cannot see (Job_Intake builds its own).
		\add_filter( 'newspack_nodes/segment_size_overrides', [ self::class, 'register_segment_sizes' ] );
		// Self-respawn tokens must be minted at POST time, not worker boot.
		Worker_Base::$token_provider ??= static fn (): string => self::spawn_coordinator()->generate_spawn_token( \time() );
		// Fleet alerting: journal alert transitions into alerts.p0.
		\add_action( 'newspack_nodes/periodic', [ Alerts::class, 'emit' ] );
		// Delayed-jobs sweep: deliver due entries, circulate the rest.
		\add_action( 'newspack_nodes/periodic', [ Job_Delay::class, 'sweep_action' ] );
		// A re-credentialed or removed spoke invalidates its command session.
		\add_action( 'newspack_nodes/vault/changed', [ self::class, 'forget_command_session' ] );
		// ...and the workers holding its credentials must re-read them.
		\add_action( 'newspack_nodes/vault/changed', [ self::class, 'reload_vault_consumers' ] );
		// Footgun: don't wire SSE_Slot_Pool here; it autoloads SSE_Out_Node.
		self::$runtime_wired = true;
	}

	/**
	 * Register diagnostics that must remain available when runtime storage is
	 * misconfigured: the spawn TLS flag, the shared `\Memcached` handle the cache
	 * probe reports on, and the Site Health test. This path may read non-storage
	 * config, but must not resolve the base directory.
	 */
	public static function ensure_diagnostics_wired(): void {
		if ( self::$diagnostics_wired ) {
			return;
		}
		// Declared-but-unset must VERIFY; casting null is fail-open.
		Core::$verify_spawn_tls = (bool) ( Config::value( 'spawn_verify_ssl' ) ?? true );
		if ( \function_exists( 'get_option' ) ) {
			self::init_memcached();
		}
		\add_filter( 'site_status_tests', [ self::class, 'register_site_health_tests' ] );
		self::$diagnostics_wired = true;
	}

	/**
	 * Build the one shared `\Memcached` handle on `Core::$memd` from the
	 * substrate's own `memcache_servers` config. The substrate owns this —
	 * `Cache_Backend` selects that handle for every substrate surface that needs
	 * shared state (the command-auth nonce, the SSE slot pool, the spawn
	 * throttle) and must not depend on an application plugin to populate it.
	 *
	 * Empty/invalid server list sets `Core::$memd = null` — deliberately NOT a
	 * fallback handle. Null withdraws the memcached tier, leaving `Cache_Backend`
	 * on APCu; only when neither answers do the consumers reach their own fail
	 * paths, command-auth refusing an unverifiable single-use nonce and the SSE
	 * pool refusing a slot. A non-null but unreachable handle is worse than none:
	 * `shared_first()` prefers memcached, so every operation would fail against a
	 * dead server rather than fall through to APCu. No-op when the PECL
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

	/**
	 * Whether the configured runtime base can be resolved at a diagnostic
	 * lifecycle boundary. Only that expected refusal is converted; failures
	 * from the runtime wiring that follows still surface.
	 */
	private static function runtime_base_is_available(): bool {
		try {
			self::base_dir();
			return true;
		} catch ( \RuntimeException $e ) {
			Core::print_less_often( 'runtime wiring unavailable: ', $e->getMessage() );
			return false;
		}
	}

	/**
	 * Configured base directory for runtime state (locks/, ipc/, logs/,
	 * offsets/, topologies/).
	 *
	 * @return string Canonical, validated base path.
	 * @throws \RuntimeException When `base_directory` is empty or non-scalar, or the directory cannot be created, is a symlink, resolves outside its parent, or belongs to another uid.
	 */
	public static function base_dir(): string {
		return Config::get_base_directory();
	}

	/**
	 * REST gate for the routes that front the fleet: null to proceed, a 403
	 * WP_Error on a multisite subsite. One guard, so a new route cannot quietly
	 * omit the check.
	 *
	 * @return \WP_Error|null Null when this site runs the fleet.
	 */
	public static function fleet_gate(): ?\WP_Error {
		if ( self::fleet_site() ) {
			return null;
		}
		return new \WP_Error(
			'newspack_nodes_not_fleet_site',
			'multisite subsite: the fleet runs on the main site only',
			[ 'status' => 403 ]
		);
	}

	/**
	 * The fleet is network-global (locks/IPC/logs carry no blog namespace),
	 * so exactly one site runs it: single-site always, multisite main only.
	 */
	public static function fleet_site(): bool {
		return ! \function_exists( 'is_multisite' ) || ! \is_multisite() || \is_main_site();
	}

	/**
	 * Remember the schedule_event context before later callbacks can replace the
	 * event object with a falsy veto value.
	 *
	 * @param mixed $event Event object being filtered.
	 * @return mixed $event, unchanged.
	 */
	public static function remember_schedule_event_context( $event ) {
		self::$schedule_event_context_is_reconcile = self::CRON_EVENT === self::event_hook( $event );
		return $event;
	}

	/** Extract an event object's hook field, if present. */
	private static function event_hook( mixed $event ): string {
		return \is_object( $event ) && isset( $event->hook ) && \is_string( $event->hook ) ? $event->hook : '';
	}

	/**
	 * Build (idempotently) the request-scope graph EVERY command entry point
	 * needs — `_router` and `_command_interpreter` — and fire
	 * `newspack_nodes/request_graph_ready` so applications mount their service
	 * CIs onto it.
	 *
	 * Shared because `/command` is not the only door: an MCP request reaches the
	 * same verbs by another route, and a second copy of this construction
	 * sequence drifts until one door silently has no service CIs behind it.
	 *
	 * @return Command_Interpreter_Node The request-scope `_command_interpreter`.
	 */
	public static function mount_request_graph(): Command_Interpreter_Node {
		$router = Core::node( Node_Names::ROUTER );
		if ( ! $router instanceof Router_Node ) {
			$router = new Router_Node();
			$router->name( Node_Names::ROUTER );
		}
		$interpreter = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( ! $interpreter instanceof Command_Interpreter_Node ) {
			$interpreter = new Command_Interpreter_Node();
			$interpreter->name( Node_Names::COMMAND_INTERPRETER );
			$interpreter->sink( $router );
		}
		\do_action( 'newspack_nodes/request_graph_ready', $interpreter );
		return $interpreter;
	}

	/**
	 * Mount one worker's input Partition by reader id (format-validated,
	 * idempotent). A sleeping on-demand worker is woken first, and skips the
	 * input-dir check, because it creates that directory only once it runs.
	 *
	 * @param string $worker_id Reader id, `<type>.p<N>`; any other shape is refused.
	 * @param string $base_dir  Runtime base holding `locks/` and `ipc/`.
	 * @return bool True iff the partition is now mounted.
	 */
	public static function register_worker_partition( string $worker_id, string $base_dir ): bool {
		if ( ! \preg_match( '/^[a-z0-9_-]+\.p\d+$/', $worker_id ) ) {
			return false;
		}
		if ( Core::node( $worker_id ) instanceof Partition_Node ) {
			return true;
		}
		// A live worker holds a lock dir; a sleeping on-demand one holds none.
		$sleeping = false;
		if ( ! \is_dir( "{$base_dir}/locks/{$worker_id}.lock.d" ) ) {
			// Scoped to the caller's base_dir, not the request-scope seam's.
			$sleeping = ( new Spawn_Coordinator( $base_dir ) )->wake_sleeping_worker( $worker_id, Core::right_now() );
			if ( ! $sleeping ) {
				return false;
			}
		}
		$input_dir = "{$base_dir}/ipc/{$worker_id}/input";
		if ( ! $sleeping && ! \is_dir( $input_dir ) ) {
			return false;
		}
		$part = new Partition_Node();
		// patron() before name(): it refuses a node already named and wired.
		$ci = Core::node( Node_Names::COMMAND_INTERPRETER );
		if ( null !== $ci ) {
			$part->patron( $ci );
		}
		// Named between the two: sink() announces READY with the name.
		$part->name( $worker_id );
		if ( null !== $ci ) {
			$part->sink( $ci );
		}
		$part->arguments( Worker_Base::ipc_partition_args( $input_dir ) );
		return true;
	}

	/** Drop the request-static half of the wake map; `Topology_Registry::invalidate_config_cache()` calls it. */
	public static function forget_on_demand_readers(): void {
		self::$on_demand_wake_map = null;
	}

	/**
	 * A re-credentialed or removed spoke invalidates its command session; drop it
	 * so the next command re-auths instead of signing under a key the far side
	 * has forgotten.
	 *
	 * @param string $id Vault server id, from `newspack_nodes/vault/changed`.
	 */
	public static function forget_command_session( string $id ): void {
		Command_Auth::forget_session( $id );
	}

	/**
	 * Boot-time version handshake for consumer plugins. `Requires Plugins`
	 * guarantees the substrate is ACTIVE but says nothing about its version;
	 * without this a consumer built against a newer substrate fatals on a
	 * missing API mid-request. True when the loaded substrate satisfies $min;
	 * otherwise registers an admin notice naming the dependent plugin and both
	 * versions, and returns false so the consumer can stay dormant.
	 *
	 * @api Called from consumer plugins' deferred loaders (cross-repo, invisible here).
	 *
	 * @param string $min       Minimum substrate version the consumer needs.
	 * @param string $dependent Human-readable consumer plugin name for the notice.
	 */
	public static function version_at_least( string $min, string $dependent ): bool {
		if ( \version_compare( NEWSPACK_NODES_VERSION, $min, '>=' ) ) {
			return true;
		}
		\add_action( 'admin_notices', static function () use ( $min, $dependent ): void {
			\printf(
				'<div class="notice notice-error"><p>%s</p></div>',
				\esc_html( \sprintf(
					/* translators: 1: consumer plugin name, 2: required version, 3: installed version. */
					\__( '%1$s requires Newspack Nodes %2$s or newer (found %3$s) and is dormant until Newspack Nodes is updated.', 'newspack-nodes' ),
					$dependent,
					$min,
					NEWSPACK_NODES_VERSION
				) )
			);
		} );
		return false;
	}

	/**
	 * Register the substrate's ONE `direct` Site Health test. Direct (not async):
	 * the evaluator performs local cache/filesystem probes and fleet snapshot
	 * reads, not a loopback HTTP request.
	 *
	 * @param array<string,mixed> $tests WP Site Health tests (`direct`/`async` buckets).
	 * @return array<string,mixed>
	 */
	public static function register_site_health_tests( array $tests ): array {
		if ( ! \is_array( $tests['direct'] ?? null ) ) {
			$tests['direct'] = [];
		}
		$tests['direct'][ self::SITE_HEALTH_TEST ] = [
			'label' => \__( 'Newspack Nodes health', 'newspack-nodes' ),
			'test'  => [ self::class, 'run_workers_health_test' ],
		];
		return $tests;
	}

	/**
	 * Run the canonical health report once and render every result.
	 *
	 * @return array<string,mixed> WP Site Health result.
	 */
	public static function run_workers_health_test(): array {
		$evaluate = self::$health_report_evaluator ?? static fn (): array => Health_Checks::evaluate();
		$results  = $evaluate();
		$status   = Health_Checks::worst_status( $results );
		$items    = '';

		foreach ( $results as $result ) {
			$marker = match ( $result['status'] ) {
				Health_Checks::STATUS_GOOD => 'OK',
				Health_Checks::STATUS_RECOMMENDED => 'WARN',
				Health_Checks::STATUS_CRITICAL => 'FAIL',
			};
			$messages = '';
			foreach ( $result['messages'] as $message ) {
				$messages .= '<div>' . \esc_html( $message ) . '</div>';
			}
			$items .= '<li><strong>'
				. \esc_html( "{$marker} {$result['label']}" )
				. '</strong>'
				. $messages
				. '</li>';
		}

		return [
			'label'       => Health_Checks::STATUS_GOOD === $status
				? \__( 'Newspack Nodes is healthy', 'newspack-nodes' )
				: \__( 'Newspack Nodes has health alerts', 'newspack-nodes' ),
			'status'      => $status,
			'badge'       => [
				'label' => \__( 'Newspack Nodes', 'newspack-nodes' ),
				'color' => match ( $status ) {
					Health_Checks::STATUS_GOOD => 'blue',
					Health_Checks::STATUS_RECOMMENDED => 'orange',
					Health_Checks::STATUS_CRITICAL => 'red',
				},
			],
			'description' => '<ul>' . $items . '</ul>',
			'test'        => self::SITE_HEALTH_TEST,
		];
	}

	/**
	 * Declare the substrate's own non-topology log producers (Job_Intake's
	 * jobintake.p<N> + jobfeed.p<N> + jobdelay.p0, the Alerts journal's
	 * alerts.p0) so Log_Cleaner never sweeps them on ELN-less installs. Each
	 * producer states its own layout as a path template; the substrate does not
	 * spell one for it.
	 *
	 * @param array<int,string> $producers Producers from prior contributors.
	 * @return array<int,string>
	 */
	public static function register_log_producers( array $producers ): array {
		return \array_values( \array_unique( \array_merge(
			$producers,
			\array_values( Job_Intake::log_dir_templates() ),
			[ Alerts::log_dir_template() ]
		) ) );
	}

	/**
	 * Advertise the segment geometry of partitions built in PHP, which no TSL
	 * statement declares and the static scan therefore cannot see. Job_Intake's
	 * feed runs at FEED_SEGMENT_SIZE against Partition's 64 MiB default, so
	 * without the override a dashboard draws a full segment as a sliver.
	 *
	 * @param array<string,int> $overrides basename => segment size in bytes.
	 * @return array<string,int>
	 */
	public static function register_segment_sizes( array $overrides ): array {
		$overrides[ Job_Intake::FEED_BASENAME ] = Job_Intake::FEED_SEGMENT_SIZE;
		return $overrides;
	}

	/**
	 * Register a 60-second cron interval for the reconcile tick.
	 * Wired to the `cron_schedules` filter from the plugin file.
	 *
	 * @param array<string,mixed> $schedules Existing cron schedules.
	 * @return array<string,mixed>
	 */
	public static function register_cron_schedules( array $schedules ): array {
		if ( ! isset( $schedules[ self::CRON_SCHEDULE ] ) ) {
			$schedules[ self::CRON_SCHEDULE ] = [
				'interval' => 60,
				'display'  => 'Every Minute (Newspack Nodes)',
			];
		}
		return $schedules;
	}

	/** Deactivation hook: clear the reconcile cron. */
	public static function deactivate(): void {
		\wp_clear_scheduled_hook( self::CRON_EVENT );
	}
}
