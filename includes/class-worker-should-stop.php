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
class Worker_Should_Stop extends \RuntimeException {}
