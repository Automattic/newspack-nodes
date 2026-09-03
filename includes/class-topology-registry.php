<?php
/**
 * Topology name resolution, catalog publication and fleet activation.
 *
 * One registry answers three questions: which file a topology NAME resolves
 * to, which topologies the `newspack_nodes/topologies` catalog offers, and
 * what happens the moment an operator turns one on or off.
 *
 * Plugins register stock dirs, which OWN their names; the writable user dir
 * serves only names no stock dir provides, because a writable directory that
 * can shadow a stock topology is code execution. Stock dirs resolve newest
 * registration first, with the substrate's own bundled dir appended last, so
 * a consumer overrides a builtin topology by shipping a same-named `.tsl`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Static name-to-path registry for `.tsl` topologies, plus the activate,
 * deactivate and spawn primitives every surface shares.
 *
 * Static because registration happens at plugin load, before any graph exists,
 * and because the callers — a REST verb, a WP-CLI command, the spawn
 * endpoint's action — reach it from unrelated request scopes with no instance
 * to hand around.
 */
class Topology_Registry {

	/**
	 * Worker-spawn seam. Defaulted lazily at the call site to a closure that
	 * builds and executes the real `Worker_Base`, since a closure cannot be a
	 * constant expression. Tests reassign it in setUp to capture the spawn
	 * intent without forking a process, which leaves the active-set guard and
	 * the `expand_workers()` lookup running as real production code.
	 *
	 * It takes the whole `expand_workers()` descriptor rather than a parameter
	 * list, so a new frontmatter var reaches the worker without a signature
	 * change. Signature: `function ( array $descriptor ): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $spawn_runner = null;

	/** @var array<string,bool> The `prefix|dir` pairs register_plugin has wired. */
	private static array $registered_plugins = [];

	/** @var array<int,string> Stock dirs in resolution order; the first hit wins. */
	private static array $stock_dirs = [];

	/** @var string Writable per-deployment user dir; '' when none is registered. */
	private static string $user_dir = '';

	/**
	 * `newspack_nodes/topologies` catalog filter: synthesize an entry for every
	 * `.tsl` that `list()` finds, across the user dir and every registered stock
	 * dir, so the catalog reflects what exists on disk rather than a per-plugin
	 * allowlist. Registered once by the substrate (newspack-nodes.php).
	 *
	 * The fleet-wide defaults enter here and a topology's own frontmatter
	 * overrides each of them in `synthesize_entry()`: `num_partitions` and
	 * `on_demand_idle` from the operator-facing substrate options, read through
	 * the ONE accessor apiece that clamps them, and `stale_timeout` from
	 * `Lock_Node::STALE_TIMEOUT`.
	 *
	 * @param array<string,array<string,mixed>> $topologies Existing catalog (a prior contributor wins on key collision).
	 * @return array<string,array<string,mixed>>
	 */
	public static function publish_catalog( array $topologies ): array {
		$default_np   = \Newspack_Nodes\Bootstrap::global_num_partitions();
		$default_idle = \Newspack_Nodes\Bootstrap::config_on_demand_idle();
		foreach ( self::list() as $name ) {
			if ( isset( $topologies[ $name ] ) ) {
				continue;
			}
			$entry = self::synthesize_entry( $name, $default_np, Lock_Node::STALE_TIMEOUT, $default_idle );
			if ( null !== $entry ) {
				$topologies[ $name ] = $entry;
			}
		}
		return $topologies;
	}

	/**
	 * Build the `[topology, num_partitions, stale_timeout, on_demand_idle]`
	 * catalog entry from a topology's frontmatter; null when no `.tsl` resolves.
	 *
	 * Every field is read with the VALIDATED `Core::num_int`, matching what
	 * `Bootstrap` does with the same values: a lenient `(int)` cast turns
	 * `var num_partitions = "12abc"` into 12 here and into the default there.
	 *
	 * A `num_partitions` or `stale_timeout` declared zero or negative takes the
	 * caller's default too, because neither can run: zero partitions is no fleet
	 * at all, and a zero stale timeout makes every worker in the fleet read as
	 * instantly stale, which is continuous respawn churn. `on_demand_idle` is
	 * exempt — 0 is its meaningful "stay resident" value.
	 *
	 * @param string $name                   Topology name.
	 * @param int    $default_num_partitions Partitions when the frontmatter declares none usable.
	 * @param int    $default_stale_timeout  Heartbeat staleness window, under the same rule.
	 * @param int    $default_on_demand_idle Idle window before a worker exits; 0 stays resident.
	 * @return array<string,mixed>|null
	 */
	public static function synthesize_entry(
		string $name,
		int $default_num_partitions = 1,
		int $default_stale_timeout = Lock_Node::STALE_TIMEOUT,
		int $default_on_demand_idle = 0
	): ?array {
		if ( null === self::resolve( $name ) ) {
			return null;
		}
		$front      = Topology_Analyzer::frontmatter( $name );
		$partitions = Core::num_int( $front['num_partitions'] ?? null, $default_num_partitions );
		$stale      = Core::num_int( $front['stale_timeout'] ?? null, $default_stale_timeout );
		return [
			'topology'       => $name,
			'num_partitions' => $partitions > 0 ? $partitions : $default_num_partitions,
			'stale_timeout'  => $stale > 0 ? $stale : $default_stale_timeout,
			'on_demand_idle' => \Newspack_Nodes\Bootstrap::on_demand_idle_of( $front, $default_on_demand_idle ),
		];
	}

