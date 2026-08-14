/**
 * Positional layout of a jobstats.p0 record's Message VALUE — a SELF-CONTAINED
 * per-identity job snapshot. Fields 2..7 are the work done since the previous
 * sweep and ELAPSED_MS is the interval it covers, so a reader divides ONE record
 * and never differences across records; fields 8..11 are the last-run detail.
 * Small + positional (no keys) so the browser can replay 24h of it over SSE
 * cheaply. Mirrors includes/class-jobstats-record.php (a parity test pins these).
 */

export const IDENTITY = 0; // job identity: "handler:id" or "handler"
export const HANDLER = 1; // handler name (the id-free half of IDENTITY)
export const RUNS_DELTA = 2; // runs during ELAPSED_MS (success or error)
export const ERRORS_DELTA = 3; // error-status runs during ELAPSED_MS
export const DURATION_MS_DELTA = 4; // Σ run durations during ELAPSED_MS (ms)
export const QUEUE_MS_DELTA = 5; // Σ queue latencies during ELAPSED_MS (ms)
export const ITEMS_OK_DELTA = 6; // Σ handler success_count during ELAPSED_MS (>=0)
export const ITEMS_ERR_DELTA = 7; // Σ handler error_count during ELAPSED_MS
export const LAST_TS = 8; // wall-clock epoch (s) of the last run
export const LAST_DURATION_MS = 9; // last run duration (ms)
export const LAST_STATUS = 10; // last run status: "success" | "error"
export const LAST_MESSAGE = 11; // last run one-line summary (capped)
export const ELAPSED_MS = 12; // milliseconds the deltas above cover
