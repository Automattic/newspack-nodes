<?php
/**
 * Fleet: the peer-spawn scan every worker runs every 15 seconds.
 *
 * A worker whose lock dir is missing or whose heartbeat has gone stale is
 * spawned by whichever peer notices first; the spawn endpoint's
 * MIN_SPAWN_INTERVAL_S throttle deduplicates N scanners exactly as it already
 * deduplicated the worker / cron pair.
 *
 * Revival only. Housekeeping rides `Bootstrap::reconcile_fleet()` on the minute
 * cron, so it needs no live worker and no job pool.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * @phpstan-import-type Worker_Descriptor from Bootstrap
 */
class Fleet_Node extends Timer_Node {
	use Schema_Reflection;

	/**
	 * @longform Scan cadence, and so also the topology (de)activation latency.
	 * Not the router tick: a missing lock dir is the only case a faster scan
	 * reaches sooner, and a crashed worker's queue is durable, so that lag costs
	 * nothing. The stale-heartbeat case is dominated by the topology's
	 * stale_timeout (60s default) either way. Fifteen seconds is 15x fewer
	 * glob/stat passes per worker, times every worker.
	 */
	public const SCAN_INTERVAL_MS = 15000;

	/**
	 * @longform Ceiling on spawn POSTs per pass. Each is a BLOCKING curl capped
	 * at Core::POST_TIMEOUT_MS, and unlike the cron reconciliation pass — which
	 * has a process to itself — this runs inside a worker's drain loop, so every
	 * POST is time stolen from message processing. A cold fleet spreads its
	 * spawns over consecutive passes instead of stalling one; the uncapped cron
	 * pass is what revives a large fleet in one go.
	 */
	public const MAX_SPAWNS_PER_TICK = 4;

	/** Defer the first spawn of a newly-appeared type so a still-exiting predecessor can flush. */
	public const NEW_TYPE_SPAWN_DELAY_SCANS = 1;

	/** Runtime state root; locks/ lives under it. Assigned by parse_schema_args. */
	private string $base_dir = '';

	/** Spawn coordination: lock paths, staleness, the shared spawn throttle. */
	private ?Spawn_Coordinator $coordinator = null;

	/** This worker's own lock dir, where its reload watermark lands. Assigned by parse_schema_args. */
	private string $lock_dir = '';

	/** The reload watermark last acted on; '' = none seen yet. */
	private string $last_reload_token = '';

	/** @var array<string,float> type => earliest timestamp at which a spawn is allowed. */
	private array $spawn_after = [];

	/** @var array<int,Worker_Descriptor> The active fleet, as of the last check. */
	private array $workers = [];

