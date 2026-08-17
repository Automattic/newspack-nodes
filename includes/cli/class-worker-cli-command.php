<?php
/**
 * WorkerCliCommand: WP-CLI subcommands for worker lifecycle management.
 *
 * Adds `wp nodes types` / `run <type>` / `restart <type>` / `status` beyond the
 * existing `ls` / `cli`. Live positions come from the shared Topic_Probe log
 * (via `CLI::consumer_rows()`), not memcache.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Worker_CLI_Command {

	/** Default seconds `stop` waits for the fleet to go quiet. */
	public const STOP_TIMEOUT_S = 90;

	/** Seconds between lock-dir polls while `stop` waits. */
	private const STOP_POLL_S = 1;

	/**
	 * Poll-sleep seam. Lazily defaulted to a real `sleep()`; tests reassign it to
	 * drive the wait deterministically (and to simulate workers exiting) without
	 * short-circuiting the surrounding poll/report logic.
	 *
	 * Signature: `function ( int $seconds ): void`.
	 *
	 * @var \Closure|null
	 */
	public static ?\Closure $sleep = null;

	/**
	 * Slots whose stop-flag write was refused; kept so the warning is not
	 * repeated on every poll.
	 *
	 * @var array<int,string>
	 */
	private array $refused_flags = [];

	/**
	 * Stop the fleet and HOLD it down, so a deploy can replace `includes/` with
	 * no worker running against the half-swapped directory.
	 *
	 * Sets the persisted hold every spawn path checks, flags each live worker to
	 * exit, then BLOCKS until every lock dir is gone. Exits non-zero naming the
	 * stragglers if the wait expires, so a deploy script can branch on it.
	 *
	 * The fleet stays down until `wp nodes start`.
	 *
	 * ## OPTIONS
	 *
	 * [--timeout=<seconds>]
	 * : How long to wait for a clean shutdown. Default 90 — long enough for a
	 * job worker to finish the handler it is inside.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes stop && ./deploy.sh && wp nodes start
	 *
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional arguments (unused).
	 * @param array<string,mixed> $assoc_args --timeout.
	 */
	public function stop( array $args, array $assoc_args ): void {
		unset( $args );
		$timeout = CLI::require_flag_int( $assoc_args, 'timeout', self::STOP_TIMEOUT_S );

		// Hold FIRST, or a worker flagged before it respawns itself.
		Spawn_Coordinator::set_hold( \time() );
		\WP_CLI::log( 'Held the fleet; waiting for workers to exit.' );

		if ( null === Core::$memd ) {
			\WP_CLI::warning(
				'No Memcached: the in-flight-spawn check cannot see timestamps written by '
				. 'PHP-FPM (APCu does not span SAPIs), so a worker mid-boot may go unnoticed.'
			);
		}

		$sleep    = self::$sleep ?? static fn ( int $seconds ) => \sleep( $seconds );
		$deadline = \time() + $timeout;
		do {
			$this->flag_held_workers();
			$blockers = $this->stop_blockers();
			if ( empty( $blockers ) ) {
				\WP_CLI::success( 'Fleet stopped. Run `wp nodes start` when the deploy is done.' );
				return;
			}
			$sleep( self::STOP_POLL_S );
		} while ( \time() < $deadline );

		// Re-read after the last sleep; the verdict predated it.
		$blockers = $this->stop_blockers();
		if ( empty( $blockers ) ) {
			\WP_CLI::success( 'Fleet stopped. Run `wp nodes start` when the deploy is done.' );
			return;
		}
		\WP_CLI::error(
			'Timed out after ' . $timeout . 's; still up: ' . \implode( ', ', $blockers )
			. '. The fleet stays HELD — run `wp nodes start` to release it.'
		);
	}

	/**
	 * What still stands between us and a quiet fleet: held lock dirs, plus any
	 * slot with a spawn already in flight.
	 *
	 * The in-flight check is what stops `stop` reporting success into a gap. A
	 * worker that released its lock and POSTed its own respawn microseconds
	 * before the hold landed has no lock dir while it bootstraps — so a naive
	 * "no dirs" test says stopped, the deploy swaps `includes/`, and the
	 * successor acquires and runs against a half-swapped directory. The
	 * coordinator's own spawn throttle already records exactly that window.
	 *
	 * Presence, not staleness, decides a dir: a worker mid-job stops
	 * heartbeating long before it exits, and calling it gone is the one lie this
	 * command must never tell.
	 *
	 * @return array<int,string>
	 */
	private function stop_blockers(): array {
		$blockers = \array_keys( $this->held_lock_dirs() );
		$fleet    = Bootstrap::spawn_coordinator();
		$now      = Core::right_now();
		foreach ( $this->workers() as $w ) {
			$type = $w['type'];
			$p    = $w['partition'];
			if ( $fleet->is_recently_spawned( $type, $p, $now ) ) {
				$blockers[] = "{$type}.p{$p} (spawn in flight)";
			}
		}
		return $blockers;
	}

	/**
	 * Flag every held lock to stop, warning about any write that was REFUSED.
	 *
	 * Re-run each pass so a worker that acquired mid-wait is told too. A refusal
	 * is the documented ownership footgun (worker dirs owned by `bend`, the
	 * command run as root); silently flagging nothing spins the whole timeout and
	 * then blames the workers for not exiting.
	 */
	private function flag_held_workers(): void {
		$refused = [];
		foreach ( $this->held_lock_dirs() as $slot => $dir ) {
			if ( ! Lock_Node::request_stop_at( $dir ) ) {
				$refused[] = $slot;
			}
		}
		if ( ! empty( $refused ) && $refused !== $this->refused_flags ) {
			$this->refused_flags = $refused;
			\WP_CLI::warning( 'could not write the stop flag for: ' . \implode( ', ', $refused ) );
		}
	}

	/**
	 * Release the deploy hold and spawn the fleet.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes start
	 *
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional arguments (unused).
	 * @param array<string,mixed> $assoc_args Associative arguments (unused).
	 */
	public function start( array $args, array $assoc_args ): void {
		unset( $args, $assoc_args );
		Spawn_Coordinator::clear_hold();
		// A straggler that outlasted `stop` still carries its flag.
		foreach ( $this->held_lock_dirs() as $dir ) {
			Lock_Node::clear_stop_at( $dir );
		}
		// Counts ATTEMPTS: a fire-and-forget POST reports no outcome.
		$requested = Bootstrap::spawn_coordinator()->spawn_due_workers( Core::right_now() );
		\WP_CLI::success(
			"Hold released; requested {$requested} worker spawn(s). "
			. 'Run `wp nodes status` to confirm the fleet came back.'
		);
	}

	/**
	 * Every `.lock.d` under the locks dir, keyed by its `type.pN` slot.
	 *
	 * Read from DISK rather than derived from the active topology set: a worker
	 * whose topology was deactivated, or whose partition index is above the
	 * current `num_partitions`, still holds a real lock and still runs until
	 * `reconcile_lock_dirs()` retires it a full lifetime later.
	 *
	 * @return array<string,string> slot => directory path.
	 */
	private function held_lock_dirs(): array {
		$dirs = [];
		foreach ( (array) \glob( $this->base_dir() . '/locks/*.lock.d', \GLOB_ONLYDIR ) as $path ) {
			$dirs[ \basename( Core::as_string( $path ), '.lock.d' ) ] = Core::as_string( $path );
		}
		return $dirs;
	}

	/**
	 * Request a worker restart by writing a `restart` flag into its lock dir.
	 *
	 * The current holder polls `restart_reason()` from its drain loop and exits
	 * cleanly; its self-respawn (or a peer's scan) starts a fresh process.
	 *
	 * ## OPTIONS
	 *
	 * <target>
	 * : Worker type to restart, or `all` for all worker types.
	 *
	 * [--partition=<partition>]
	 * : Restrict to one partition (0-based). Every partition of the matched
	 * worker type(s) restarts by default — a type is a fleet, and restarting
	 * one of six leaves five running the old code.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes restart firehose-workers
	 *     wp nodes restart firehose-workers --partition=0
	 *     wp nodes restart all
	 *
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associative arguments.
	 */
	public function restart( array $args, array $assoc_args ): void {
		$target = $args[0] ?? '';
		if ( '' === $target ) {
			\WP_CLI::error( 'Restart target required. Use: wp nodes restart <target>' );
		}
		$workers = $this->workers();
		$valid   = \array_unique( \array_column( $workers, 'type' ) );
		// -1 means every partition, which is the default.
		$partition = CLI::require_flag_int( $assoc_args, 'partition', -1 );

		if ( 'all' !== $target && ! \in_array( $target, $valid, true ) ) {
			$available = \array_merge( $valid, [ 'all' ] );
			\WP_CLI::error( 'Invalid restart target: ' . $target . '. Available: ' . \implode( ', ', $available ) );
		}

		$filter    = ( 'all' === $target ) ? [] : [ $target => true ];
		$cli       = $this->cli();
		$restarted = $cli->restart_workers( $workers, $filter, $partition );

		\WP_CLI::success( "Requested restart for {$restarted} worker(s)." );
	}

	/**
	 * Fleet overview: every catalog topology with per-partition worker state
	 * (live/stale/down from the lock heartbeats, plus uptime from the lock-dir
	 * age), then the consumer-lag table from the Topic_Probe snapshot.
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
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associative arguments.
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
			// The count the fleet spawns against; floors at 1.
			$partitions     = Bootstrap::num_partitions_for( $name );
			$on_demand_idle = Bootstrap::on_demand_idle_of( Core::arr( $config ) );
			for ( $p = 0; $p < $partitions; $p++ ) {
				$rows[] = self::fleet_row( $name, $p, $locks[ "{$name}.p{$p}" ] ?? null, $now, $on_demand_idle );
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
					'Worker'    => $name,
					'State'     => 'inactive',
					'Heartbeat' => '-',
					'Uptime'    => '-',
				];
			}
		}

		// One row per active Consumer, sorted (probe order = arrival order).
		$consumers = [];
		foreach ( $this->cli()->consumer_rows() as $cr ) {
			$consumers[] = [
				'Reader'    => $cr['reader'],
				'Source'    => $cr['source'],
				'Partition' => $cr['partition'],
				'Behind'    => CLI::format_bytes( $cr['distance'] ),
				'Msgs/int'  => $cr['msgs'],
			];
		}
		\usort(
			$consumers,
			static fn ( array $a, array $b ): int =>
				[ $a['Reader'], $a['Source'], $a['Partition'] ]
				<=> [ $b['Reader'], $b['Source'], $b['Partition'] ]
		);

		if ( empty( $rows ) && empty( $consumers ) ) {
			\WP_CLI::warning( 'No topologies registered or running. base_dir=' . $this->base_dir() );
			return;
		}
		$format = self::entry_string( $assoc_args, 'format' );
		if ( ! empty( $rows ) ) {
			self::render( $format, $rows, [ 'Worker', 'State', 'Heartbeat', 'Uptime' ] );
		}
		if ( ! empty( $consumers ) ) {
			self::render( $format, $consumers, [ 'Reader', 'Source', 'Partition', 'Behind', 'Msgs/int' ] );
		}
		if ( '' === $format ) {
			\WP_CLI::log( 'Attach a REPL to a live worker with: wp nodes cli <Worker>' );
		}
	}

	/**
	 * Render rows via WP_CLI format_items, or a plain aligned dump without it.
	 *
	 * @param string                            $format  table|json|csv|yaml ('' = table).
	 * @param array<int,array<string,mixed>>  $rows    Table rows.
	 * @param array<int,string>                $columns Column order.
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
	 * One fleet-table row for a {topology, partition} slot.
	 *
	 * @param string                    $name           Topology name.
	 * @param int                       $p              Partition.
	 * @param array<string,mixed>|null $w              Matching liveness row, if any.
	 * @param int                       $now            Clock.
	 * @param int                       $on_demand_idle Whether the topology scales to zero when idle.
	 * @return array<string,int|string>
	 */
	private static function fleet_row( string $name, int $p, ?array $w, int $now, int $on_demand_idle = 0 ): array {
		$heartbeat_at = null === $w ? 0 : Core::as_int( $w['heartbeat_at'] );
		$started_at   = null === $w ? 0 : Core::as_int( $w['started_at'] );
		if ( null === $w ) {
			// A held or on-demand slot with no lock is waiting, not broken.
			if ( Spawn_Coordinator::hold() > 0 ) {
				$state = 'held';
			} else {
				$state = $on_demand_idle > 0 ? 'idle' : 'down';
			}
		} else {
			$state = $w['stale'] ? 'stale' : 'live';
		}
		return [
			'Worker'    => "{$name}.p{$p}",
			'State'     => $state,
			'Heartbeat' => $heartbeat_at > 0 ? CLI::format_duration( $now - $heartbeat_at ) . ' ago' : '-',
			'Uptime'    => $started_at > 0 ? CLI::format_duration( $now - $started_at ) : '-',
		];
	}

	/**
	 * Helper for command implementations to reach the same Cli helper without
	 * recreating it every time.
	 */
	private function cli(): CLI {
		return new CLI( $this->base_dir() );
	}

	/**
	 * Activate a topology: add it to the active set and spawn its fleet now.
	 *
	 * The headless counterpart to the Nodes hub's active toggle (the Overview and
	 * Topologies tabs share one TopologyControls cluster). Validates
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
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associative arguments.
	 */
	public function activate( array $args, array $assoc_args ): void {
		Bootstrap::ensure_runtime_wired();
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
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associative arguments.
	 */
	public function deactivate( array $args, array $assoc_args ): void {
		Bootstrap::ensure_runtime_wired();
		$name = $this->require_catalog_topology( $args, 'deactivate' );

		Topology_Registry::deactivate( $name );

		\WP_CLI::success( \sprintf( "Deactivated '%s' and drained its fleet.", $name ) );
	}

	/**
	 * Validate the positional `<topology>` arg against the catalog
	 * (`Topology_Registry::describe()`) — shared by `activate` and `deactivate`.
	 * `WP_CLI::error`s (which exits) on a missing or unknown-to-catalog name,
	 * listing the available catalog names so the operator can pick a real one.
	 *
	 * @param array<int,string> $args Positional arguments.
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
	 * List the active worker topology groups the fleet spawns
	 * (`Bootstrap::get_topologies()`), so this agrees with `wp nodes status`.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes types
	 *
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associative arguments.
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
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associative arguments.
	 */
	public function run( array $args, array $assoc_args ): void {
		// Same footgun as `cli`: root-owned IPC/locks lock out the web user.
		CLI::refuse_root( 'run' );

		$workers = $this->workers();
		$valid   = \array_unique( \array_column( $workers, 'type' ) );

		$type      = $args[0] ?? '';
		$partition = CLI::require_flag_int( $assoc_args, 'partition', 0 );

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

		\WP_CLI::log( \sprintf( 'Starting %s.p%d (direct mode, no spawn endpoint)...', $type, $partition ) );

		// Bootstrap::spawn_coordinator() so the HMAC salt matches the runtime.
		$coordinator = Bootstrap::spawn_coordinator();

		$entry = Core::arr( $descriptor );
		$wb    = new Worker_Base(
			$this->base_dir(),
			$type,
			$partition,
			stale_timeout: self::entry_int( $descriptor, 'stale_timeout', Lock_Node::STALE_TIMEOUT ),
			on_demand_idle: Bootstrap::on_demand_idle_of( $entry )
		);

		$spawn_url = \function_exists( 'rest_url' )
			? \rest_url( 'newspack-nodes/v1/workers/spawn' )
			: '';
		$token     = $coordinator->generate_spawn_token( \time() );

		$result = $wb->execute( $topology, $spawn_url, $token );
		// The debugging verb: the skip reason IS the diagnosis — print it.
		$detail = Core::as_string( $result['reason'] ?? $result['error'] ?? '' );
		\WP_CLI::success( 'Worker exited with status: ' . $result['status'] . ( '' !== $detail ? " ({$detail})" : '' ) );
	}

	/**
	 * Read an int from a topology entry, coercing scalars exactly as `(int)` would.
	 *
	 * Topology entries come from the `newspack_nodes/topologies` filter, not from
	 * the operator — a malformed one must not take down an unrelated listing, so
	 * this keeps the silent default. Operator flags go through
	 * `CLI::require_flag_int()`.
	 *
	 * @param mixed  $entry    Topology entry (array in practice; mixed per the filter contract).
	 * @param string $key      Key to read.
	 * @param int    $fallback Default when missing/non-scalar.
	 */
	private static function entry_int( $entry, string $key, int $fallback ): int {
		$value = \is_array( $entry ) ? ( $entry[ $key ] ?? $fallback ) : $fallback;
		return Core::as_int( $value, $fallback );
	}

	private function base_dir(): string {
		return Config::get_base_directory();
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
	 * Expand topologies registered via the `newspack_nodes/topologies` filter
	 * into a flat list of `{type, partition, stale_timeout}` rows.
	 *
	 * @return array<int,array{type: string,partition: int,topology: mixed,stale_timeout: mixed}>
	 */
	private function workers(): array {
		return Bootstrap::expand_workers();
	}

	/**
	 * Sweep orphan log + offsetlog dirs now, instead of waiting for the sweep job.
	 *
	 * A dir is an orphan when no ACTIVE topology declares it — so deactivating a
	 * topology is what orphans its data, not stopping its workers. The fleet
	 * sweep already runs this every window, but spares any dir written
	 * within the last hour so a mid-deploy blip cannot eat live data. `--force`
	 * drops that wait to zero: use it to reclaim a topology you just tore down.
	 *
	 * ## OPTIONS
	 *
	 * [--force]
	 * : Sweep orphans however recently they were written.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes gc
	 *     wp nodes gc --force
	 *
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associative arguments.
	 */
	public function gc( array $args, array $assoc_args ): void {
		Bootstrap::ensure_runtime_wired();
		$force = ! empty( $assoc_args['force'] );

		$deleted = Log_Cleaner::cleanup_orphan_partitions(
			Config::get_base_directory(),
			$force ? 0 : Log_Cleaner::DELETE_GRACE_S
		);

		if ( empty( $deleted ) ) {
			\WP_CLI::success(
				$force
					? 'No orphan dirs to sweep.'
					: \sprintf(
						'No orphan dirs past the %ds grace. Re-run with --force to sweep regardless.',
						Log_Cleaner::DELETE_GRACE_S
					)
			);
			return;
		}

		foreach ( $deleted as $path ) {
			\WP_CLI::log( "  removed {$path}" );
		}
		\WP_CLI::success( \sprintf( 'Swept %d orphan dir(s).', \count( $deleted ) ) );
	}

	/**
	 * Render the canonical Nodes health report. The cache result
	 * comes from a bounded web-runtime probe; environment and fleet results are
	 * evaluated locally. Recommendations warn; critical results exit non-zero.
	 *
	 * ## EXAMPLES
	 *
	 *     wp nodes doctor
	 *
	 * @when after_wp_load
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associative arguments.
	 */
	public function doctor( array $args, array $assoc_args ): void {
		$results  = Health_Checks::evaluate( Health_Probe_Client::cache_backend() );
		$warnings = 0;
		$failures = 0;
		foreach ( $results as $result ) {
			$marker = match ( $result['status'] ) {
				Health_Checks::STATUS_GOOD => 'ok  ',
				Health_Checks::STATUS_RECOMMENDED => 'WARN',
				Health_Checks::STATUS_CRITICAL => 'FAIL',
			};
			if ( Health_Checks::STATUS_RECOMMENDED === $result['status'] ) {
				++$warnings;
			} elseif ( Health_Checks::STATUS_CRITICAL === $result['status'] ) {
				++$failures;
			}
			\WP_CLI::log( "{$marker} {$result['id']} — {$result['messages'][0]}" );
			foreach ( \array_slice( $result['messages'], 1 ) as $message ) {
				\WP_CLI::log( "     {$message}" );
			}
		}

		$total = \count( $results );
		if ( 0 < $failures ) {
			\WP_CLI::error( "{$failures} of {$total} Nodes health checks failed." );
		}
		if ( 0 < $warnings ) {
			\WP_CLI::warning( "{$warnings} of {$total} Nodes health checks need attention." );
			return;
		}
		\WP_CLI::success( "All {$total} Nodes health checks passed." );
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
