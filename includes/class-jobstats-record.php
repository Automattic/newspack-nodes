<?php
/**
 * Jobstats_Record: the positional layout of a jobstats.p0 record's Message VALUE.
 *
 * A `Job_Probe` snapshot is a small POSITIONAL array (no keys) so the browser can
 * replay 24h of it over SSE cheaply. Each record is SELF-CONTAINED: fields 2..7
 * are the work done since the previous sweep and `ELAPSED_MS` is the interval that
 * work covers, so a reader divides ONE record and never differences across records
 * — a worker recycles every ~595s, and differencing read that as a counter reset.
 * Fields 8..11 are the last-run detail. The Message's TIMESTAMP is the sweep
 * instant, never duplicated here.
 *
 * Indices mirror `src/runtime/jobstats-record.js` (a parity test pins them).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Jobstats_Record {

	/** Job identity: `handler:id` (top-level `id` present) or `handler`. */
	public const IDENTITY = 0;

	/** Handler name (grouping/display; the `id`-free half of IDENTITY). */
	public const HANDLER = 1;

	/** Runs during ELAPSED_MS (every executed job, success or error). */
	public const RUNS_DELTA = 2;

	/** Error-status runs during ELAPSED_MS (a subset of RUNS_DELTA). */
	public const ERRORS_DELTA = 3;

	/** Sum of run durations during ELAPSED_MS, milliseconds. */
	public const DURATION_MS_DELTA = 4;

	/** Sum of queue latencies (start − enqueue ts) during ELAPSED_MS, milliseconds. */
	public const QUEUE_MS_DELTA = 5;

	/** Sum of handler-reported success_count during ELAPSED_MS (negative sentinel dropped). */
	public const ITEMS_OK_DELTA = 6;

	/** Sum of handler-reported error_count during ELAPSED_MS. */
	public const ITEMS_ERR_DELTA = 7;

	/** Wall-clock epoch (seconds) of the last run. */
	public const LAST_TS = 8;

	/** Duration of the last run, milliseconds. */
	public const LAST_DURATION_MS = 9;

	/** Status of the last run: `success` or `error`. */
	public const LAST_STATUS = 10;

	/** One-line summary of the last run (capped). */
	public const LAST_MESSAGE = 11;

	/** Milliseconds the deltas above cover — the interval since this identity's previous sweep. */
	public const ELAPSED_MS = 12;

}