	/**
	 * @param list<string>|null $args [ base_dir, lock_dir ].
	 * @return list<string>
	 */
	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return $this->arguments;
		}
		// Refuses a missing base_dir / lock_dir at the boundary (ADR-11).
		$this->parse_schema_args( $args );
		$this->base_dir = \rtrim( $this->base_dir, '/' );
		$this->lock_dir = \rtrim( $this->lock_dir, '/' );
		// @longform The salt is resolved INSIDE the coordinator, never carried
		// as a node argument: `arguments()` is what `dump_config` serializes
		// and `dump_metadata` returns, and `redact_secrets()` cannot mask a
		// bare positional.
		$this->coordinator = new Spawn_Coordinator( $this->base_dir );
		// Router-hitchhiked; Timer_Node throttles it down to SCAN_INTERVAL_MS.
		$this->set_timer( self::SCAN_INTERVAL_MS );
		return $this->arguments;
	}

	/**
	 * One scan. Everything below runs third-party code — `expand_workers()` fires
	 * the `newspack_nodes/topologies` filter — so nothing may escape: an uncaught
	 * throw here unwinds through Router into Worker_Base, which catches only
	 * Worker_Should_Stop. Every worker reads the same config on the same cadence,
	 * so one bad provider would crash-loop the whole fleet in lockstep.
	 */
	protected function fire(): void {
		$this->notify( 'FIRE', Core::$now );
		if ( '' === $this->base_dir || ! Bootstrap::is_fleet_enabled() ) {
			return;
		}
		try {
			$this->scan( Core::$now );
		} catch ( Worker_Should_Stop $e ) {
			throw $e; // ADR-14: a cooperative stop is not an error.
		} catch ( \Throwable $e ) {
			$this->print_less_often( 'fleet scan failed: ', $e->getMessage() );
		}
	}

	/**
	 * Spawn every active-fleet worker whose lock reads as down, bounded per pass.
	 *
	 * The list is what this node computes; posting it is the coordinator's ONE
	 * spawn loop, which owns the throttle, the local record and the
	 * write-conflict refusal. The throttle is consulted here too so a worker a
	 * peer already spawned costs no slot of the per-tick cap.
	 */
	private function scan( float $now ): void {
		$coordinator = $this->coordinator;
		if ( null === $coordinator ) {
			return;
		}
		$this->refresh_active_set( $coordinator, $now );
		$due = [];
		foreach ( $this->workers as $worker ) {
			if ( \count( $due ) >= self::MAX_SPAWNS_PER_TICK ) {
				break;
			}
			if ( ! $coordinator->worker_needs_spawn( $worker, $now ) ) {
				continue;
			}
			if ( $this->is_deferred( $worker['type'], $now ) ) {
				continue;
			}
			if ( $coordinator->is_recently_spawned( $worker['type'], $worker['partition'], $now ) ) {
				continue;
			}
			$due[] = $worker;
		}
		$coordinator->spawn_each( $due, 'spawn failed', $now );
	}

	/** True while a newly-appeared type is still inside its post-detect delay. */
	private function is_deferred( string $type, float $now ): bool {
		$until = $this->spawn_after[ $type ] ?? 0.0;
		if ( $until <= 0.0 ) {
			return false;
		}
		if ( $now < $until ) {
			return true;
		}
		unset( $this->spawn_after[ $type ] );
		return false;
	}

	/**
	 * Re-read the active fleet, resetting Config only when a reload watermark
	 * says the cached copy is stale.
	 *
	 * The reset is not free: it fires `Config::RESET_ACTION`, whose subscribers
	 * drop the parsed-TSL cache, so every worker re-globs both topology dirs and
	 * re-parses every `.tsl` on the next `expand_workers()`. Unconditionally,
	 * that is once per pass per worker to reach the identical answer — the
	 * watermark IS the signal that makes the OPTION cache stale, so without one
	 * there is no option to re-read. The other two RESET_ACTION subscribers read
	 * DISK, not options, so an edited `.tsl` or a new logs dir is now picked up
	 * on the next recycle rather than within 15s — deploys already end in
	 * `wp nodes restart`. `expand_workers()` stays unconditional: it is the
	 * scan's input, not a poll.
	 *
	 * @param Spawn_Coordinator $coordinator Owns the locks/ layout drain_all_workers walks.
	 * @param float             $now         Tick clock.
	 */
	private function refresh_active_set( Spawn_Coordinator $coordinator, float $now ): void {
		// @longform Purge, reset, THEN announce: a subscriber reading inline
		// must see the config the reload delivers, not the boot values.
		// `notify()`, not `set_state()` — a node built after a reload already
		// read current config, so replaying the event at it is a pointless
		// re-read. String payload: TM_INFO VALUEs are flat strings.
		$watermark = $this->take_reload_watermark();
		if ( '' !== $watermark ) {
			// The shared definition: a hand-rolled subset went stale for ~595s.
			Topology_Registry::invalidate_config_cache();
			$this->notify( 'RELOAD', $watermark );
		}

		// @longform OBSERVED, never assumed: a first check reading empty is a
		// cold start, not a deactivation, and must not retire the fleet.
		$had_workers = ! empty( $this->workers );
		$workers     = Bootstrap::expand_workers();

		if ( empty( $workers ) ) {
			if ( $had_workers ) {
				$this->drain_all_workers( $coordinator );
			}
			$this->workers = [];
			return;
		}

		if ( $had_workers ) {
			$known = \array_flip( \array_column( $this->workers, 'type' ) );
			foreach ( $workers as $worker ) {
				if ( ! isset( $known[ $worker['type'] ] ) ) {
					$this->spawn_after[ $worker['type'] ] ??= $now + ( self::NEW_TYPE_SPAWN_DELAY_SCANS * self::SCAN_INTERVAL_MS / 1000.0 );
				}
			}
		}
		$this->workers = $workers;
	}

	/**
	 * Read this worker's reload watermark. Returns the watermark to announce, or
	 * '' for nothing to do; the caller purges through the shared definition.
	 *
	 * Consumed by CONTENT, never by mtime and never by unlinking. Mtime resolves
	 * to a second and a settings save writes several options in one request, so
	 * a second request inside that second would be lost, not merely late; an
	 * unlink-after-consume loses a request that lands mid-reload, and a
	 * comparison survives a lock steal.
	 */
	private function take_reload_watermark(): string {
		if ( '' === $this->lock_dir ) {
			return '';
		}
		$flag = $this->lock_dir . '/' . Lock_Node::RELOAD_FLAG;
		\clearstatcache( true, $flag );
		// phpcs:ignore WordPressVIPMinimum.Performance.FetchingRemoteData.FileGetContentsUnknown -- Operator storage, never remote.
		$token = \is_file( $flag ) ? (string) @\file_get_contents( $flag ) : '';
		if ( '' === $token || $token === $this->last_reload_token ) {
			return '';
		}
		$this->last_reload_token = $token;
		return $token;
	}

	/**
	 * Retire every running worker when the last topology is deactivated. The
	 * restart channel, not force_release: a flagged worker exits on its own
	 * should_continue(), and its self-respawn is refused because the type is no
	 * longer in the active set. The `.p<N>` shape is what identifies a worker.
	 *
	 * @param Spawn_Coordinator $coordinator Owns the locks/ layout; a hand-rolled walk drifted.
	 */
	private function drain_all_workers( Spawn_Coordinator $coordinator ): void {
		foreach ( \array_keys( $coordinator->worker_lock_dirs() ) as $path ) {
			if ( \file_exists( $path . '/' . Lock_Node::RESTART_FLAG ) ) {
				continue; // Already flagged — avoid disk churn.
			}
			Lock_Node::request_restart_at( $path );
		}
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'      => 'Hidden',
			'hidden'        => true,
			'description'   => 'Peer-spawn scan: revives fleet workers whose lock is missing or stale.',
			'arguments'     => [
				[ 'name' => 'base_dir', 'type' => 'string', 'required' => true, 'description' => 'Runtime state root holding locks/.' ],
				[ 'name' => 'lock_dir', 'type' => 'string', 'required' => true, 'description' => 'This worker\'s own lock dir, watched for the reload watermark.' ],
			],
			'registrations' => [ 'FIRE', 'RELOAD' ],
		] );
	}
}
