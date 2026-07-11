<?php
/**
 * Deferred_Clean_Stop: the write-side of the clean cooperative-stop protocol.
 *
 * A snapshot node forwards downstream mid-fill() (a partition write) but has more
 * per-message bookkeeping to finish afterward. When that write triggers a
 * cooperative stop, the node must NOT let it unwind mid-message — the message's
 * downstream work is durable (the Partition writes, then pumps), so the node
 * finishes its own state, then re-raises the stop as CLEAN. The Consumer's
 * Buffered_Pump then commits PAST the message (offset+length) instead of replaying
 * and deduping it. This is the symmetric counterpart to Buffered_Pump's read-side
 * advance-on-clean; both live in the substrate.
 *
 * A using node's fill() MUST call clear_pending_stop() at entry (the deferral is
 * per-message) and raise_pending_stop() at every exit.
 *
 * @api Consumed by application snapshot nodes in sibling plugins (event-logger-nodes).
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Deferred_Clean_Stop {

	/** A forward's deferred cooperative stop; re-raised as a clean stop once the message's bookkeeping is done. */
	private ?Worker_Should_Stop $pending_stop = null;

	/**
	 * Run a downstream forward, deferring a Worker_Should_Stop instead of letting it
	 * unwind mid-message. A caught stop means the partition wrote the message before
	 * pump() signaled it; keep the first one (Tee-style precedence) so fill() finishes
	 * this message's bookkeeping, then raise_pending_stop() re-raises it as CLEAN. A
	 * non-stop throwable still propagates to the Consumer's dead-letter path as before.
	 *
	 * @api
	 */
	protected function guarded( \Closure $forward ): void {
		try {
			$forward();
		} catch ( Worker_Should_Stop $e ) {
			$this->pending_stop ??= $e;
		}
	}

	/**
	 * Reset the per-message deferral. fill() MUST call this at entry so a stale stop can't leak forward.
	 *
	 * @api
	 */
	protected function clear_pending_stop(): void {
		$this->pending_stop = null;
	}

	/**
	 * Re-raise a forward's deferred stop as a clean stop, once this message's bookkeeping is done.
	 *
	 * @api
	 */
	protected function raise_pending_stop(): void {
		if ( null !== $this->pending_stop ) {
			$this->pending_stop = null;
			throw new Worker_Should_Stop_Clean();
		}
	}
}
