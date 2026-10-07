<?php
/**
 * Topic_Probe: the Consumer and Partition stats sweep. See Probe_Node for the
 * sweep itself.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Topic_Probe: the Consumer and Partition stats sweep, our port of
 * Tachikoma's `TopicProbe.pm`, which sweeps `Partition` nodes beside
 * `Consumer` nodes. Things that need Consumer stats read Consumer records, and
 * things that need partition stats read Partition records, both in the one
 * `Probe_Record` layout written into the shared `topicprobe` log.
 *
 * Each READY durable reader yields ONE Consumer record: the cursor's segment
 * and offset, the backlog, and the messages and bytes the reader moved since
 * its previous sweep. A Consumer measures its backlog from real on-disk
 * segment sizes; a broker's Remote_Consumer, which cannot see the spoke's
 * end, from what the spoke has sent it (`Remote_Consumer_Node::probe_stats()`). Each
 * Partition with a live segment yields ONE Partition record, with a blank
 * READER: its size and the disk it takes. A log two nodes of this process
 * cover — a writer and a Consumer's `:source` — reports once a sweep.
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

	/** @var array<string,true> Identity paths reported this sweep. */
	private array $swept = [];

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
	 * no such topology is registered or it names no `Topic_Probe`. Memoized for
	 * the request — a status poll asks once per reader row — off a graph the
	 * analyzer already caches; `forget_interval()` drops the memo when the active
	 * set changes.
	 *
	 * @throws \RuntimeException When the topology is registered but will not parse.
	 */
	public static function declared_interval_s(): int {
		if ( null !== self::$declared_interval_s ) {
			return self::$declared_interval_s;
		}
		$probe    = Topology_Analyzer::nodes_of_type( self::TOPOLOGY, self::class )[0] ?? [];
		$args     = \is_array( $probe['args'] ?? null ) ? $probe['args'] : [];
		$declared = Core::num_int( $args[0] ?? 0, 0 );
		return self::$declared_interval_s = $declared > 0 ? $declared : self::DEFAULT_INTERVAL_S;
	}

	/**
	 * Claim every durable reader in this process — each `Position_Reporter`,
	 * a Consumer and a broker's Remote_Consumer alike — that has reached READY,
	 * stands somewhere and names a reader, and every Partition with a live
	 * segment. A reader still initializing holds no cursor, and one with no id
	 * to report under has no READER, which would read as a Partition record. A
	 * Partition over a log an earlier-registered Partition already covers is
	 * that log again.
	 *
	 * @param Node $node A node from this process's registry.
	 * @return array<int,array<int,int|string|null>> One Probe_Record, or none.
	 */
	protected function probe( Node $node ): array {
		if ( $node instanceof Partition_Node ) {
			return $this->partition_record( $node );
		}
		if ( ! $node instanceof Position_Reporter || null === $node->get_state( 'READY' ) ) {
			return [];
		}
		$record = $node->probe_stats();
		return null === $record || '' === $record[ Probe_Record::READER ] ? [] : [ $record ];
	}

	/**
	 * A Partition's record, unless a Partition swept before it this sweep
	 * covers the same log — a writer and a Consumer's `:source` over one
	 * directory — so each log reports once a sweep. The sweep walks the
	 * registry in order, so the first registered reports.
	 *
	 * @param Partition_Node $partition A Partition from this process's registry.
	 * @return array<int,array<int,int|string>> One Probe_Record, or none.
	 */
	private function partition_record( Partition_Node $partition ): array {
		$identity = $partition->identity_path();
		if ( isset( $this->swept[ $identity ] ) ) {
			return [];
		}
		$this->swept[ $identity ] = true;
		$record                   = $partition->probe_stats();
		return null === $record ? [] : [ $record ];
	}

	/** Sweep afresh: a log reported in an earlier sweep reports again. */
	protected function sweep_started(): void {
		$this->swept = [];
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
	 * Topology console manifest: this probe's description over the `Monitor`
	 * palette entry and `interval_s` positional `Probe_Node` declares.
	 *
	 * @return array<string,mixed>
	 */
	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'description' => 'Sweeps every Consumer and Partition in this process every N seconds; emits one stats snapshot per reader (seg:off, bytes_read, backlog) and per partition (size, disk) into the topicprobe log.',
		] );
	}
}
