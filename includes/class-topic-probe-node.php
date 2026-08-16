<?php
/**
 * Topic_Probe: the Consumer-stats sweep. See Probe_Node for the sweep itself.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Topic_Probe: the Consumer-stats sweep, our port of Tachikoma's TopicProbe.pm
 * (consumer branch). Consumer + partition state ride together at one instant:
 * each consumer's seg:off cursor and its `bytes_behind` backlog (from real
 * on-disk segment sizes), plus the messages and bytes it moved since its
 * previous sweep. ONE record per Consumer, into the shared `topicprobe` log.
 * Log-only — no memcache; the log is the sole position source.
 */
class Topic_Probe_Node extends Probe_Node {

	/** Shared probe-log dir basename (the topic-probe TSL declares the path). */
	public const LOG_DIR = 'topicprobe.p0';

	/** The stock topology every install includes; its arg 0 is the cadence. */
	private const TOPOLOGY = 'topic-probe';

	/** Missed sweeps before a record means nobody is reporting. */
	private const STALE_SWEEPS = 2;

	/** Memoized declared cadence; null until read. */
	private static ?int $interval_s = null;

	/**
	 * How old a probe record may be before it is nobody reporting rather than a
	 * slow reader. The sweep runs unconditionally while a worker lives, so two
	 * missed cadences means the process is gone.
	 *
	 * Measured in SWEEPS against the declared cadence, not a fixed number of
	 * seconds: `topic-probe.tsl` carries `interval_s` as arg 0, and a deployment
	 * that retunes it would otherwise have every healthy reader read as departed
	 * — recomputing off disk on every dashboard poll and reporting a zero rate
	 * for workers that are running fine.
	 */
	public static function stale_after_s(): int {
		return self::interval_s() * self::STALE_SWEEPS;
	}

	/**
	 * The cadence `topic-probe.tsl` declares, or the class default when the
	 * topology is unreachable. Memoized: read once per request, off a graph the
	 * analyzer already caches.
	 */
	public static function interval_s(): int {
		if ( null !== self::$interval_s ) {
			return self::$interval_s;
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
		return self::$interval_s = $declared > 0 ? $declared : self::DEFAULT_INTERVAL_S;
	}

	/** A Consumer that has reached READY; an uninitialized one has no cursor. */
	protected function probe( Node $node ): array {
		if ( ! $node instanceof Consumer_Node || null === $node->get_state( 'READY' ) ) {
			return [];
		}
		return [ $node->probe_stats() ];
	}

	/** Drop the memoized cadence. Tests, and any stock-dir change. */
	public static function forget_interval(): void {
		self::$interval_s = null;
	}

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Monitor',
			'description' => 'Sweeps every Consumer in this process every N seconds; emits one stats snapshot (seg:off, bytes_read, backlog) into the topicprobe log.',
			'arguments'   => [
				[ 'name' => 'interval_s', 'type' => 'int', 'required' => false, 'description' => 'Sweep cadence in seconds between Consumer-stats snapshots; empty or absent defaults to 15.' ],
			],
		] );
	}
}
