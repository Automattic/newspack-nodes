<?php
/**
 * Topic_Probe: periodic Consumer-stats sweep. The counterpart of Tachikoma's
 * TopicProbe.pm (consumer branch) for our multi-process world — each worker process
 * runs one, sweeping ITS local Consumers (`Core::$nodes_by_name`, the analog of
 * `%Tachikoma::Nodes`) and emitting one snapshot record per tick into the shared
 * `topicprobe` log. Consumer + partition state ride together at one instant: each
 * consumer's seg:off cursor and its `bytes_behind` backlog (from real on-disk
 * segment sizes), plus the messages and bytes it moved since its previous sweep
 * and the interval that covers — a SELF-CONTAINED record a reader divides on its
 * own, so a ~595s worker recycle is just another window rather than a counter
 * reset. Because the sweep DRAINS each Consumer's counters, exactly one
 * Topic_Probe may run per process. Log-only — no memcache; the log is the sole
 * position source.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Topic_Probe_Node extends Timer_Node implements Shutdown_Sweeper {

	/** Shared probe-log dir basename (the topic-probe TSL declares the path). */
	public const LOG_DIR = 'topicprobe.p0';

	private const DEFAULT_INTERVAL_S = 15;

	/** The stock topology every install includes; its arg 0 is the cadence. */
	private const TOPOLOGY = 'topic-probe';

	/** Missed sweeps before a record means nobody is reporting. */
	private const STALE_SWEEPS = 2;

	/** Memoized declared cadence; null until read. */
	private static ?int $interval_s = null;

	/**
	 * The N-second sweep cadence is the base Timer's interval_ms (> 1000), so it
	 * hitchhikes the Router TIMER and Timer_Node::fire_cb() throttles to it — no
	 * bespoke last_fire_time gate. Default to the 15s cadence so a probe that's
	 * never given arguments still sweeps every 15s.
	 */
	public function __construct() {
		parent::__construct();
		$this->interval_ms = self::DEFAULT_INTERVAL_S * 1000;
	}

	public function arguments( ?array $args = null ): array {
		if ( null === $args ) {
			return $this->arguments;
		}
		$this->arguments = $args;
		$trimmed         = ( $args[0] ?? '' );
		if ( '' !== $trimmed && ! \preg_match( '/^[0-9]+$/', $trimmed ) ) {
			throw new \InvalidArgumentException( 'Bad arguments for Topic_Probe' );
		}
		$interval_s = '' === $trimmed ? self::DEFAULT_INTERVAL_S : \max( 1, (int) $trimmed );
		// set_timer registers TIMER hitchhike; fire_cb() gates to interval_ms.
		$this->set_timer( $interval_s * 1000 );
		return $this->arguments;
	}

	/**
	 * Called by the base fire_cb() once interval_ms has elapsed (the throttle).
	 * Emit ONE small TM_STRUCT record PER Consumer in this process — the lean
	 * positional Probe_Record snapshot. One record per consumer (not a batch) keeps
	 * every write under PIPE_BUF so the shared topicprobe log stays multi-writer
	 * atomic — no lock, no oversize drop. The Message TIMESTAMP is the snapshot time
	 * (not duplicated into VALUE). No consumers → nothing. A bad/uninitialized
	 * consumer is skipped, never failing the whole snapshot.
	 */
	protected function fire(): void {
		$this->notify( 'FIRE', Core::$now );
		$sink = $this->sink;
		if ( null === $sink ) {
			return;
		}
		foreach ( Core::$nodes_by_name as $node ) {
			if ( ! $node instanceof Consumer_Node || null === $node->get_state( 'READY' ) ) {
				continue;
			}
			try {
				$record = $node->probe_stats();
			} catch ( \Throwable $e ) {
				$this->print_less_often( "Topic_Probe skipped {$node->name()}: ", $e->getMessage() );
				continue;
			}
			$message                       = Message::new_message();
			$message[ Message::TYPE ]      = Message::TM_STRUCT;
			$message[ Message::TIMESTAMP ] = Core::$now;
			$message[ Message::FROM ]      = $this->name;
			$message[ Message::TO ]        = $this->target;
			$message[ Message::VALUE ]     = $record;
			++$this->counter;
			$sink->fill( $message );
		}
	}

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

	/** Drop the memoized cadence. Tests, and any stock-dir change. */
	public static function forget_interval(): void {
		self::$interval_s = null;
	}

	/**
	 * Clean-shutdown opt-in: emit the window since the last tick, which the timer
	 * gate would otherwise swallow when the worker recycles mid-interval.
	 */
	public function shutdown_sweep(): void {
		$this->fire();
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
