<?php
/**
 * Probe_Node — the periodic per-worker stats sweep every probe shares.
 *
 * Each worker process runs one probe, sweeping ITS local nodes
 * (`Core::$nodes_by_name`, our analog of Tachikoma's `%Tachikoma::Nodes`) and
 * emitting lean positional TM_STRUCT records into a shared log. One record per
 * emit — never a batch — keeps every append under PIPE_BUF, so the shared log
 * stays multi-writer atomic with no lock and no oversize drop. The Message
 * TIMESTAMP is the snapshot instant and is never duplicated into the VALUE.
 *
 * Every record is SELF-CONTAINED: the work done since that source's previous
 * sweep plus the interval it covers, so a reader divides ONE record and a ~595s
 * worker recycle is just another window rather than a counter reset. Because a
 * sweep DRAINS each accumulator, exactly one probe of a kind may run per process.
 *
 * A subclass declares only `probe()` — which nodes it claims, and how many records
 * each yields — plus `fit_to_line()` when its record needs trimming to stay under
 * the PIPE_BUF cap. Everything else below is the sweep itself.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

abstract class Probe_Node extends Timer_Node implements Shutdown_Sweeper {

	/** The base's own default; a subclass sets its cadence via arguments. */
	protected const DEFAULT_INTERVAL_S = 15;

	/** Sweep cadence in seconds; every subclass declares it as positional 0. */
	protected int $interval_s = self::DEFAULT_INTERVAL_S;

	/**
	 * The N-second sweep cadence is the base Timer's interval_ms (> 1000), so it
	 * hitchhikes the Router TIMER and Timer_Node::fire_cb() throttles to it — no
	 * bespoke last_fire_time gate. Default to the 15s cadence so a probe that is
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
		$this->parse_schema_args( $args );
		// set_timer registers TIMER hitchhike; fire_cb() gates to interval_ms.
		$this->set_timer( $this->cadence_ms( $this->interval_s ) );
		return $this->arguments;
	}

	/**
	 * Called by the base fire_cb() once interval_ms has elapsed (the throttle).
	 * Sweep every node this probe claims and emit one TM_STRUCT per record. A node
	 * whose probe_stats() throws is skipped rate-limited, never failing the whole
	 * snapshot; no claimable nodes (or a live one with nothing recorded yet) emits
	 * nothing at all.
	 */
	protected function fire(): void {
		$this->notify( 'FIRE', Core::$now );
		$sink = $this->sink;
		if ( null === $sink ) {
			return;
		}

		foreach ( Core::$nodes_by_name as $node ) {
			try {
				$records = $this->probe( $node );
			} catch ( Worker_Should_Stop $e ) {
				// Cooperative stop, not an error: ADR-14 says re-throw first.
				throw $e;
			} catch ( \Throwable $e ) {
				$who = Command_Interpreter_Node::shell_name_for( $this );
				$this->print_less_often( "{$who} skipped {$node->name()}: ", $e->getMessage() );
				continue;
			}
			foreach ( $records as $record ) {
				$message                       = Message::new_message();
				$message[ Message::TYPE ]      = Message::TM_STRUCT;
				$message[ Message::TIMESTAMP ] = Core::$now;
				$message[ Message::FROM ]      = $this->name;
				$message[ Message::TO ]        = $this->target;
				$message[ Message::VALUE ]     = $record;
				$fitted                        = $this->fit_to_line( $message );
				if ( null === $fitted ) {
					continue;
				}
				++$this->counter;
				$sink->fill( $fitted );
			}
		}
	}

	/**
	 * The records this probe takes from one swept node — empty for a node it does
	 * not claim, which is how the sweep set is declared.
	 *
	 * @param Node $node A node from this process's registry.
	 * @return array<int,array<int,int|string>> Positional records.
	 */
	abstract protected function probe( Node $node ): array;

	/**
	 * Records emit as minted. A probe whose record carries a free-text field that
	 * can overflow the PIPE_BUF cap overrides this to trim that field, and to drop
	 * loud when nothing is left to trim; one whose record is all bounded fields
	 * must not, since halving an identity would corrupt what readers key on.
	 *
	 * @param array<int,mixed> $message The minted record message.
	 * @return array<int,mixed>|null The message to emit, or null to drop it.
	 */
	protected function fit_to_line( array $message ): ?array {
		return $message;
	}

	/**
	 * Clean-shutdown opt-in: emit the window since the last tick, which the timer
	 * gate would otherwise swallow when the worker recycles mid-interval.
	 */
	public function shutdown_sweep(): void {
		$this->fire();
	}
}
