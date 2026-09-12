<?php
/**
 * Worker_Should_Stop: cooperative-stop signal raised from inside a long job.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Raised by `Event_Framework::stop_check()`, and by `pump()` calling it on its
 * throttle, when the worker's parked continue-predicate says stop while a long
 * in-process job starves the drain loop. `Cooperative_Stop::should_continue()` owns
 * the triggers: the lock lost, its directory gone, the lock flagged or stolen, a stop
 * requested, `max_runtime` elapsed, memory over the watermark, or three consecutive
 * DB-probe failures. It is asked mid-work, which skips the on-demand idle branch, so
 * an idle exit never raises this.
 *
 * Unwinding the whole `fill()` stack is the point, and it extends `\RuntimeException`,
 * so a broad catch on the drain path re-throws it before handling anything else
 * (ADR-14). Logging it, wrapping it as TM_ERROR or deferring it as an error swallows
 * the stop, and the worker runs past its deadline until the next drain tick.
 * `Job_Worker_Node` re-throws it past its per-job Throwable swallow, `after_job` still
 * fires, and `Worker_Base::execute()` catches it as a normal stop whose `finally`
 * hands off cursors, releases the lock and self-respawns.
 *
 * The plain form leaves the consumer cursor where it is, so the successor replays the
 * in-flight message; the `Worker_Should_Stop_Clean` subclass is what says that message
 * finished and the cursor may commit past it. A shared `Control_Flow` base would buy
 * nothing while the family is those two — catching this parent first covers both.
 */
class Worker_Should_Stop extends \RuntimeException {

	/**
	 * The fan-out loop itself: offer `$fn` every item, catching what each throws
	 * and keeping the one throwable `outranks()` ranks safest. It RETURNS that
	 * throwable rather than raising it, so a caller with work of its own to
	 * finish first — Tap's passthrough — raises it when it is ready.
	 *
	 * @param iterable<mixed,mixed> $items What to offer, in order.
	 * @param callable              $fn    Called with (value, key) for each item.
	 * @return \Throwable|null The failure to raise after the loop, or null when every item passed.
	 */
	public static function attempt_each( iterable $items, callable $fn ): ?\Throwable {
		$deferred = null;
		foreach ( $items as $key => $value ) {
			try {
				$fn( $value, $key );
			} catch ( \Throwable $e ) {
				if ( self::outranks( $e, $deferred ) ) {
					$deferred = $e;
				}
			}
		}
		return $deferred;
	}

	/**
	 * Whether a newly-caught throwable should displace the one a fan-out has
	 * already deferred.
	 *
	 * A fan-out attempts every target and re-throws afterwards, so several may
	 * fail in one pass and only one can escape. The winner is the one whose
	 * handling is safest, because that choice moves the consumer cursor. A plain
	 * stop replays the message and the cursor stays put; the clean subtype
	 * commits past it; anything else is poison, which dead-letters and advances
	 * too. Advancing past a message that needed a replay loses it; replaying a
	 * clean one is a duplicate, which at-least-once tolerates. So a plain stop
	 * outranks both, in either arrival order (ADR-14).
	 *
	 * @param \Throwable      $candidate The throwable this target just raised.
	 * @param \Throwable|null $deferred  What the loop already holds; null until the first failure.
	 * @return bool True when `$candidate` should take the deferred slot.
	 */
	public static function outranks( \Throwable $candidate, ?\Throwable $deferred ): bool {
		if ( null === $deferred ) {
			return true;
		}
		return $candidate instanceof self
			&& ( ! ( $deferred instanceof self ) || $deferred instanceof Worker_Should_Stop_Clean );
	}
}
