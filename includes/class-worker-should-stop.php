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
 * `Job_Worker_Node` records no job failure for it and re-throws it; `after_job` still
 * fires, a listener's throw joining the stop through `raise()`, and
 * `Worker_Base::execute()` treats it as a normal stop: it hands off cursors, releases
 * the lock and self-respawns.
 *
 * The plain form leaves the consumer cursor where it is, so the successor replays the
 * in-flight message; the `Worker_Should_Stop_Clean` subclass, carrying no previous
 * (`is_clean()`), is what says that message finished and the cursor may commit past
 * it. A shared `Control_Flow` base would buy nothing while the family is those two —
 * catching this parent first covers both.
 *
 * A stop is raised AFTER the in-flight record is written into the batch, and
 * `Partition_Node::maybe_stop()` then flushes that batch before re-raising. A plain
 * stop carrying a previous says that flush threw: the batch was cleared before the
 * failure, so the record is not durable. No reader may convert such a stop to clean,
 * and `Worker_Base::execute()` raises the previous once it has handed off, so the
 * failure outlives the stop instead of dying with it.
 *
 * A stop `combine()` builds to carry a failure reports that failure's
 * `getFile()` and `getLine()`, so a fatal attributed by file names the code
 * that failed; its trace still shows where the stop was assembled.
 */
class Worker_Should_Stop extends \RuntimeException {

	/**
	 * Throw what a loop caught, combined; do nothing when it caught nothing.
	 * It runs on every success path, so the empty case returns before any work.
	 *
	 * @param array<array-key,\Throwable> $caught Everything the loop caught; keys are ignored.
	 * @throws \Throwable The combination `combine()` returns.
	 */
	public static function raise( array $caught ): void {
		if ( [] !== $caught ) {
			throw self::combine( $caught );
		}
	}

	/**
	 * Combine what several steps threw into the one throwable that escapes.
	 *
	 * Clean only when every catch is clean. A stop when any catch is a stop,
	 * carrying every failure: each non-stop throwable, and each stop's own
	 * previous. With no stop, the failures propagate as they are — the one, or
	 * all of them as `Failures`, which flattens any `Failures` among them. No
	 * failure is ever dropped, and a clean stop beside a failure is a plain
	 * stop, so the reader replays (ADR-14).
	 *
	 * One instance counts once, however many ways it arrived: a memoized
	 * failure two collectors caught, or a failure beside the stop carrying it.
	 *
	 * @param array<array-key,\Throwable> $caught Everything the loop caught, in order; keys are ignored.
	 * @return ($caught is non-empty-array ? \Throwable : null) The throwable to raise, or null when nothing was caught.
	 */
	public static function combine( array $caught ): ?\Throwable {
		$first    = null;
		$stops    = [];
		$failures = [];
		$clean    = true;
		$seen     = [];
		foreach ( $caught as $e ) {
			if ( isset( $seen[ \spl_object_id( $e ) ] ) ) {
				continue;
			}
			$seen[ \spl_object_id( $e ) ] = true;
			$first ??= $e;
			$clean   = $clean && self::is_clean( $e );
			$failure = $e;
			if ( $e instanceof self ) {
				$stops[] = $e;
				$failure = $e->getPrevious();
				if ( null === $failure || isset( $seen[ \spl_object_id( $failure ) ] ) ) {
					continue;
				}
				$seen[ \spl_object_id( $failure ) ] = true;
			}
			$failures[] = $failure;
		}
		if ( null === $first || $clean ) {
			return $first;
		}
		if ( [] === $stops ) {
			return 1 === \count( $failures ) ? $first : new Failures( $failures );
		}
		return self::stop_carrying( $stops, $failures );
	}

	/**
	 * The one plain stop that reports every failure: the first plain stop
	 * already carrying exactly them — a `Failures` included — or, with none, a
	 * bare one; else a fresh stop carrying the failure, or all of them as
	 * `Failures`.
	 *
	 * @param non-empty-list<self> $stops    Every stop caught, in order.
	 * @param list<\Throwable>     $failures Every failure caught, in order, unflattened.
	 */
	private static function stop_carrying( array $stops, array $failures ): self {
		foreach ( $stops as $stop ) {
			$previous = $stop->getPrevious();
			$carries  = null === $previous ? [] : [ $previous ];
			if ( $carries === $failures && ! ( $stop instanceof Worker_Should_Stop_Clean ) ) {
				return $stop;
			}
		}
		$carried = 1 === \count( $failures ) ? $failures[0] : new Failures( $failures );
		$stop       = new self( $stops[0]->getMessage(), 0, $carried );
		$stop->file = $carried->getFile();
		$stop->line = $carried->getLine();
		return $stop;
	}

