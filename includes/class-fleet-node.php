<?php
/**
 * Fleet: the peer-spawn scan every worker runs every 15 seconds.
 *
 * A worker whose lock dir is missing or whose heartbeat has gone stale is
 * spawned by whichever peer notices first, an on-demand worker asleep by design
 * excepted. The spawn endpoint's `Spawn_Coordinator::MIN_SPAWN_INTERVAL_S`
 * throttle is what makes N scanners as safe as one: that endpoint is the single
 * gate every spawn path crosses, self-respawn and cron included.
 *
 * Revival only. Housekeeping rides `Bootstrap::reconcile_fleet()` on the minute
 * cron, so it needs no live worker and no job pool.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * The `_fleet` node `Worker_Base::build_scaffolding()` mounts in every worker:
 * the peer scan in ADR-9's two-tier safety net. It revives PEERS — this
 * worker's own succession belongs to `Worker_Base::execute()`'s `finally`, and
 * a fleet with nothing left running waits for the WP-Cron pass.
 *
 * @phpstan-import-type Worker_Descriptor from Bootstrap
 */
class Fleet_Node extends Timer_Node {
	use Schema_Reflection;

	/**
	 * Scan cadence, and so also how long a live worker takes to act on a reload
	 * watermark. Not the router tick: a missing lock dir is the only case a
	 * faster scan reaches sooner, and a crashed worker's queue is durable, so
	 * that lag costs nothing. The stale-heartbeat case is dominated by the
	 * topology's stale_timeout (60s default) either way. Fifteen seconds is 15x
	 * fewer glob/stat passes per worker, times every worker.
	 */
	public const SCAN_INTERVAL_MS = 15000;

	/**
	 * Ceiling on spawn POSTs per pass. Each is a BLOCKING curl capped at
	 * `Core::SPAWN_POST_TIMEOUT_MS` (250ms), and unlike the cron pass — which
	 * has a process to itself — this runs inside a worker's drain loop, so
	 * every POST is time stolen from message processing. A cold fleet spreads
	 * its spawns over consecutive passes instead of stalling one; the uncapped
	 * cron pass is what revives a large fleet in one go.
	 */
	public const MAX_SPAWNS_PER_TICK = 4;

	/**
	 * Scans to wait before the first spawn of a newly-appeared type, so a
	 * still-exiting predecessor can flush. A cold start skips the wait:
	 * `refresh_active_set()` defers only against a set it has already read, and
	 * a first pass has none to compare against.
	 */
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
	 * Take the `make_node Fleet _fleet <base_dir> <lock_dir>` tokens, build the
	 * coordinator and arm the scan; null reads the tokens back. The timer is
	 * armed here, never in the constructor: the Router hitchhike is name-keyed,
	 * and ADR-11's sequence names the node after the no-arg constructor has
	 * already returned.
	 *
	 * @param list<string>|null $args [ base_dir, lock_dir ].
	 * @return list<string> The tokens as stored.
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
		// as a node argument: `dump_node` reflects `$this->arguments` whole,
		// and `redact_secrets()` masks a `--name=value` token, never a bare
		// positional.
		$this->coordinator = new Spawn_Coordinator( $this->base_dir );
		// Router-hitchhiked; Timer_Node throttles it down to SCAN_INTERVAL_MS.
		$this->set_timer( self::SCAN_INTERVAL_MS );
		return $this->arguments;
	}

	/**
	 * One scan. It reaches third-party code — `expand_workers()` fires the
	 * `newspack_nodes/topologies` filter, and a reload fires
	 * `Config::RESET_ACTION` — so nothing may escape: an uncaught throw here
	 * unwinds through Router into Worker_Base, which catches only
	 * Worker_Should_Stop. Every worker reads the same config on the same cadence,
	 * so one bad provider would crash-loop the whole fleet in lockstep.
	 *
	 * The scan sends nothing to its sink. `FIRE` and `RELOAD` are its whole
	 * output: a closure subscriber takes the payload directly, and one
	 * registered by NAME would take it as a TM_INFO message. `FIRE` precedes
	 * both guards below, so a node holding no `base_dir`, and one the
	 * `Bootstrap::is_fleet_enabled()` switch has turned off, announce the tick
	 * and scan nothing. That notice sits outside the catch as well: a `FIRE`
	 * subscriber that throws escapes into the Router.
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
	 *
	 * Down is `Spawn_Coordinator::worker_needs_spawn()`'s judgement, not a
	 * missing directory: a cleanly absent on-demand worker is scaled to zero,
	 * and a producer's write wakes it.
	 *
	 * @param float $now Pass clock, so one pass judges every worker alike.
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

	/**
	 * True while a newly-appeared type is still inside its post-detect delay.
	 * An expired entry is dropped on the way past, so the map holds only the
	 * types still waiting.
	 *
	 * @param string $type Worker type.
	 * @param float  $now  Pass clock.
	 */
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
	 * drop the parsed-TSL cache, so every worker re-parses every `.tsl` the
	 * catalog filter finds on the next `expand_workers()`. Unconditionally,
	 * that is once per pass per worker to reach the identical answer — the
	 * watermark IS the signal that makes the OPTION cache stale, so without one
	 * there is no option to re-read. `Vault::reset()` rides the same gate,
	 * because a vault save writes a watermark of its own through
	 * `Bootstrap::reload_vault_consumers()`. What the gate costs is DISK
	 * freshness: an edited `.tsl` or a new logs dir waits for the next recycle
	 * rather than 15 seconds, and deploys end in `wp nodes restart`.
	 * `expand_workers()` stays unconditional: it is the scan's input, not a
	 * poll.
	 *
	 * @param Spawn_Coordinator $coordinator Forwarded to `drain_all_workers()`, which walks the locks/ layout it owns.
	 * @param float             $now         Pass clock, so one pass dates every deferral alike.
	 */
	private function refresh_active_set( Spawn_Coordinator $coordinator, float $now ): void {
		// @longform Purge, reset, THEN announce: a subscriber reading inline
		// must see the config the reload delivers, not the boot values.
		// `notify()`, not `set_state()` — a node built after a reload already
		// read current config, so replaying the event at it is a pointless
		// re-read. String payload: TM_INFO VALUEs are flat strings.
		$watermark = $this->take_reload_watermark();
		if ( '' !== $watermark ) {
			// The shared definition: a hand-rolled subset leaves a memo stale.
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
	 * longer in the active set.
	 *
	 * @param Spawn_Coordinator $coordinator Owns the `{type}.p{N}.lock.d` layout, so this walk cannot drift from the writer.
	 */
	private function drain_all_workers( Spawn_Coordinator $coordinator ): void {
		foreach ( \array_keys( $coordinator->worker_lock_dirs() ) as $path ) {
			if ( \file_exists( $path . '/' . Lock_Node::RESTART_FLAG ) ) {
				continue; // Already flagged — avoid disk churn.
			}
			Lock_Node::request_restart_at( $path );
		}
	}

	/**
	 * Hidden from the palette and the console: `build_scaffolding()` mounts this
	 * node as `_fleet` in every worker, so no topology and no operator ever
	 * names it. The two arguments are `required` because ADR-11 refuses a
	 * missing one at construction, and a fleet scanning a derived path would
	 * quietly revive nothing.
	 *
	 * @return array<string,mixed>
	 */
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
