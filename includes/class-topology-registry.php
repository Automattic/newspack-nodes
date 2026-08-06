<?php
/**
 * Topology_Registry — name → .tsl path resolver.
 *
 * Plugins register stock dirs, which own their names; the writable user dir
 * serves only names no stock dir provides.
 * Resolution: user dir first, then each stock dir in registration order.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topology_Registry {

	/**
	 * Worker-spawn seam for spawn_worker's default handler. Lazily defaulted
	 * to a closure that builds + executes the real Worker_Base. Tests reassign in
	 * setUp to capture the spawn intent without forking a worker process — that
	 * leaves the guard + expand_workers lookup running as real production code.
	 * Signature: `function ( string $type, int $partition, string $topology_name, int $stale_timeout ): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $spawn_runner = null;



	/** @var array<string,bool> Guards register_plugin against double-wiring (a second call would double-spawn). */
	private static array $registered_plugins = [];



	/** @var array<int,string> Plugin-registered stock dirs (first wins). */
	private static array $stock_dirs = [];

	/** @var string Writable per-deployment user dir. */
	private static string $user_dir = '';






















	/**
	 * True when a TSL class token resolves to a Tee-family PASS-THROUGH node.
	 * Narrower than fan-out on purpose: this drives the `tee` layout kind, which
	 * the dashboard contracts out of the graph. A minter is a destination.
	 */


	/**
	 * `newspack_nodes/topologies` catalog filter: synthesize an entry for every
	 * `.tsl` in `list()` (user-authored + every registered stock dir), so the
	 * catalog reflects what exists on disk, not a per-plugin allowlist. Registered
	 * once by the substrate (newspack-nodes.php). num_partitions defaults to the
	 * operator-overridable substrate option (clamped 1..16); a topology's own
	 * `var num_partitions` frontmatter overrides via synthesize_entry.
	 *
	 * @param array<string, array<string, mixed>> $topologies Existing catalog (a prior contributor wins on key collision).
	 * @return array<string, array<string, mixed>>
	 */
	public static function publish_catalog( array $topologies ): array {
		$cfg_np     = \Newspack_Nodes\Config::value( 'num_partitions' );
		$default_np = \max( 1, \min( 16, Core::as_int( $cfg_np, 1 ) ) );
		foreach ( self::list() as $name ) {
			if ( isset( $topologies[ $name ] ) ) {
				continue;
			}
			$entry = self::synthesize_entry( $name, $default_np, Lock_Node::STALE_TIMEOUT );
			if ( null !== $entry ) {
				$topologies[ $name ] = $entry;
			}
		}
		return $topologies;
	}

	/**
	 * Build a `[topology, num_partitions, stale_timeout]` entry from a TSL's frontmatter; null if unknown.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function synthesize_entry(
		string $name,
		int $default_num_partitions = 1,
		int $default_stale_timeout = Lock_Node::STALE_TIMEOUT
	): ?array {
		if ( null === self::resolve( $name ) ) {
			return null;
		}
		$front = Topology_Analyzer::frontmatter( $name );
		return [
			'topology'       => $name,
			'num_partitions' => isset( $front['num_partitions'] ) ? (int) $front['num_partitions'] : $default_num_partitions,
			'stale_timeout'  => isset( $front['stale_timeout'] ) ? (int) $front['stale_timeout'] : $default_stale_timeout,
		];
	}

	/**
	 * Return the absolute path to `<name>.tsl` or null if unknown (is_file, not file_exists).
	 */
	public static function resolve( string $name ): ?string {
		// Stock owns its names: shadowing made a writable dir code execution.
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
	 * Add a topology to the persisted active set and spawn its fleet now.
	 *
	 * The shared activation primitive both the `topologies activate` CI verb and
	 * the `wp nodes activate` CLI verb call — the option-write + cache-invalidate
	 * + immediate spawn. Materializes the effective active set
	 * (Bootstrap::get_topologies(), NOT get_option default — so the config-file
	 * defaults aren't silently dropped), refuses a write-conflict BEFORE writing
	 * (so a conflicting set never gets persisted and spawned), then writes and
	 * spawns. Idempotent: an already-active name re-spawns without duplicating.
	 *
	 * Callers are responsible for name validation + capability gating; this throws
	 * RuntimeException on an unknown name or a write-conflict so both surfaces
	 * report a uniform error.
	 *
	 * @param string $name Topology name (already validated by the caller).
	 * @return array{name: string, active: true, spawned: int}
	 * @throws \RuntimeException When the name is unknown or activating it would
	 *                           put two fleets on one log/offsetlog.
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

		$spawned = \Newspack_Nodes\Bootstrap::supervisor()->spawn_fleet( $name );

		return [
			'name'    => $name,
			'active'  => true,
			'spawned' => $spawned,
		];
	}






	/**
	 * Drop the per-process option snapshot then the config snapshot so the next
	 * Bootstrap::get_topologies() / expand_workers() sees the just-written active
	 * set. Same pair, same order, as Fleet_Node::check_config(). Public so the
	 * Topologies_CI delete verb (which mutates the active set on its own path)
	 * shares this one definition instead of carrying a parallel copy.
	 */
	public static function invalidate_config_cache(): void {
		\Newspack_Nodes\Config::invalidate_options_cache();
		\Newspack_Nodes\Config::reset();
	}


	/**
	 * Register a plugin's topologies: a node-namespace prefix + a stock dir.
	 *
	 * Topologies are NOT owned by the registering plugin. The catalog is built
	 * from `list()` (user dir ∪ every stock dir) by `publish_catalog`, and any
	 * active topology is spawned by `spawn_worker` regardless of which plugin — if
	 * any — shipped it. This call only makes a plugin's `*_Node` classes resolvable
	 * (`register_namespace`) and its `.tsl` files discoverable (`register_stock_dir`).
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

	public static function register_stock_dir( string $path ): void {
		$path = \rtrim( $path, '/' );
		if ( '' === $path ) {
			return;
		}
		if ( ! \in_array( $path, self::$stock_dirs, true ) ) {
			\array_unshift( self::$stock_dirs, $path );
		}
	}

	/** @api Support for unit tests. */
	public static function reset(): void {
		self::$stock_dirs         = [];
		self::$user_dir           = '';
		self::$registered_plugins = [];
		self::reset_basename_cache();
	}

	/** Drop only the parsed caches, keeping the dir registrations (wired to Config::RESET_ACTION). */
	public static function reset_basename_cache(): void {
		Topology_Analyzer::reset_caches();
	}

	/**
	 * Remove a topology from the persisted active set and drain its fleet now.
	 *
	 * Symmetric with activate(): the shared deactivation primitive both the
	 * `topologies deactivate` CI verb and the `wp nodes deactivate` CLI verb call.
	 * Removes the name from the effective active set, writes, invalidates the
	 * config cache, then drops a restart flag on every live worker lock dir via
	 * Spawn_Coordinator::kill_readers(). Callers validate the name + gate the capability.
	 *
	 * @param string $name Topology name (already validated by the caller).
	 * @return array{name: string, active: false}
	 */
	public static function deactivate( string $name ): array {
		$active = \array_values( \array_diff( \array_keys( \Newspack_Nodes\Bootstrap::get_topologies() ), [ $name ] ) );
		\update_option( 'newspack_nodes_topologies', $active );
		self::invalidate_config_cache();

		\Newspack_Nodes\Bootstrap::supervisor()->kill_readers( [ $name ] );

		return [
			'name'   => $name,
			'active' => false,
		];
	}

	/**
	 * Return the union of topology names across user + stock dirs.
	 *
	 * @return array<int,string>
	 */
	public static function list(): array {
		$names = [];
		if ( '' !== self::$user_dir && \is_dir( self::$user_dir ) ) {
			foreach ( \glob( self::$user_dir . '/*.tsl' ) ?: [] as $path ) {
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$names[ \basename( $path, '.tsl' ) ] = true;
			}
		}
		foreach ( self::$stock_dirs as $dir ) {
			foreach ( \glob( $dir . '/*.tsl' ) ?: [] as $path ) {
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$names[ \basename( $path, '.tsl' ) ] = true;
			}
		}
		return \array_keys( $names );
	}

	/**
	 * Register the substrate's own bundled dir as the lowest-priority fallback:
	 * appended to the END so every consumer-registered stock dir resolves first
	 * regardless of load-time ordering. Consumers override a builtin topology
	 * (e.g. job-worker) simply by shipping a same-named .tsl; nodes-only
	 * deployments still resolve via this fallback. Pushed once (idempotent).
	 */
	public static function register_builtin_dir( string $path ): void {
		$path = \rtrim( $path, '/' );
		if ( '' === $path || \in_array( $path, self::$stock_dirs, true ) ) {
			return;
		}
		self::$stock_dirs[] = $path;
	}

	public static function register_user_dir( string $path ): void {
		self::$user_dir = \rtrim( $path, '/' );
	}

	/** Read-only view of the user-dir path. */
	public static function user_dir(): string {
		return self::$user_dir;
	}

	/**
	 * Per-name source breakdown across user + stock dirs (powers the REST list `source` field).
	 *
	 * @return array<string,array{user:?string,stock:array<int,string>}>
	 */
	public static function describe(): array {
		$out = [];
		if ( '' !== self::$user_dir && \is_dir( self::$user_dir ) ) {
			foreach ( \glob( self::$user_dir . '/*.tsl' ) ?: [] as $path ) {
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$name                    = \basename( $path, '.tsl' );
				$out[ $name ]['user']    = $path;
				$out[ $name ]['stock'] ??= [];
			}
		}
		foreach ( self::$stock_dirs as $dir ) {
			foreach ( \glob( $dir . '/*.tsl' ) ?: [] as $path ) {
				if ( ! \is_file( $path ) ) {
					continue;
				}
				$name                      = \basename( $path, '.tsl' );
				$out[ $name ]['user']    ??= null;
				$out[ $name ]['stock']   ??= [];
				$out[ $name ]['stock'][]   = $path;
			}
		}
		return $out;
	}

	/**
	 * `newspack_nodes/spawn_worker` handler: spawn the {type, partition} worker iff
	 * it is in the active set (`Bootstrap::expand_workers()`) — ungated by plugin
	 * ownership. Runs the `$spawn_runner` seam (which defaults to a real
	 * Worker_Base execution). A type with no active descriptor is a no-op.
	 * Registered once by the substrate (newspack-nodes.php).
	 */
	public static function spawn_worker( string $type, int $partition ): void {
		foreach ( \Newspack_Nodes\Bootstrap::expand_workers() as $w ) {
			if ( $w['type'] !== $type || $w['partition'] !== $partition ) {
				continue;
			}
			$runner = self::$spawn_runner ?? static function ( string $t, int $p, string $topology_name, int $stale ): void {
				$base_dir   = \Newspack_Nodes\Bootstrap::base_dir();
				$coordinator = new \Newspack_Nodes\Spawn_Coordinator( $base_dir );
				$wb         = new \Newspack_Nodes\Worker_Base( $base_dir, $t, $p, stale_timeout: $stale );
				$topology   = static function ( \Newspack_Nodes\Command_Interpreter_Node $interpreter, int $partition_arg ) use ( $topology_name ): void {
					\Newspack_Nodes\Topology_Loader::load( $topology_name, $partition_arg, $interpreter );
				};
				$wb->execute( $topology, \rest_url( 'newspack-nodes/v1/workers/spawn' ), $coordinator->generate_spawn_token( \time() ) );
			};
			$w_topology = Core::as_string( $w['topology'] );
			$w_stale    = Core::as_int( $w['stale_timeout'] );
			$runner( $w['type'], $w['partition'], $w_topology, $w_stale );
			break;
		}
	}
}
