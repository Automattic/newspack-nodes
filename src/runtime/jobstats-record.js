/**
 * The index constants a browser reader of a `jobstats.p0` record addresses its
 * positional Message VALUE through.
 *
 * A `Job_Probe` sweep emits one record per job identity as a small POSITIONAL
 * array (no keys), so the dashboard replays a 24-hour window of it over SSE
 * cheaply. Each record is SELF-CONTAINED: fields 2..7 are the work done since
 * that identity's previous sweep and ELAPSED_MS is the interval covering it,
 * so a reader divides ONE record and never differences across records — a
 * worker recycles roughly every 595 seconds, and differencing reads that
 * recycle as a counter reset. Fields 8..11 are the last-run detail, which
 * survives the drain so an idle identity keeps its row. The Message TIMESTAMP
 * is the sweep instant, never duplicated here.
 *
 * Indices mirror `includes/class-jobstats-record.php`, and
 * `tests/unit/JobstatsRecordTest.php` pins both halves: a reader one slot off
 * misreads every field after it.
 */

/**
 * Job identity: `handler:id` when the entry carries a top-level `id`, else
 * `handler`. The view node keys its per-identity series by this slot.
 */
export const IDENTITY = 0;

/**
 * Handler name — the `id`-free half of IDENTITY, so a reader groups a
 * handler's ids without re-splitting the identity.
 */
export const HANDLER = 1;

/**
 * Runs during ELAPSED_MS, successful or failed. A job the `before_job` filter
 * declined and a job a cooperative stop aborted both record nothing, so this
 * counts work completed rather than entries dequeued.
 */
export const RUNS_DELTA = 2;

/**
 * Runs during ELAPSED_MS whose outcome classified as `error` — a subset of
 * RUNS_DELTA. A run that processed items AND reported errors classifies as
 * `success`, so its item-level failure lands in ITEMS_ERR_DELTA, not here.
 */
export const ERRORS_DELTA = 3;

/** Sum of run durations during ELAPSED_MS, in milliseconds. */
export const DURATION_MS_DELTA = 4;

/**
 * Sum of queue latencies (handler dispatch minus the entry's enqueue
 * timestamp) during ELAPSED_MS, in milliseconds. An entry carrying no
 * timestamp contributes zero, so the sum understates the wait rather than
 * inventing one.
 */
export const QUEUE_MS_DELTA = 5;

/**
 * Sum of handler-reported `success_count` during ELAPSED_MS. The -1 "no stats
 * reported" sentinel clamps to 0, so a silent handler adds nothing instead of
 * subtracting from the total.
 */
export const ITEMS_OK_DELTA = 6;

/** Sum of handler-reported `error_count` during ELAPSED_MS. */
export const ITEMS_ERR_DELTA = 7;

/**
 * Wall-clock epoch (seconds) of the last run. It survives the drain, so an
 * identity that ran in no recent window still reports when it last ran.
 */
export const LAST_TS = 8;

/** Duration of the last run, in milliseconds. */
export const LAST_DURATION_MS = 9;

/** Status of the last run: `success` or `error`. */
export const LAST_STATUS = 10;

/**
 * One-line summary of the last run, capped by the producer. It is the record's
 * only free text, so `Job_Probe_Node::fit_to_line()` trims this field and no
 * other to keep the write under PIPE_BUF — halving an identity would corrupt
 * what readers key on.
 */
export const LAST_MESSAGE = 11;

/**
 * Milliseconds the deltas above cover — the interval since this identity's
 * previous sweep, which opens at its first run.
 */
export const ELAPSED_MS = 12;
