<?php
/**
 * TopicProbe: periodic Consumer-stats sweep. A faithful port of Tachikoma's
 * TopicProbe (consumer branch) for our multi-process world — each worker process
 * runs one, sweeping ITS local Consumers (`Core::$nodes_by_name`, the analog of
 * `%Tachikoma::Nodes`) and emitting one snapshot record per tick into the shared
 * `topicprobe` log. Consumer + partition state ride together at one instant:
 * each consumer's seg:off cursor plus the EXACT byte volumes — `bytes_read`
 * (monotonic, → byte-rate) and `bytes_behind` (backlog, from real on-disk segment
 * sizes). Log-only — no memcache; the log is the sole position source.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class TopicProbe_Node extends Timer_Node {

	private const DEFAULT_INTERVAL_S = 15;

	// The N-second sweep cadence is the base Timer's interval_ms (> 1000), so it
	// hitchhikes the Router TIMER and Timer_Node::fire_cb() throttles to it — no
	// bespoke last_fire_time gate. Default to the 15s cadence so a probe that's
	// never given arguments still sweeps every 15s.
	public function __construct() {
		parent::__construct();
		$this->interval_ms = self::DEFAULT_INTERVAL_S * 1000;
	}

	public function arguments( ?string $args = null ): string {
		if ( null === $args ) {
			return $this->arguments;
		}
		$this->arguments = $args;
		$trimmed         = \trim( $args );
		if ( '' !== $trimmed && ! \preg_match( '/^[0-9]+$/', $trimmed ) ) {
			throw new \InvalidArgumentException( 'Bad arguments for TopicProbe' );
		}
		$interval_s = '' === $trimmed ? self::DEFAULT_INTERVAL_S : \max( 1, (int) $trimmed );
		// Hitchhike + throttle via the base (interval > 1000 ms): set_timer registers
		// the TIMER hitchhike and fire_cb() gates to interval_ms. A 1s interval lands
		// on an own slot (the router tick is too coarse to pace a 1s cadence).
		$this->set_timer( $interval_s * 1000 );
		return $this->arguments;
	}

	// Called by the base fire_cb() once interval_ms has elapsed (the throttle).
	// Emit ONE small TM_STRUCT record PER Consumer in this process — the lean
	// positional Probe_Record snapshot. One record per consumer (not a batch) keeps
	// every write under PIPE_BUF so the shared topicprobe log stays multi-writer
	// atomic — no lock, no oversize drop. The Message TIMESTAMP is the snapshot time
	// (not duplicated into VALUE). No consumers → nothing. A bad/uninitialized
	// consumer is skipped, never failing the whole snapshot.
	protected function fire(): void {
		$this->notify( 'FIRE', Core::$now );
		$sink = $this->sink;
		if ( null === $sink ) {
			return;
		}
		foreach ( Core::$nodes_by_name as $node ) {
			if ( ! $node instanceof Consumer_Node ) {
				continue;
			}
			try {
				$record = $node->probe_stats();
			} catch ( \Throwable $e ) {
				$this->print_less_often( "TopicProbe skipped {$node->name()}: {$e->getMessage()}" );
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

	public static function node_schema(): array {
		return \array_merge( parent::node_schema(), [
			'category'    => 'Monitor',
			'description' => 'Sweeps every Consumer in this process every N seconds; emits one stats snapshot (seg:off, bytes_read, backlog) into the topicprobe log.',
			'arguments'   => [
				[ 'name' => 'interval_s', 'type' => 'int', 'required' => false ],
			],
		] );
	}
}