	/**
	 * Add a topology to the persisted active set and spawn its fleet now.
	 *
	 * The one activation primitive behind both the `topologies activate` CI verb
	 * and the `wp nodes activate` CLI verb: write the option, invalidate the
	 * config cache, spawn. It materializes the effective active set from
	 * `Bootstrap::get_topologies()` rather than the raw option, so config-file
	 * defaults are not silently dropped, and it refuses a write-conflicting set
	 * BEFORE writing, so such a set is never persisted or spawned. Idempotent:
	 * an already-active name re-spawns without duplicating.
	 *
	 * Callers validate the name and gate the capability. Every refusal raises,
	 * so both surfaces report a uniform error.
	 *
	 * @param string $name Topology name (already validated by the caller).
	 * @return array{name: string, active: true, spawned: int} `spawned` counts
	 *         spawn POSTs REQUESTED — a fire-and-forget POST reports no outcome.
	 * @throws \RuntimeException When the name is unknown or activating it would
	 *                           put two fleets on one log or offsetlog.
	 */
	public static function activate( string $name ): array {
		if ( null === self::resolve( $name ) ) {
			throw new \RuntimeException(
				\esc_html( "unknown topology '$name'" )
			);
		}

		$next      = \array_values( \array_unique( \array_merge( \array_keys( \Newspack_Nodes\Bootstrap::get_topologies() ), [ $name ] ) ) );
		$conflicts = Topology_Analyzer::find_conflicts( $next );
		if ( ! empty( $conflicts ) ) {
			throw new \RuntimeException(
				\esc_html( "activating '$name' conflicts: " . Topology_Analyzer::describe_conflicts( $conflicts ) )
			);
		}

		\update_option( 'newspack_nodes_topologies', $next );
		self::invalidate_config_cache();

		$spawned = \Newspack_Nodes\Bootstrap::spawn_coordinator()->spawn_fleet( $name );

		return [
			'name'    => $name,
			'active'  => true,
			'spawned' => $spawned,
		];
	}

	/**
	 * Absolute path to `<name>.tsl`, or null when no registered dir holds one.
	 *
	 * `is_file`, not `file_exists`: a directory named `<name>.tsl` is not a
	 * topology, and resolving one would hand the loader a path it cannot read.
	 *
	 * @param string $name Topology name, without the `.tsl` extension.
	 */
	public static function resolve( string $name ): ?string {
		// Order is load-bearing: a shadowing user .tsl is code execution.
		foreach ( self::$stock_dirs as $dir ) {
			$path = $dir . '/' . $name . '.tsl';
			if ( \is_file( $path ) ) {
				return $path;
			}
		}
		if ( '' !== self::$user_dir ) {
			$user_path = self::$user_dir . '/' . $name . '.tsl';
			if ( \is_file( $user_path ) ) {
				return $user_path;
			}
		}
		return null;
	}

	/**
	 * Register a plugin's topologies: a node-namespace prefix and a stock dir.
	 *
	 * Topologies are NOT owned by the registering plugin. `publish_catalog`
	 * builds the catalog from `list()` (the user dir plus every stock dir), and
	 * `spawn_worker` spawns any active topology regardless of which plugin — if
	 * any — shipped it. This call only makes a plugin's `*_Node` classes
	 * resolvable to `make_node` (`register_namespace`, ADR-10) and its `.tsl`
	 * files discoverable (`register_stock_dir`).
	 *
	 * @param string $namespace_prefix Class-namespace prefix ending in a backslash, e.g. `Acme\`.
	 * @param string $topologies_dir   Directory holding the plugin's stock `.tsl` files.
	 */
	public static function register_plugin( string $namespace_prefix, string $topologies_dir ): void {
		// Idempotent: repeated plugins_loaded passes must not re-register.
		$key = $namespace_prefix . '|' . \rtrim( $topologies_dir, '/' );
		if ( isset( self::$registered_plugins[ $key ] ) ) {
			return;
		}
		self::$registered_plugins[ $key ] = true;

		\Newspack_Nodes\Command_Interpreter_Node::register_namespace( $namespace_prefix );
		self::register_stock_dir( $topologies_dir );
	}