	/**
	 * Whether a throwable lets a durable reader commit past its message: a
	 * `Worker_Should_Stop_Clean` carrying nothing. PHP appends an in-flight
	 * exception as the previous of one thrown in a `finally`, so a clean stop
	 * can arrive carrying a failure, and then its record never became durable.
	 *
	 * @param \Throwable $e What a forward raised.
	 */
	public static function is_clean( \Throwable $e ): bool {
		return $e instanceof Worker_Should_Stop_Clean && null === $e->getPrevious();
	}

	/**
	 * Whether a throwable is a plain stop carrying nothing: the stop a forward
	 * raises when it has flushed its record and failed nothing, which a reader
	 * holding that record may finish as clean.
	 *
	 * @api Stable surface (docs/stability.md item 11).
	 * @param \Throwable $e What a forward raised.
	 */
	public static function is_bare( \Throwable $e ): bool {
		return $e instanceof self && ! ( $e instanceof Worker_Should_Stop_Clean ) && null === $e->getPrevious();
	}

	/**
	 * Run each closure whatever an earlier one threw, and return what they
	 * threw. Spreading a keyed array names the steps; the result is a list.
	 *
	 * @param \Closure(): mixed ...$steps In order.
	 * @return list<\Throwable> Everything caught, in order; empty when every step passed.
	 */
	public static function attempt( \Closure ...$steps ): array {
		$caught = [];
		foreach ( $steps as $step ) {
			try {
				$step();
			} catch ( \Throwable $e ) {
				$caught[] = $e;
			}
		}
		return $caught;
	}

	/**
	 * The fan-out loop itself: offer `$fn` every item and collect what each
	 * throws, under that item's key. It RETURNS the failures rather than
	 * raising them, so a caller with work of its own to finish first — Tap's
	 * passthrough — adds that work's failure and hands the lot to `raise()`,
	 * which ignores the keys. The items' keys must be unique, as an array's are.
	 *
	 * A fan-out offers every item, a stop included: each target must see the
	 * message. A long work loop that must honour a stop promptly takes
	 * `attempt_until_stop()` instead.
	 *
	 * @template K of array-key
	 * @template V
	 * @param iterable<K,V>        $items What to offer, in order.
	 * @param callable(V, K):mixed $fn    Called with (value, key) for each item.
	 * @return array<K,\Throwable> Everything caught, in order, keyed by item; empty when every item passed.
	 */
	public static function attempt_each( iterable $items, callable $fn ): array {
		$caught = [];
		foreach ( $items as $key => $value ) {
			try {
				$fn( $value, $key );
			} catch ( \Throwable $e ) {
				$caught[ $key ] = $e;
			}
		}
		return $caught;
	}

	/**
	 * A long work loop that honours a cooperative stop promptly: offer `$fn`
	 * each item in order, collect every failure under its item's key, and at
	 * the first `Worker_Should_Stop` return at once with everything caught so
	 * far, the stop included. The items it never offered are the successor's
	 * to replay. The items' keys must be unique, as an array's are.
	 *
	 * @api Stable surface (docs/stability.md item 11).
	 * @template K of array-key
	 * @template V
	 * @param iterable<K,V>        $items What to offer, in order.
	 * @param callable(V, K):mixed $fn    Called with (value, key) for each item.
	 * @return array<K,\Throwable> Everything caught, in order, keyed by item; a stop, when present, is last.
	 */
	public static function attempt_until_stop( iterable $items, callable $fn ): array {
		$caught = [];
		foreach ( $items as $key => $value ) {
			try {
				$fn( $value, $key );
			} catch ( Worker_Should_Stop $stop ) {
				$caught[ $key ] = $stop;
				return $caught;
			} catch ( \Throwable $e ) {
				$caught[ $key ] = $e;
			}
		}
		return $caught;
	}
}
