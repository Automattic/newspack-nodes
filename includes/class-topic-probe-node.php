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

	private string $host         = '';
	private int $interval_s      = self::DEFAULT_INTERVAL_S;
	private float $last_fire_time = 0.0;

	/**
	 * Previous sample per `offset_dir`, for the rates the probe computes itself.
	 *
	 * @var array<string,array{read:int,total:int,ts:float}>
	 */
	private array $last_sample = [];

	public function __construct() {
		parent::__construct();
		$this->host = \gethostname() ?: 'unknown';
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
		$this->interval_s = '' === $trimmed ? self::DEFAULT_INTERVAL_S : \max( 1, (int) $trimmed );
		// Hitchhike the Router TIMER (no dedicated event-framework slot); fire()
		// self-gates the cadence against last_fire_time, like Consumer's publish.
		// NOTE: can't delegate to Timer_Node::arguments — its numeric path means
		// "fire an own slot every N MILLISECONDS"; our N is the GATE interval in
		// SECONDS, so we always hitchhike and gate ourselves.
		$this->set_timer();
		return $this->arguments;
	}

	// Fires on every Router tick (hitchhike); gated to interval_s against
	// last_fire_time. When due, emit ONE small TM_STRUCT record PER Consumer in
	// this process (all stamped with the same `ts` — one snapshot instant). One
	// record per consumer (not a batch) keeps every write under PIPE_BUF so the
	// shared topicprobe log stays multi-writer atomic — no lock, no oversize drop.
	// No consumers → nothing (mirrors Tachikoma's `if ($out)`). A single bad/
	// uninitialized consumer is skipped, never failing the whole snapshot.
	protected function fire(): void {
		if ( Core::$now - $this->last_fire_time < $this->interval_s ) {
			return;
		}
		$this->last_fire_time = Core::$now;
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
				$stats = $node->probe_stats();
			} catch ( \Throwable $e ) {
				$this->print_less_often( "TopicProbe skipped {$node->name()}: {$e->getMessage()}" );
				continue;
			}
			[ $read_rate, $write_rate ] = $this->rates_for( $stats );
			$message                       = Message::new_message();
			$message[ Message::TYPE ]      = Message::TM_STRUCT;
			$message[ Message::TIMESTAMP ] = Core::$now;
			$message[ Message::FROM ]      = $this->name;
			$message[ Message::TO ]        = $this->target;
			$message[ Message::VALUE ]     = [
				'ts'         => Core::$now,
				'host'       => $this->host,
				...$stats,
				'read_rate'  => $read_rate,
				'write_rate' => $write_rate,
			];
			++$this->counter;
			$sink->fill( $message );
		}
	}

	/**
	 * Byte-rate the probe computes from its OWN consecutive samples (Δbytes / Δts)
	 * — so every consumer of the log displays ONE authoritative rate at the probe
	 * cadence, never a client-side delta of a live value at a different cadence.
	 * read_rate = Δbytes_read; write_rate = Δbytes_total (the partition end's
	 * growth). First sample (no prior) or a counter reset (restart / retention
	 * drop) → 0, never negative.
	 *
	 * @param array<string,mixed> $stats A `Consumer_Node::probe_stats()` record.
	 * @return array{0:float,1:float} [ read_rate, write_rate ] in bytes/sec.
	 */
	private function rates_for( array $stats ): array {
		$key   = \is_string( $stats['offset_dir'] ?? null ) ? $stats['offset_dir'] : '';
		$read  = \is_numeric( $stats['bytes_read'] ?? null ) ? (int) $stats['bytes_read'] : 0;
		$total = \is_numeric( $stats['bytes_total'] ?? null ) ? (int) $stats['bytes_total'] : 0;
		$now   = Core::$now;

		$read_rate  = 0.0;
		$write_rate = 0.0;
		$prev       = '' !== $key ? ( $this->last_sample[ $key ] ?? null ) : null;
		if ( null !== $prev && $now > $prev['ts'] ) {
			$dt = $now - $prev['ts'];
			if ( $read >= $prev['read'] ) {
				$read_rate = ( $read - $prev['read'] ) / $dt;
			}
			if ( $total >= $prev['total'] ) {
				$write_rate = ( $total - $prev['total'] ) / $dt;
			}
		}
		if ( '' !== $key ) {
			$this->last_sample[ $key ] = [ 'read' => $read, 'total' => $total, 'ts' => $now ];
		}
		return [ $read_rate, $write_rate ];
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