	/**
	 * Add a consumer's stock dir at the FRONT of the resolution order, so it
	 * outranks both every dir registered before it and the substrate's own
	 * bundled dir, which `register_builtin_dir()` appends at the back.
	 * Idempotent, and an empty path registers nothing.
	 *
	 * @param string $path Directory holding `.tsl` files; a trailing slash is trimmed.
	 */
	public static function register_stock_dir( string $path ): void {
		$path = \rtrim( $path, '/' );
		if ( '' === $path ) {
			return;
		}
		if ( ! \in_array( $path, self::$stock_dirs, true ) ) {
			\array_unshift( self::$stock_dirs, $path );
		}
	}

	/**
	 * Clear the dir registrations, the plugin guard and the parsed caches, so a
	 * case starts from an empty registry.
	 *
	 * @api Support for unit tests.
	 */
	public static function reset(): void {
		self::$stock_dirs         = [];
		self::$user_dir           = '';
		self::$registered_plugins = [];
		self::reset_basename_cache();
	}

	/** Drop the parsed TSL caches, keeping the dir registrations. Wired to Config::RESET_ACTION. */
	public static function reset_basename_cache(): void {
		Topology_Analyzer::reset_caches();
	}

	/**
	 * Remove a topology from the persisted active set and drain its fleet now.
	 *
	 * Symmetric with `activate()`: the one deactivation primitive behind both
	 * the `topologies deactivate` CI verb and the `wp nodes deactivate` CLI
	 * verb. It removes the name from the effective active set, writes,
	 * invalidates the config cache, then drops a restart flag on every live
	 * worker's lock dir through `Spawn_Coordinator::kill_readers()`. Nothing is
	 * killed here: each worker reads its own flag and exits on its next drain
	 * iteration. Callers validate the name and gate the capability.
	 *
	 * @param string $name Topology name (already validated by the caller).
	 * @return array{name: string, active: false}
	 */
	public static function deactivate( string $name ): array {
		$active = \array_values( \array_diff( \array_keys( \Newspack_Nodes\Bootstrap::get_topologies() ), [ $name ] ) );
		\update_option( 'newspack_nodes_topologies', $active );
		self::invalidate_config_cache();

		\Newspack_Nodes\Bootstrap::spawn_coordinator()->kill_readers( [ $name ] );

		return [
			'name'   => $name,
			'active' => false,
		];
	}

	/**
	 * Drop the per-process option snapshot, then the config snapshot, so the
	 * next `Bootstrap::get_topologies()` or `expand_workers()` sees the
	 * just-written active set. The order is the contract: `Config::reset()`
	 * reads back through `get_option`, so purging WP's option cache afterwards
	 * would re-seed the snapshot from the values it just dropped.
	 *
	 * Public because every path that mutates the active set shares this one
	 * definition — `activate()`, `deactivate()`, the `Topologies_CI` delete
	 * verb, and `Fleet_Node::refresh_active_set()` on a reload watermark. A
	 * hand-rolled subset drops one of the four steps and leaves a memo stale.
	 */
	public static function invalidate_config_cache(): void {
		\Newspack_Nodes\Config::invalidate_options_cache();
		\Newspack_Nodes\Config::reset();
		// The reader memo is keyed off the active set this just changed.
		\Newspack_Nodes\Bootstrap::forget_on_demand_readers();
		// So is the probe cadence: it is read out of topic-probe.tsl.
		\Newspack_Nodes\Topic_Probe_Node::forget_interval();
	}

	/**
	 * Every topology name across the user dir and every stock dir, deduplicated.
	 *
	 * @return array<int,string>
	 */
	public static function list(): array {
		return \array_keys( self::scan_dirs() );
	}

	/**
	 * Per-name source breakdown across the user dir and every stock dir; powers
	 * the REST list `source` field.
	 *
	 * @return array<string,array{user:?string,stock:array<int,string>}>
	 */
	public static function describe(): array {
		return self::scan_dirs();
	}

	/**
	 * The ONE dir walk. `list()` and `describe()` are both views of it, so which
	 * dirs are scanned and which files count is stated once; a second copy of
	 * this loop is how the catalog and the `source` field drift apart.
	 *
	 * A name found in several dirs keeps every path it was found at: this shape
	 * reports where a topology comes from, and `resolve()` alone decides which
	 * copy wins.
	 *
	 * @return array<string,array{user:?string,stock:array<int,string>}>
	 */
	private static function scan_dirs(): array {
		$out = [];
		foreach ( self::scan_dir( self::$user_dir ) as $name => $path ) {
			$out[ $name ] = [ 'user' => $path, 'stock' => [] ];
		}
		foreach ( self::$stock_dirs as $dir ) {
			foreach ( self::scan_dir( $dir ) as $name => $path ) {
				$out[ $name ]          ??= [ 'user' => null, 'stock' => [] ];
				$out[ $name ]['stock'][] = $path;
			}
		}
		return $out;
	}

