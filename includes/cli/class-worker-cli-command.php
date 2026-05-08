<?php
/**
 * WorkerCliCommand: WP-CLI subcommands for worker lifecycle management.
 *
 * Adds three subcommands beyond the existing `wp nodes ls` / `wp nodes cli`:
 *
 *  - `wp nodes types`            — list registered topology groups + standalone workers.
 *  - `wp nodes run <type>`       — run a worker process directly (no spawn endpoint).
 *  - `wp nodes restart <type>`   — write the restart flag via Lock::request_restart_at().
 *  - `wp nodes status`           — rich `Type | Partition | Status | Uptime | Behind | Restart`
 *                                  table; reads cursor positions from memcache live with
 *                                  offsetlog fallback; computes Behind by summing partition
 *                                  bytes still ahead of the cursor.
 *
 * Lives in a separate class file (rather than extending `Cli_Command`) so the
 * existing `ls` / `cli` flat command class stays untouched and reviewers can
 * reason about the surface change in isolation.
 *
 * The cache lookup for `live_positions()` is filterable via
 * `newspack_nodes/worker_cli_cache` so applications can wire their own
 * memcache instance without this class linking against `\Memcached_Cache`.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class WorkerCliCommand {

	private function base_dir(): string {
		return (string) \apply_filters( 'newspack_nodes/base_dir', '/tmp/newspack-nodes' );
	}

	/**
	 * Helper for command implementations to reach the same Cli helper without
	 * recreating it every time.
	 */
	private function cli(): Cli {
		return new Cli( $this->base_dir() );
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
		if ( \class_exists( '\Newspack_Nodes\Bootstrap' ) ) {
			return Bootstrap::expand_workers();
		}
		// Fallback: parse the filter directly so this command works during early
		// plugin tests where Bootstrap isn't autoloaded yet.
		$topologies = (array) \apply_filters( 'newspack_nodes/topologies', [] );
		$workers    = [];
		foreach ( $topologies as $type => $config ) {
			$count = (int) ( $config['num_partitions'] ?? 1 );
			for ( $p = 0; $p < $count; ++$p ) {
				$workers[] = [
					'type'          => $type,
					'partition'     => $p,
					'stale_timeout' => $config['stale_timeout'] ?? Lock::STALE_TIMEOUT,
				];
			}
		}
		return $workers;
	}

	/**
	 * List available worker topology groups.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes types
	 *
	 * @when after_wp_load
	 */
	public function types( array $args, array $assoc_args ): void {
		$topologies = (array) \apply_filters( 'newspack_nodes/topologies', [] );

		if ( empty( $topologies ) ) {
			\WP_CLI::warning( 'No topologies registered. Add via the `newspack_nodes/topologies` filter.' );
			return;
		}

		\WP_CLI::log( 'Registered topology groups:' );
		foreach ( $topologies as $name => $config ) {
			$partitions = (int) ( $config['num_partitions'] ?? 1 );
			$stale      = (int) ( $config['stale_timeout'] ?? Lock::STALE_TIMEOUT );
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

		// Find the descriptor for this {type, partition} so we know the topology
		// path + stale_timeout. WorkerBase wants the topology closure, not just
		// the path; the closure is loaded via `require` (matches main plugin file).
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

		$topology_path = (string) ( $descriptor['topology'] ?? '' );
		if ( '' === $topology_path || ! \file_exists( $topology_path ) ) {
			\WP_CLI::error( 'Topology file missing: ' . $topology_path );
		}
		$topology = require $topology_path;
		if ( ! \is_callable( $topology ) ) {
			\WP_CLI::error( 'Topology must return a closure' );
		}

		if ( ! $quiet ) {
			\WP_CLI::log( \sprintf( 'Starting %s.p%d (direct mode, no spawn endpoint)...', $type, $partition ) );
		}

		// Resolve a Supervisor for the HMAC token used in self_respawn(). Using
		// Bootstrap::supervisor() keeps the salt source aligned with the rest of
		// the runtime so respawns from a CLI-launched worker are accepted by the
		// real spawn endpoint.
		$supervisor = \class_exists( '\Newspack_Nodes\Bootstrap' )
			? Bootstrap::supervisor()
			: new Supervisor( $this->base_dir(), \defined( 'NONCE_SALT' ) ? \NONCE_SALT : 'fallback-salt' );

		$wb = new WorkerBase(
			$this->base_dir(),
			$type,
			$partition,
			stale_timeout: (int) ( $descriptor['stale_timeout'] ?? Lock::STALE_TIMEOUT )
		);

		$spawn_url = \function_exists( 'rest_url' )
			? \rest_url( 'newspack-nodes/v1/workers/spawn' )
			: '';
		$token     = $supervisor->generate_spawn_token( \time() );

		$result = $wb->execute( $topology, $spawn_url, $token );
		if ( ! $quiet ) {
			\WP_CLI::success( 'Worker exited with status: ' . ( $result['status'] ?? 'unknown' ) );
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
	 * Rich worker-status table. Six columns:
	 *   Type | Partition | Status | Uptime | Behind | Restart
	 *
	 * - `Status`: 'running' if heartbeat fresh within stale_timeout, else 'dead'.
	 * - `Uptime`: derived from `Lock::get_started_time()`.
	 * - `Behind`: bytes ahead of the cursor (live → memcache, fallback → offsetlog).
	 * - `Restart`: 'yes' if a restart flag is pending in the lock dir.
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
			$stale_timeout = (int) ( $w['stale_timeout'] ?? Lock::STALE_TIMEOUT );
			$hb            = "{$lock_dir}/heartbeat";
			\clearstatcache( true, $hb );
			$mtime = \file_exists( $hb ) ? @\filemtime( $hb ) : false;
			if ( false !== $mtime && ( $now - $mtime ) < $stale_timeout ) {
				$status = 'running';
			}

			$started_at = Lock::get_started_time( $lock_dir );
			$uptime     = $started_at ? Cli::format_duration( $now - $started_at ) : '-';

			$position = $cli->live_position( $cache, $type, $p ) ?? $cli->saved_position( $type, $p );
			$behind   = '-';
			if ( null !== $position ) {
				// We don't know which input log this worker drains here — that's
				// a topology-specific question. Use the conventional firehose.log
				// directory under {logs}/{topic}/p{partition} as the default
				// behind target so applications that follow the convention get
				// useful numbers without per-app wiring.
				$logs_dir      = "{$base_dir}/logs";
				$partition_dir = "{$logs_dir}/firehose.log/p{$p}";
				if ( \is_dir( $partition_dir ) ) {
					$bytes  = Cli::calculate_behind( $partition_dir, (int) $position['seg'], (int) $position['off'] );
					$behind = Cli::format_bytes( $bytes );
				}
			}

			$restart = Lock::is_restart_pending( $lock_dir ) ? 'yes' : 'no';

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
