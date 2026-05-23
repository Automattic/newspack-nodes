<?php
/**
 * WorkerCliCommand: WP-CLI subcommands for worker lifecycle management.
 *
 * Adds `wp nodes types` / `run <type>` / `restart <type>` / `status` beyond the
 * existing `ls` / `cli`. The cache lookup is filterable via
 * `newspack_nodes/worker_cli_cache` so applications wire their own memcache.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Worker_CLI_Command {

	private function base_dir(): string {
		return (string) ( Config::load_config()['base_directory'] ?? '/tmp/newspack-nodes' );
	}

	/**
	 * Helper for command implementations to reach the same Cli helper without
	 * recreating it every time.
	 */
	private function cli(): CLI {
		return new CLI( $this->base_dir() );
	}

	/**
	 * Resolve the cache instance applications wire in for live cursor reads.
	 * If no cache is filtered in, callers fall back to the offsetlog on disk.
	 *
	 * @return object|null
	 */
	private function cache(): ?object {
		$cache = \apply_filters( 'newspack_nodes/worker_cli_cache', null );
		return \is_object( $cache ) ? $cache : null;
	}

	/**
	 * Expand topologies registered via the `newspack_nodes/topologies` filter
	 * into a flat list of `{type, partition, stale_timeout}` rows.
	 */
	private function workers(): array {
		return Bootstrap::expand_workers();
	}

	/**
	 * List active worker topology groups — the same set the supervisor will
	 * spawn (`Bootstrap::get_topologies()`), so this agrees with `wp nodes ls`.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes types
	 *
	 * @when after_wp_load
	 */
	public function types( array $args, array $assoc_args ): void {
		$topologies = Bootstrap::get_topologies();

		if ( empty( $topologies ) ) {
			\WP_CLI::warning( 'No active topologies. Activate one via Settings → Nodes Runtime → Topologies, or add via the `newspack_nodes/topologies` filter.' );
			return;
		}

		\WP_CLI::log( 'Active topology groups:' );
		foreach ( $topologies as $name => $config ) {
			$partitions = (int) ( $config['num_partitions'] ?? 1 );
			$stale      = (int) ( $config['stale_timeout'] ?? Lock_Node::STALE_TIMEOUT );
			$path       = (string) ( $config['topology'] ?? '' );
			$plural     = 1 === $partitions ? 'partition' : 'partitions';
			\WP_CLI::log( "  - {$name} ({$partitions} {$plural}, stale_timeout={$stale}s)" );
			if ( '' !== $path ) {
				\WP_CLI::log( "    topology: {$path}" );
			}
		}
	}

	/**
	 * Run a worker process directly (no spawn endpoint).
	 *
	 * Useful for debugging: instantiates a `WorkerBase`, runs the topology, and
	 * blocks until the worker exits (max_runtime, OOM watermark, restart flag).
	 *
	 * ## OPTIONS
	 *
	 * <type>
	 * : Worker type to run. Use `wp nodes types` to see available types.
	 *
	 * [--partition=<partition>]
	 * : Partition number (0-based).
	 * ---
	 * default: 0
	 * ---
	 *
	 * [--quiet]
	 * : Suppress informational output.
	 *
	 * ## EXAMPLES
	 *
	 *     # Run firehose-workers for partition 0
	 *     wp nodes run firehose-workers
	 *
	 *     # Run aggregator on partition 0
	 *     wp nodes run aggregator --partition=0
	 *
	 * @when after_wp_load
	 */
	public function run( array $args, array $assoc_args ): void {
		$workers = $this->workers();
		$valid   = \array_unique( \array_column( $workers, 'type' ) );

		$type      = $args[0] ?? '';
		$partition = (int) ( $assoc_args['partition'] ?? 0 );
		$quiet     = isset( $assoc_args['quiet'] );

		if ( '' === $type ) {
			\WP_CLI::error( 'Worker type required. Use: wp nodes run <type>' );
		}
		if ( ! \in_array( $type, $valid, true ) ) {
			\WP_CLI::error( 'Invalid worker type: ' . $type . '. Available: ' . \implode( ', ', $valid ) );
		}

		// Find the descriptor for this {type, partition}.
		$descriptor = null;
		foreach ( $workers as $w ) {
			if ( $w['type'] === $type && (int) $w['partition'] === $partition ) {
				$descriptor = $w;
				break;
			}
		}
		if ( null === $descriptor ) {
			\WP_CLI::error( \sprintf( 'No worker registered for %s partition %d', $type, $partition ) );
		}

		// Resolve the TSL topology name and build a closure that runs it via Topology_Loader.
		$topology_name = (string) ( $descriptor['topology'] ?? '' );
		if ( '' === $topology_name || null === Topology_Registry::resolve( $topology_name ) ) {
			\WP_CLI::error( 'Topology not found in registry: ' . $topology_name );
		}
		// CLI-side runs use the substrate's own Config.
		$config = \Newspack_Nodes\Config::load_config();
		if ( ! isset( $config['logs_dir'] ) && isset( $config['base_directory'] ) ) {
			$config['logs_dir'] = \rtrim( (string) $config['base_directory'], '/' ) . '/logs';
		}
		if ( ! isset( $config['offsets_dir'] ) && isset( $config['base_directory'] ) ) {
			$config['offsets_dir'] = \rtrim( (string) $config['base_directory'], '/' ) . '/offsets';
		}
		$topology = static function (
			Command_Interpreter_Node $ci,
			int $partition_arg
		) use ( $topology_name, $config ): void {
			Topology_Loader::load( $topology_name, $partition_arg, $ci, $config );
		};

		if ( ! $quiet ) {
			\WP_CLI::log( \sprintf( 'Starting %s.p%d (direct mode, no spawn endpoint)...', $type, $partition ) );
		}

		// Bootstrap::supervisor() so the HMAC salt matches the runtime and
		// CLI-launched respawns are accepted by the real spawn endpoint.
		$supervisor = Bootstrap::supervisor();

		$wb = new Worker_Base(
			$this->base_dir(),
			$type,
			$partition,
			stale_timeout: (int) ( $descriptor['stale_timeout'] ?? Lock_Node::STALE_TIMEOUT )
		);

		$spawn_url = \function_exists( 'rest_url' )
			? \rest_url( 'newspack-nodes/v1/workers/spawn' )
			: '';
		$token     = $supervisor->generate_spawn_token( \time() );

		$result = $wb->execute( $topology, $spawn_url, $token );
		if ( ! $quiet ) {
			\WP_CLI::success( 'Worker exited with status: ' . $result['status'] );
		}
	}

	/**
	 * Request a worker restart by writing a `restart` flag into its lock dir.
	 *
	 * The current holder polls `should_restart()` from its drain loop and exits
	 * cleanly. The supervisor (or self-respawn path) starts a fresh process.
	 *
	 * ## OPTIONS
	 *
	 * <type>
	 * : Worker type to restart, or `all` for all types.
	 *
	 * [--partition=<partition>]
	 * : Partition number (0-based).
	 *
	 * [--all-partitions]
	 * : Apply across every partition for the matched type(s).
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes restart firehose-workers --partition=0
	 *     wp nodes restart all --all-partitions
	 *
	 * @when after_wp_load
	 */
	public function restart( array $args, array $assoc_args ): void {
		$workers = $this->workers();
		$valid   = \array_unique( \array_column( $workers, 'type' ) );

		$type           = $args[0] ?? '';
		$all_partitions = isset( $assoc_args['all-partitions'] );
		$partition      = $all_partitions ? -1 : (int) ( $assoc_args['partition'] ?? -1 );

		if ( '' === $type ) {
			\WP_CLI::error( 'Worker type required. Use: wp nodes restart <type>' );
		}
		if ( 'all' !== $type && ! \in_array( $type, $valid, true ) ) {
			\WP_CLI::error( 'Invalid worker type: ' . $type . '. Available: ' . \implode( ', ', $valid ) . ', all' );
		}
		if ( ! $all_partitions && $partition < 0 ) {
			\WP_CLI::error( 'Specify --partition=<N> or --all-partitions.' );
		}

		$filter    = ( 'all' === $type ) ? [] : [ $type => true ];
		$cli       = $this->cli();
		$restarted = $cli->restart_workers( $workers, $filter, $partition );

		\WP_CLI::success( "Requested restart for {$restarted} worker(s)." );
	}

	/**
	 * Action handler (wired to `newspack_nodes/restart_fleet`): restart every
	 * partition of one fleet by topology name. Best-effort; unknown → no-op.
	 */
	public static function restart_fleet_by_name( string $name ): void {
		$workers = Bootstrap::expand_workers();
		$workers = \array_values( \array_filter(
			$workers,
			static fn ( $w ) => ( $w['type'] ?? '' ) === $name
		) );
		if ( empty( $workers ) ) {
			return;
		}
		$base_dir = (string) ( Config::load_config()['base_directory'] ?? '/tmp/newspack-nodes' );
		( new CLI( $base_dir ) )->restart_workers( $workers, [ $name => true ], -1 );
	}

	/**
	 * Rich worker-status table: Type | Partition | Status | Uptime | Behind | Restart.
	 *
	 * ## OPTIONS
	 *
	 * [--format=<format>]
	 * : Output format. Use 'json' for scriptable consumers.
	 * ---
	 * default: table
	 * options:
	 *   - table
	 *   - json
	 *   - csv
	 *   - yaml
	 * ---
	 *
	 * @when after_wp_load
	 */
	public function status( array $args, array $assoc_args ): void {
		$cli      = $this->cli();
		$workers  = $this->workers();
		$base_dir = $this->base_dir();
		$cache    = $this->cache();

		if ( empty( $workers ) ) {
			\WP_CLI::warning( 'No topologies registered.' );
			return;
		}

		$now  = \time();
		$rows = [];
		foreach ( $workers as $w ) {
			$type     = $w['type'];
			$p        = (int) $w['partition'];
			$lock_dir = "{$base_dir}/locks/{$type}.p{$p}.lock.d";

			$status        = 'dead';
			$stale_timeout = (int) ( $w['stale_timeout'] ?? Lock_Node::STALE_TIMEOUT );
			$hb            = "{$lock_dir}/heartbeat";
			\clearstatcache( true, $hb );
			$mtime = \file_exists( $hb ) ? @\filemtime( $hb ) : false;
			if ( false !== $mtime && ( $now - $mtime ) < $stale_timeout ) {
				$status = 'running';
			}

			$started_at = Lock_Node::get_started_time( $lock_dir );
			$uptime     = $started_at ? CLI::format_duration( $now - $started_at ) : '-';

			$position = $cli->live_position( $cache, $type, $p ) ?? $cli->saved_position( $type, $p );
			$behind   = '-';
			if ( null !== $position ) {
				// The drained input log is topology-specific; default to the conventional
				// firehose.log partition dir so convention-following apps get useful numbers.
				$logs_dir      = "{$base_dir}/logs";
				$partition_dir = "{$logs_dir}/firehose.log/p{$p}";
				if ( \is_dir( $partition_dir ) ) {
					$bytes  = CLI::calculate_behind( $partition_dir, (int) $position['seg'], (int) $position['off'] );
					$behind = CLI::format_bytes( $bytes );
				}
			}

			$restart = Lock_Node::is_restart_pending( $lock_dir ) ? 'yes' : 'no';

			$rows[] = [
				'Type'      => $type,
				'Partition' => $p,
				'Status'    => $status,
				'Uptime'    => $uptime,
				'Behind'    => $behind,
				'Restart'   => $restart,
			];
		}

		$format = $assoc_args['format'] ?? 'table';
		if ( \function_exists( 'WP_CLI\\Utils\\format_items' ) ) {
			\WP_CLI\Utils\format_items( $format, $rows, [ 'Type', 'Partition', 'Status', 'Uptime', 'Behind', 'Restart' ] );
		} else {
			// Test fallback: dump a stable plain-text representation.
			foreach ( $rows as $row ) {
				\WP_CLI::log( \sprintf(
					'%-30s p%-2d  %-7s  %-8s  %-10s  restart=%s',
					$row['Type'],
					$row['Partition'],
					$row['Status'],
					$row['Uptime'],
					$row['Behind'],
					$row['Restart']
				) );
			}
		}
	}
}
