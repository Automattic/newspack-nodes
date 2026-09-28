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
 * dropped. The node instead runs the message inside `deferring()`, which holds every
 * stop a `guarded()` forward raises until the message is finished and then raises it
 * as `Worker_Should_Stop_Clean`, on which `Durable_Reader::drain_buffer()` commits
 * PAST the record — the crumb's offset plus length, the advance a successful forward
 * makes — rather than replaying it. This is the write-side counterpart to that
 * read-side advance-on-clean; both live in the substrate.
 *
 * A using node's fill() wraps its whole per-message work in `deferring()`; the
 * bracket is per-message by construction, so no stop outlives the message it
 * stopped. A checkpoint needs no bracket: `Consumer_Node` saves and commits it
 * inside `Event_Framework::uninterruptible()`, where no stop raises at all.
 *
 * @api Consumed by application snapshot nodes in sibling plugins: event-logger-nodes'
 *      Request_Builder_Node and Flame_Builder_Node.
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

trait Deferred_Clean_Stop {

	/**
	 * The stops `guarded()` has held for the open bracket, or null outside any
	 * bracket, where a stop has nowhere to wait and propagates at once.
	 *
	 * @var list<Worker_Should_Stop>|null
	 */
	private ?array $deferred_stops = null;

	/**
	 * Run one message's work, holding every stop a `guarded()` forward raises
	 * until the work is done, then raise everything the bracket caught through
	 * `Worker_Should_Stop::raise()`. A held BARE plain stop raises as
	 * `Worker_Should_Stop_Clean`: the forward flushed its record before honouring
	 * the stop, and the work since has finished the message. A stop carrying a
	 * failure, or any throwable escaping the body, makes the result a plain stop
	 * or a failure, so the reader replays or dead-letters rather than commit.
	 * Reentrant: an inner bracket keeps its stops apart from the outer one's.
	 *
	 * @api
	 * @param \Closure $body The message's work, as `function(): void`.
	 * @throws \Throwable The combination of every held stop and whatever escaped `$body`.
	 */
	protected function deferring( \Closure $body ): void {
		$outer                = $this->deferred_stops;
		$this->deferred_stops = [];
		$escaped              = null;
		try {
			$body();
		} catch ( \Throwable $e ) {
			$escaped = $e;
		}
		$held                 = $this->deferred_stops;
		$this->deferred_stops = $outer;
		// Every firehose line passes here: the quiet path builds nothing.
		if ( [] === $held && null === $escaped ) {
			return;
		}
		$caught = \array_map( self::finished( ... ), $held );
		if ( null !== $escaped ) {
			$caught[] = $escaped;
		}
		Worker_Should_Stop::raise( $caught );
	}

	/**
	 * Run a downstream forward. Inside a bracket a Worker_Should_Stop waits for
	 * the message to finish; outside one it propagates at once. A non-stop
	 * throwable always propagates at once, and the bracket combines it with any
	 * stop already held.
	 *
	 * @api
	 * @param \Closure $forward The downstream forward to run, as `function(): void`.
	 */
	protected function guarded( \Closure $forward ): void {
		try {
			$forward();
		} catch ( Worker_Should_Stop $e ) {
			if ( null === $this->deferred_stops ) {
				throw $e;
			}
			$this->deferred_stops[] = $e;
		}
	}

	/**
	 * What a held stop means once its message is finished: a bare plain stop
	 * becomes clean; anything else stays as it was raised.
	 *
	 * @param Worker_Should_Stop $stop A stop `guarded()` held.
	 */
	private static function finished( Worker_Should_Stop $stop ): Worker_Should_Stop {
		return Worker_Should_Stop::is_bare( $stop ) ? new Worker_Should_Stop_Clean() : $stop;
	}
}
