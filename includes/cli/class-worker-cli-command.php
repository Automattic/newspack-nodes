<?php
/**
 * WorkerCliCommand: WP-CLI subcommands for worker lifecycle management.
 *
 * Adds `wp nodes types` / `run <type>` / `restart <type>` / `status` beyond the
 * existing `ls` / `cli`. Live positions come from the shared TopicProbe log
 * (via `CLI::consumer_rows()`), not memcache.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Worker_CLI_Command {

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
	 *
	 * @param array<int, string>   $args       Positional arguments.
	 * @param array<string, mixed> $assoc_args Associative arguments.
	 */
	public function restart( array $args, array $assoc_args ): void {
		$workers = $this->workers();
		$valid   = \array_unique( \array_column( $workers, 'type' ) );

		$type           = $args[0] ?? '';
		$all_partitions = isset( $assoc_args['all-partitions'] );
		$partition      = $all_partitions ? -1 : self::entry_int( $assoc_args, 'partition', -1 );

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
	 * Expand topologies registered via the `newspack_nodes/topologies` filter
	 * into a flat list of `{type, partition, stale_timeout}` rows.
	 *
	 * @return array<int, array{type: string, partition: int, topology: mixed, stale_timeout: mixed}>
	 */
	private function workers(): array {
		return Bootstrap::expand_workers();
	}

	/**
	 * Read an int from a topology entry, coercing scalars exactly as `(int)` would.
	 *
	 * @param mixed  $entry    Topology entry (array in practice; mixed per the filter contract).
	 * @param string $key      Key to read.
	 * @param int    $fallback Default when missing/non-scalar.
	 */
	private static function entry_int( $entry, string $key, int $fallback ): int {
		$value = \is_array( $entry ) ? ( $entry[ $key ] ?? $fallback ) : $fallback;
		return Core::as_int( $value, $fallback );
	}

	/**
	 * Helper for command implementations to reach the same Cli helper without
	 * recreating it every time.
	 */
	private function cli(): CLI {
		return new CLI( $this->base_dir() );
	}

	private function base_dir(): string {
		return Config::get_base_directory();
	}

	/**
	 * Fleet overview: every catalog topology with per-partition worker state
	 * (live/stale/down from the lock heartbeats, plus uptime from the lock-dir
	 * age), then the consumer-lag table from the TopicProbe snapshot.
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
	 * ## EXAMPLES
	 *
	 *     wp nodes status
	 *
	 * @alias ls
	 * @when after_wp_load
	 *
	 * @param array<int, string>   $args       Positional arguments.
	 * @param array<string, mixed> $assoc_args Associative arguments.
	 */
	public function status( array $args, array $assoc_args ): void {
		$now   = \time();
		$locks = [];
		foreach ( $this->cli()->ls_workers() as $w ) {
			$locks[ "{$w['type']}.p{$w['partition']}" ] = $w;
		}

		// One row per expected worker of each active topology; no lock = down.
		$active = Bootstrap::get_topologies();
		$rows   = [];
		foreach ( $active as $name => $config ) {
			// min 1 row: a num_partitions=0 misconfig must stay visible (down).
			$partitions = \max( 1, self::entry_int( $config, 'num_partitions', 1 ) );
			for ( $p = 0; $p < $partitions; $p++ ) {
				$rows[] = self::fleet_row( $name, $p, $locks[ "{$name}.p{$p}" ] ?? null, $now );
				unset( $locks[ "{$name}.p{$p}" ] );
			}
		}
		// Leftover locks belong to deactivated types still winding down.
		foreach ( $locks as $w ) {
			$row          = self::fleet_row( $w['type'], $w['partition'], $w, $now );
			$row['State'] .= ' (inactive)';
			$rows[]        = $row;
		}
		// Catalog topologies that aren't active: visible, clearly parked.
		foreach ( \array_keys( Topology_Registry::describe() ) as $name ) {
			if ( ! isset( $active[ $name ] ) ) {
				$rows[] = [
					'Topology'  => $name,
					'Partition' => '-',
					'State'     => 'inactive',
					'Heartbeat' => '-',
					'Uptime'    => '-',
				];
			}
		}

		// One row per active Consumer from the TopicProbe snapshot.
		$consumers = [];
		foreach ( $this->cli()->consumer_rows() as $cr ) {
			$consumers[] = [
				'Reader'    => $cr['reader'],
				'Source'    => $cr['source'],
				'Partition' => $cr['partition'],
				'Behind'    => CLI::format_bytes( $cr['distance'] ),
				'Msgs'      => $cr['msgs'],
			];
		}

		if ( empty( $rows ) && empty( $consumers ) ) {
			\WP_CLI::warning( 'No topologies registered or running. base_dir=' . $this->base_dir() );
			return;
		}
		$format = self::entry_string( $assoc_args, 'format' );
		if ( ! empty( $rows ) ) {
			self::render( $format, $rows, [ 'Topology', 'Partition', 'State', 'Heartbeat', 'Uptime' ] );
		}
		if ( ! empty( $consumers ) ) {
			self::render( $format, $consumers, [ 'Reader', 'Source', 'Partition', 'Behind', 'Msgs' ] );
		}
	}

	/**
	 * One fleet-table row for a {topology, partition} slot.
	 *
	 * @param string                    $name Topology name.
	 * @param int                       $p    Partition.
	 * @param array<string, mixed>|null $w    Matching ls_workers() row, if any.
	 * @param int                       $now  Clock.
	 * @return array<string, int|string>
	 */
	private static function fleet_row( string $name, int $p, ?array $w, int $now ): array {
		$heartbeat_at = null === $w ? 0 : Core::as_int( $w['heartbeat_at'] );
		$started_at   = null === $w ? 0 : Core::as_int( $w['started_at'] );
		if ( null === $w ) {
			$state = 'down';
		} else {
			$state = $w['stale'] ? 'stale' : 'live';
		}
		return [
			'Topology'  => $name,
			'Partition' => $p,
			'State'     => $state,
			'Heartbeat' => $heartbeat_at > 0 ? CLI::format_duration( $now - $heartbeat_at ) . ' ago' : '-',
			'Uptime'    => $started_at > 0 ? CLI::format_duration( $now - $started_at ) : '-',
		];
	}

	/**
	 * Render rows via WP_CLI format_items, or a plain aligned dump without it.
	 *
	 * @param string                            $format  table|json|csv|yaml ('' = table).
	 * @param array<int, array<string, mixed>>  $rows    Table rows.
	 * @param array<int, string>                $columns Column order.
	 */
	private static function render( string $format, array $rows, array $columns ): void {
		if ( \function_exists( 'WP_CLI\\Utils\\format_items' ) ) {
			\WP_CLI\Utils\format_items( '' === $format ? 'table' : $format, $rows, $columns );
			return;
		}
		// Test fallback: stable plain-text lines.
		\WP_CLI::log( \implode( '  ', $columns ) );
		foreach ( $rows as $row ) {
			\WP_CLI::log( \implode( '  ', \array_map(
				static fn ( string $c ): string => Core::as_string( $row[ $c ] ?? '' ),
				$columns
			) ) );
		}
	}

	/**
	 * Read a string from a topology entry, coercing scalars exactly as `(string)` would.
	 *
	 * @param mixed  $entry Topology entry (array in practice; mixed per the filter contract).
	 * @param string $key   Key to read.
	 */
	private static function entry_string( $entry, string $key ): string {
		$value = \is_array( $entry ) ? ( $entry[ $key ] ?? '' ) : '';
		return Core::as_string( $value );
	}

	/**
	 * Activate a topology: add it to the active set and spawn its fleet now.
	 *
	 * The headless counterpart to the Settings → Topologies UI toggle. Validates
	 * the name against the catalog (`Topology_Registry::describe()`), then delegates
	 * the option-write + cache-invalidate + immediate spawn to the shared
	 * `Topology_Registry::activate()` (the same primitive the REST/UI verb calls).
	 * Idempotent — an already-active topology re-spawns without a duplicate entry.
	 *
	 * ## OPTIONS
	 *
	 * <topology>
	 * : Topology name to activate (a catalog name from `wp nodes types`).
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes activate request-builder
	 *
	 * @when after_wp_load
	 *
	 * @param array<int, string>   $args       Positional arguments.
	 * @param array<string, mixed> $assoc_args Associative arguments.
	 */
	public function activate( array $args, array $assoc_args ): void {
		$name = $this->require_catalog_topology( $args, 'activate' );

		try {
			$result = Topology_Registry::activate( $name );
		} catch ( \RuntimeException $e ) {
			\WP_CLI::error( $e->getMessage() );
			return;
		}

		\WP_CLI::success( \sprintf( "Activated '%s' and spawned %d worker(s).", $result['name'], $result['spawned'] ) );
	}

	/**
	 * Validate the positional `<topology>` arg against the catalog
	 * (`Topology_Registry::describe()`) — shared by `activate` and `deactivate`.
	 * `WP_CLI::error`s (which exits) on a missing or unknown-to-catalog name,
	 * listing the available catalog names so the operator can pick a real one.
	 *
	 * @param array<int, string> $args Positional arguments.
	 * @param string             $verb Verb name, for the usage message.
	 * @return string The validated topology name.
	 */
	private function require_catalog_topology( array $args, string $verb ): string {
		$name = $args[0] ?? '';
		if ( '' === $name ) {
			\WP_CLI::error( "Topology required. Use: wp nodes {$verb} <topology>" );
		}

		$catalog = \array_keys( Topology_Registry::describe() );
		if ( ! \in_array( $name, $catalog, true ) ) {
			\WP_CLI::error(
				\sprintf(
					'Unknown topology: %s. Available: %s',
					$name,
					empty( $catalog ) ? '(none in catalog)' : \implode( ', ', $catalog )
				)
			);
		}

		return $name;
	}

	/**
	 * Deactivate a topology: remove it from the active set and drain its fleet now.
	 *
	 * Symmetric with `activate`. Delegates to the shared
	 * `Topology_Registry::deactivate()` (the same primitive the REST/UI verb calls):
	 * remove the name, persist, invalidate the config cache, then drop a restart
	 * flag on every live worker lock dir so the fleet drains immediately.
	 *
	 * ## OPTIONS
	 *
	 * <topology>
	 * : Topology name to deactivate.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes deactivate request-builder
	 *
	 * @when after_wp_load
	 *
	 * @param array<int, string>   $args       Positional arguments.
	 * @param array<string, mixed> $assoc_args Associative arguments.
	 */
	public function deactivate( array $args, array $assoc_args ): void {
		$name = $this->require_catalog_topology( $args, 'deactivate' );

		Topology_Registry::deactivate( $name );

		\WP_CLI::success( \sprintf( "Deactivated '%s' and drained its fleet.", $name ) );
	}

	/**
	 * List active worker topology groups — the same set the supervisor will
	 * spawn (`Bootstrap::get_topologies()`), so this agrees with `wp nodes status`.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes types
	 *
	 * @when after_wp_load
	 *
	 * @param array<int, string>   $args       Positional arguments.
	 * @param array<string, mixed> $assoc_args Associative arguments.
	 */
	public function types( array $args, array $assoc_args ): void {
		$topologies = Bootstrap::get_topologies();

		if ( empty( $topologies ) ) {
			\WP_CLI::warning( 'No active topologies. Activate one via Settings → Nodes Runtime → Topologies, or add via the `newspack_nodes/topologies` filter.' );
			return;
		}

		\WP_CLI::log( 'Active topology groups:' );
		foreach ( $topologies as $name => $config ) {
			$partitions = self::entry_int( $config, 'num_partitions', 1 );
			$stale      = self::entry_int( $config, 'stale_timeout', Lock_Node::STALE_TIMEOUT );
			$path       = self::entry_string( $config, 'topology' );
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
	 *
	 * @param array<int, string>   $args       Positional arguments.
	 * @param array<string, mixed> $assoc_args Associative arguments.
	 */
	public function run( array $args, array $assoc_args ): void {
		$workers = $this->workers();
		$valid   = \array_unique( \array_column( $workers, 'type' ) );

		$type      = $args[0] ?? '';
		$partition = self::entry_int( $assoc_args, 'partition', 0 );
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
			if ( $w['type'] === $type && $w['partition'] === $partition ) {
				$descriptor = $w;
				break;
			}
		}
		if ( null === $descriptor ) {
			\WP_CLI::error( \sprintf( 'No worker registered for %s partition %d', $type, $partition ) );
		}

		// Resolve the TSL topology name; build a closure to run it.
		$topology_name = self::entry_string( $descriptor, 'topology' );
		if ( '' === $topology_name || null === Topology_Registry::resolve( $topology_name ) ) {
			\WP_CLI::error( 'Topology not found in registry: ' . $topology_name );
		}
		// `<config:…>` tokens resolve via the registered namespace resolver.
		$topology = static function (
			Command_Interpreter_Node $interpreter,
			int $partition_arg
		) use ( $topology_name ): void {
			Topology_Loader::load( $topology_name, $partition_arg, $interpreter );
		};

		if ( ! $quiet ) {
			\WP_CLI::log( \sprintf( 'Starting %s.p%d (direct mode, no spawn endpoint)...', $type, $partition ) );
		}

		// Bootstrap::supervisor() so the HMAC salt matches the runtime.
		$supervisor = Bootstrap::supervisor();

		$wb = new Worker_Base(
			$this->base_dir(),
			$type,
			$partition,
			stale_timeout: self::entry_int( $descriptor, 'stale_timeout', Lock_Node::STALE_TIMEOUT )
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
	 * Action handler (wired to `newspack_nodes/restart_fleet`): restart every
	 * partition of one fleet by topology name. Best-effort; unknown → no-op.
	 */
	public static function restart_fleet_by_name( string $name ): void {
		$workers = Bootstrap::expand_workers();
		$workers = \array_values( \array_filter(
			$workers,
			static fn ( $w ) => $w['type'] === $name
		) );
		if ( empty( $workers ) ) {
			return;
		}
		$base_dir = Config::get_base_directory();
		( new CLI( $base_dir ) )->restart_workers( $workers, [ $name => true ], -1 );
	}
}
