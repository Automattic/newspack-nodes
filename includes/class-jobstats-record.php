<?php
/**
 * Jobstats_Record: the positional layout of a jobstats.p0 record's Message VALUE.
 *
 * A `Job_Probe` snapshot is a small POSITIONAL array (no keys) so the browser can
 * replay 24h of it over SSE cheaply. Fields 2..7 are CUMULATIVE counters — readers
 * derive per-second rates from consecutive records (Δcounter / Δ TIMESTAMP), and a
 * worker restart reads as a counter reset → rate 0. Fields 8..11 are the last-run
 * detail. The Message's TIMESTAMP is the sweep instant, never duplicated here.
 *
 * Indices mirror `src/runtime/jobstats-record.js` (a parity test pins them).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Jobstats_Record {

	/** Job identity: `handler:id` (top-level `id` present) or `handler`. */
	public const KEY = 0;

	/** Handler name (grouping/display; the `id`-free half of KEY). */
	public const HANDLER = 1;

	/** Cumulative runs (every executed job, success or error). */
	public const RUNS = 2;

	/** Cumulative error-status runs (a subset of RUNS). */
	public const ERRORS = 3;

	/** Cumulative sum of run durations, milliseconds. */
	public const DURATION_MS = 4;

	/** Cumulative sum of queue latencies (start − enqueue ts), milliseconds. */
	public const QUEUE_MS = 5;

	/** Cumulative sum of handler-reported success_count (negative sentinel dropped). */
	public const ITEMS_OK = 6;

	/** Cumulative sum of handler-reported error_count. */
	public const ITEMS_ERR = 7;

	/** Wall-clock epoch (seconds) of the last run. */
	public const LAST_TS = 8;

	/** Duration of the last run, milliseconds. */
	public const LAST_DURATION_MS = 9;

	/** Status of the last run: `success` or `error`. */
	public const LAST_STATUS = 10;

	/** One-line summary of the last run (capped). */
	public const LAST_MESSAGE = 11;

}
