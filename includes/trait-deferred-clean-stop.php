<?php
/**
 * Deferred_Clean_Stop: the write side of the clean cooperative-stop protocol.
 *
 * A snapshot node forwards downstream mid-fill() — typically into a Partition, which
 * flushes the batched record to disk before it lets a cooperative stop unwind — and
 * still owes that message its own bookkeeping. Letting the stop unwind there leaves
 * the record durable and the node's state half-updated, so the successor replays a
 * message the restored snapshot has already counted: Request_Builder_Node logs
 * `duplicate message: expected #N, got #N-1`, and a request-completing line is
 * dropped. The node instead defers the stop, finishes its bookkeeping, and re-raises
 * it as `Worker_Should_Stop_Clean`, on which `Durable_Reader::drain_buffer()` commits
 * PAST the record — the crumb's offset plus length, the advance a successful forward
 * makes — rather than replaying it. This is the write-side counterpart to that
 * read-side advance-on-clean; both live in the substrate.
 *
 * A using node's fill() MUST call clear_pending_stop() at entry (the deferral is
 * per-message) and raise_pending_stop() at every exit.
 *
 * @api Consumed by application snapshot nodes in sibling plugins: event-logger-nodes'
 *      Request_Builder_Node and Flame_Builder_Node.
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Deferred_Clean_Stop {

	/**
	 * The stop a forward raised while this message was still in flight, held for the
	 * clean re-raise. Its presence is the whole signal — the instance never escapes.
	 */
	private ?Worker_Should_Stop $pending_stop = null;

	/**
	 * Run a downstream forward, deferring a cooperative stop instead of letting it
	 * unwind mid-message. A caught Worker_Should_Stop means the Partition flushed the
	 * record and only then honored the stop, so the write is durable and the caller
	 * has earned the chance to finish its own bookkeeping. The first stop wins, and
	 * arrival order is enough because the instance is a flag rather than the
	 * throwable that escapes: raise_pending_stop() always raises a fresh
	 * Worker_Should_Stop_Clean. A fan-out ranks by subtype instead
	 * (`Fanout_Targets::outranks()`) because it re-throws the deferred throwable
	 * itself. A non-stop throwable propagates, reaching the Consumer's dead-letter
	 * path.
	 *
	 * @api
	 * @param \Closure $forward The downstream forward to run, as `function(): void`.
	 */
	protected function guarded( \Closure $forward ): void {
		try {
			$forward();
		} catch ( Worker_Should_Stop $e ) {
			$this->pending_stop ??= $e;
		}
	}

	/**
	 * Reset the per-message deferral. fill() MUST call this at entry, because a stop
	 * held over from an earlier message raises at a LATER message's exit, committing
	 * the reader past a record whose downstream write nothing forced to disk.
	 *
	 * @api
	 */
	protected function clear_pending_stop(): void {
		$this->pending_stop = null;
	}

	/**
	 * Raise a deferred stop as CLEAN, once this message's bookkeeping is done, and do
	 * nothing when no forward stopped. The fresh Worker_Should_Stop_Clean — not the
	 * caught instance — is what `Durable_Reader::drain_buffer()` reads as permission
	 * to commit past the record instead of replaying it.
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