	/**
	 * Every `.tsl` in one dir as `name => path`; empty when it is not a dir.
	 *
	 * @param string $dir Absolute directory path, or '' for none.
	 * @return array<string,string>
	 */
	private static function scan_dir( string $dir ): array {
		if ( '' === $dir || ! \is_dir( $dir ) ) {
			return [];
		}
		$found = [];
		foreach ( \glob( $dir . '/*.tsl' ) ?: [] as $path ) {
			if ( \is_file( $path ) ) {
				$found[ \basename( $path, '.tsl' ) ] = $path;
			}
		}
		return $found;
	}

	/**
	 * Register the substrate's OWN topologies. This class ships beside them, so
	 * nothing needs to tell it where they are.
	 *
	 * The plugin file calls this at LOAD, where consumers register theirs,
	 * rather than from `Bootstrap::ensure_runtime_wired()`: a frontend page view
	 * never reaches the runtime tier, so a consumer topology registered at load
	 * would resolve there while its `include topic-probe` did not.
	 */
	public static function register_builtin(): void {
		self::register_builtin_dir( \dirname( __DIR__ ) . '/topologies' );
	}

	/**
	 * Register the substrate's own bundled dir as the lowest-priority fallback:
	 * appended to the END, so every consumer-registered stock dir resolves first
	 * whatever the load-time ordering. A consumer overrides a builtin topology
	 * such as `job-worker` by shipping a same-named `.tsl`, and a nodes-only
	 * deployment still resolves it here. Pushed once (idempotent).
	 *
	 * @param string $path Directory holding the bundled `.tsl` files.
	 */
	public static function register_builtin_dir( string $path ): void {
		$path = \rtrim( $path, '/' );
		if ( '' === $path || \in_array( $path, self::$stock_dirs, true ) ) {
			return;
		}
		self::$stock_dirs[] = $path;
	}

	/**
	 * Point the registry at the writable per-deployment dir, where the topology
	 * editor saves a new `.tsl`. There is exactly one, so a later call replaces
	 * the path an earlier one set; `Bootstrap` sets it to
	 * `base_dir() . '/topologies'`.
	 *
	 * @param string $path Directory path; a trailing slash is trimmed.
	 */
	public static function register_user_dir( string $path ): void {
		self::$user_dir = \rtrim( $path, '/' );
	}

	/** Read-only view of the user-dir path; '' when none is registered. */
	public static function user_dir(): string {
		return self::$user_dir;
	}

	/**
	 * `newspack_nodes/spawn_worker` handler: spawn the `{type, partition}`
	 * worker if and only if it is in the active set
	 * (`Bootstrap::expand_workers()`), ungated by plugin ownership. A type with
	 * no active descriptor is a no-op, so a POST naming a deactivated fleet
	 * spawns nothing. `Spawn_Controller` fires the action once it has authorized
	 * the request; the substrate registers this handler in newspack-nodes.php.
	 *
	 * The spawn itself runs through the `$spawn_runner` seam, which defaults
	 * here to a real `Worker_Base` execution.
	 *
	 * @param string $type      Topology name, which is also the worker type.
	 * @param int    $partition Partition index within that fleet.
	 */
	public static function spawn_worker( string $type, int $partition ): void {
		foreach ( \Newspack_Nodes\Bootstrap::expand_workers() as $w ) {
			if ( $w['type'] !== $type || $w['partition'] !== $partition ) {
				continue;
			}
			$runner = self::$spawn_runner ?? static function ( array $descriptor ): void {
				$base_dir      = \Newspack_Nodes\Bootstrap::base_dir();
				// The seam accessor, so the HMAC salt matches the runtime.
				$coordinator   = \Newspack_Nodes\Bootstrap::spawn_coordinator();
				$topology_name = Core::as_string( $descriptor['topology'] );
				$wb            = new \Newspack_Nodes\Worker_Base(
					$base_dir,
					Core::as_string( $descriptor['type'] ),
					Core::as_int( $descriptor['partition'] ),
					stale_timeout: Lock_Node::stale_timeout_of( $descriptor ),
					on_demand_idle: \Newspack_Nodes\Bootstrap::on_demand_idle_of( $descriptor )
				);
				$topology      = static function ( \Newspack_Nodes\Command_Interpreter_Node $interpreter, int $partition_arg ) use ( $topology_name ): void {
					\Newspack_Nodes\Topology_Loader::load( $topology_name, $partition_arg, $interpreter );
				};
				$wb->execute( $topology, \rest_url( 'newspack-nodes/v1/workers/spawn' ), $coordinator->generate_spawn_token( \time() ) );
			};
			$runner( $w );
			break;
		}
	}
}
