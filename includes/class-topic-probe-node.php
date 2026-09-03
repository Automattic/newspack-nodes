<?php
/**
 * Topic_Probe: the Consumer-stats sweep. See Probe_Node for the sweep itself.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Topic_Probe: the Consumer-stats sweep, our port of Tachikoma's `TopicProbe.pm`
 * (consumer branch). Consumer and partition state ride together at one instant:
 * the cursor's segment and offset, the `bytes_behind` backlog measured from real
 * on-disk segment sizes, and the messages and bytes the reader moved since its
 * previous sweep. Each READY Consumer yields ONE `Probe_Record` into the shared
 * `topicprobe` log.
 *
 * That log is the sole live-position source: `wp nodes status` and the dashboards
 * read it, never memcache. A record therefore exists only while a worker is
 * running to write one, which is why `stale_after_s()` judges liveness by age.
 */
class Topic_Probe_Node extends Probe_Node {

	/**
	 * Basename of the shared probe-log directory. `topic-probe.tsl` declares the
	 * writer's full path; every reader composes it under its own base directory.
	 */
	public const LOG_DIR = 'topicprobe.p0';

	/**
	 * The stock topology carrying the `Topic_Probe` line, which the topologies
	 * that want a sweep `include`. Its positional 0 is the declared cadence.
	 */
	private const TOPOLOGY = 'topic-probe';

	/** Sweeps a record may go unwritten before its writer counts as gone. */
	private const STALE_SWEEPS = 2;

	/** The memoized cadence: null before the first read, and after a forget. */
	private static ?int $declared_interval_s = null;

	/**
	 * Seconds a probe record may age before it means nobody is reporting rather
	 * than a slow reader. The sweep runs unconditionally while a worker lives, so
	 * two missed cadences mean the process is gone.
	 *
	 * Measured in SWEEPS against the declared cadence, not a fixed number of
	 * seconds: `topic-probe.tsl` carries `interval_s` as arg 0, and a deployment
	 * that retunes it would otherwise have every healthy reader read as departed,
	 * recomputing lag off disk on every dashboard poll and reporting a zero rate
	 * for workers that are running fine.
	 */
	public static function stale_after_s(): int {
		return self::declared_interval_s() * self::STALE_SWEEPS;
	}

	/**
	 * Read the cadence `topic-probe.tsl` declares, or `DEFAULT_INTERVAL_S` when
	 * the topology is unreachable or names no `Topic_Probe`. Memoized for the
	 * request — a status poll asks once per reader row — off a graph the analyzer
	 * already caches; `forget_interval()` drops the memo when the active set
	 * changes.
	 */
	public static function declared_interval_s(): int {
		if ( null !== self::$declared_interval_s ) {
			return self::$declared_interval_s;
		}
		$declared = 0;
		try {
			foreach ( Topology_Analyzer::graph_for( self::TOPOLOGY )['nodes'] as $node ) {
				if ( 'Topic_Probe' !== ( $node['type'] ?? '' ) ) {
					continue;
				}
				$args     = \is_array( $node['args'] ?? null ) ? $node['args'] : [];
				$declared = Core::num_int( $args[0] ?? 0, 0 );
				break;
			}
		} catch ( \Throwable $e ) {
			// An unreadable topology is a default, never a "never stale".
			$declared = 0;
		}
		return self::$declared_interval_s = $declared > 0 ? $declared : self::DEFAULT_INTERVAL_S;
	}

	/**
	 * Claim every Consumer in this process that has reached READY. One still
	 * initializing holds no cursor, so it has no position to report.
	 *
	 * @param Node $node A node from this process's registry.
	 * @return array<int,array<int,int|string>> One Probe_Record, or none.
	 */
	protected function probe( Node $node ): array {
		if ( ! $node instanceof Consumer_Node || null === $node->get_state( 'READY' ) ) {
			return [];
		}
		return [ $node->probe_stats() ];
	}

	/**
	 * Drop the memoized cadence so the next read re-parses the topology.
	 * `Topology_Registry::invalidate_config_cache()` calls it on every active-set
	 * change, and a test registering a different stock dir calls it directly.
	 */
	public static function forget_interval(): void {
		self::$declared_interval_s = null;
	}

	/**
	 * Topology console manifest: the `Monitor` palette entry and the one
	 * `interval_s` positional. Declaring it here is the whole parse — ADR-11 puts
	 * defaults and coercion in `parse_schema_args()`, which `Probe_Node` calls to
	 * arm the sweep timer.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Monitor',
			'description' => 'Sweeps every Consumer in this process every N seconds; emits one stats snapshot (seg:off, bytes_read, backlog) into the topicprobe log.',
			'arguments'   => [
				[ 'name' => 'interval_s', 'type' => 'int', 'default' => self::DEFAULT_INTERVAL_S, 'description' => 'Sweep cadence in seconds between Consumer-stats snapshots; empty or absent defaults to 15.' ],
			],
		] );
	}
}
