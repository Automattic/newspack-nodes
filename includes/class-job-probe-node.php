<?php
/**
 * Job_Probe: periodic Job_Worker-stats sweep. The jobs analog of Topic_Probe — each
 * worker process runs one, sweeping ITS local Job_Workers (`Core::$nodes_by_name`)
 * and emitting one snapshot record per job IDENTITY per tick into the shared
 * `jobstats` log. A Job_Worker owns many identities, so one worker yields many
 * records (unlike Topic_Probe, where one Consumer yields one). Each record is
 * SELF-CONTAINED — the work done since that identity's previous sweep plus the
 * interval it covers — so a reader divides ONE record and a ~595s worker recycle
 * is just another window, not a counter reset. Because the sweep DRAINS each
 * accumulator, exactly one Job_Probe may run per process.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Job_Probe_Node extends Timer_Node implements Shutdown_Sweeper {

	private const DEFAULT_INTERVAL_S = 15;

	/**
	 * The N-second sweep cadence is the base Timer's interval_ms (> 1000), so it
	 * hitchhikes the Router TIMER and Timer_Node::fire_cb() throttles to it. Default
	 * to the 15s cadence so a probe never given arguments still sweeps every 15s.
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
			throw new \InvalidArgumentException( 'Bad arguments for Job_Probe' );
		}
		$interval_s = '' === $trimmed ? self::DEFAULT_INTERVAL_S : \max( 1, (int) $trimmed );
		// set_timer registers TIMER hitchhike; fire_cb() gates to interval_ms.
		$this->set_timer( $interval_s * 1000 );
		return $this->arguments;
	}

	/**
	 * Called by the base fire_cb() once interval_ms has elapsed (the throttle). Emit
	 * ONE small TM_STRUCT record PER job identity across this process's Job_Workers —
	 * the lean positional Jobstats_Record snapshot. One record per identity (not a
	 * batch) keeps every write under PIPE_BUF so the shared jobstats log stays
	 * multi-writer atomic. The Message TIMESTAMP is the snapshot time. No workers (or
	 * a worker with no runs yet) → nothing. A worker whose probe_stats throws is
	 * skipped, never failing the whole snapshot.
	 */
	protected function fire(): void {
		$this->notify( 'FIRE', Core::$now );
		$sink = $this->sink;
		if ( null === $sink ) {
			return;
		}
		foreach ( Core::$nodes_by_name as $node ) {
			if ( ! $node instanceof Job_Worker_Node ) {
				continue;
			}
			try {
				$records = $node->probe_stats();
			} catch ( \Throwable $e ) {
				$this->print_less_often( "Job_Probe skipped {$node->name()}: ", $e->getMessage() );
				continue;
			}
			foreach ( $records as $record ) {
				$message                       = Message::new_message();
				$message[ Message::TYPE ]      = Message::TM_STRUCT;
				$message[ Message::TIMESTAMP ] = Core::$now;
				$message[ Message::FROM ]      = $this->name;
				$message[ Message::TO ]        = $this->target;
				$message[ Message::VALUE ]     = $record;
				$message                       = $this->fit_to_line( $message );
				if ( null === $message ) {
					$key = Core::as_string( $record[ Jobstats_Record::KEY ] ?? '' );
					$this->print_less_often( 'Job_Probe dropped an unfittable record: ', $key );
					continue;
				}
				++$this->counter;
				$sink->fill( $message );
			}
		}
	}

	/**
	 * Fit a record to the jobstats log's physical boundary: the PACKED line (with
	 * newline) must stay under PIPE_BUF or the bare Partition drops it. Character
	 * caps are a proxy — JSON escaping packs a multibyte char as up to 12 bytes —
	 * so measure packed_size and halve LAST_MESSAGE until the line fits. Null when
	 * nothing left to cut (a pathological identity key): drop, never emit oversize.
	 *
	 * @param array<int, mixed> $message The minted record message.
	 * @return array<int, mixed>|null The fitting message, or null to drop.
	 */
	private function fit_to_line( array $message ): ?array {
		while ( Message::packed_size( $message ) + 1 > Partition_Node::MAX_LINE_SIZE ) {
			$value = $message[ Message::VALUE ];
			if ( ! \is_array( $value ) ) {
				return null; // Oversize and not a record: nothing to truncate.
			}
			$last = Core::as_string( $value[ Jobstats_Record::LAST_MESSAGE ] ?? '' );
			if ( '' === $last ) {
				return null;
			}
			$value[ Jobstats_Record::LAST_MESSAGE ] = \mb_substr( $last, 0, \intdiv( \mb_strlen( $last ), 2 ) );
			$message[ Message::VALUE ]              = $value;
		}
		return $message;
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
			'description' => 'Sweeps every Job_Worker in this process every N seconds; emits one stats snapshot (runs, errors, durations, last-run) per job identity into the jobstats log.',
			'arguments'   => [
				[ 'name' => 'interval_s', 'type' => 'int', 'required' => false, 'description' => 'Sweep cadence in seconds between Job_Worker-stats snapshots; empty or absent defaults to 15.' ],
			],
		] );
	}
}
