<?php
/**
 * The index constants every producer and reader of a `jobstats.p0` record
 * addresses its positional Message VALUE through.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Jobstats_Record: the positional layout of a jobstats.p0 record's Message VALUE.
 *
 * A `Job_Probe` snapshot is a small POSITIONAL array (no keys) so the browser can
 * replay 24h of it over SSE cheaply. Each record is SELF-CONTAINED: fields 2..7
 * are the work `Job_Worker_Node::probe_stats()` drains for one job identity and
 * `ELAPSED_MS` is the interval that work covers, so a reader divides ONE record
 * and never differences across records — a worker recycles every ~595s, and
 * differencing reads that recycle as a counter reset. Fields 8..11 are the
 * last-run detail, which survives the drain so an idle identity keeps its row.
 * The Message's TIMESTAMP is the sweep instant, never duplicated here.
 *
 * Indices mirror `src/runtime/jobstats-record.js`, and
 * `tests/unit/JobstatsRecordTest.php` pins both halves: a browser reading one
 * slot off misreads every field after it.
 */
class Jobstats_Record {

	/** Job identity: `handler:id` when the entry carries a top-level `id`, else `handler`. */
	public const IDENTITY = 0;

	/** Handler name — the `id`-free half of IDENTITY, so a reader groups a handler's ids without re-splitting. */
	public const HANDLER = 1;

	/**
	 * Runs during ELAPSED_MS, successful or failed. A job the `before_job` filter
	 * declined and a job a cooperative stop aborted both record nothing, so this
	 * counts work completed rather than entries dequeued.
	 */
	public const RUNS_DELTA = 2;

	/**
	 * Runs during ELAPSED_MS whose outcome classified as `error` — a subset of
	 * RUNS_DELTA. A run that processed items AND reported errors classifies as
	 * `success`, so its item-level failure lands in ITEMS_ERR_DELTA, not here.
	 */
	public const ERRORS_DELTA = 3;

	/** Sum of run durations during ELAPSED_MS, milliseconds, taken off the real clock rather than the frozen `Core::$now`. */
	public const DURATION_MS_DELTA = 4;

	/**
	 * Sum of queue latencies (handler dispatch minus the entry's enqueue timestamp)
	 * during ELAPSED_MS, milliseconds. An entry carrying no timestamp contributes
	 * zero, so the sum understates the wait rather than inventing one.
	 */
	public const QUEUE_MS_DELTA = 5;

	/**
	 * Sum of handler-reported `success_count` during ELAPSED_MS. The -1 "no stats
	 * reported" sentinel clamps to 0, so a silent handler adds nothing instead of
	 * subtracting from the total.
	 */
	public const ITEMS_OK_DELTA = 6;

	/** Sum of handler-reported `error_count` during ELAPSED_MS. */
	public const ITEMS_ERR_DELTA = 7;

	/** Wall-clock epoch (seconds) of the last run, drained records included. */
	public const LAST_TS = 8;

	/** Duration of the last run, milliseconds. */
	public const LAST_DURATION_MS = 9;

	/** Status of the last run: `success` or `error`. */
	public const LAST_STATUS = 10;

	/**
	 * One-line summary of the last run, capped at
	 * `Job_Worker_Node::MAX_STAT_MESSAGE_LEN`. It is the record's only free text,
	 * so `Job_Probe_Node::fit_to_line()` trims this field and no other to keep the
	 * write under PIPE_BUF — halving an identity would corrupt what readers key on.
	 */
	public const LAST_MESSAGE = 11;

	/** Milliseconds the deltas above cover — the interval since this identity's previous sweep, which opens at its first run. */
	public const ELAPSED_MS = 12;

}
