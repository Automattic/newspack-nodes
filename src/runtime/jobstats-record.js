/**
 * Positional layout of a jobstats.p0 record's Message VALUE — a per-handler job
 * snapshot at one instant. Small + positional (no keys) so the browser can replay
 * 24h of it over SSE cheaply. Fields 2..7 are CUMULATIVE counters (readers derive
 * per-second rates from consecutive records, Δ/Δts); fields 8..11 are the last-run
 * detail. Mirrors includes/class-jobstats-record.php (a parity test pins indices).
 */

export const KEY = 0; // job identity: "handler:id" or "handler"
export const HANDLER = 1; // handler name (the id-free half of KEY)
export const RUNS = 2; // cumulative runs (success or error)
export const ERRORS = 3; // cumulative error-status runs
export const DURATION_MS = 4; // cumulative sum of run durations (ms)
export const QUEUE_MS = 5; // cumulative sum of queue latencies (ms)
export const ITEMS_OK = 6; // cumulative sum of handler success_count (>=0)
export const ITEMS_ERR = 7; // cumulative sum of handler error_count
export const LAST_TS = 8; // wall-clock epoch (s) of the last run
export const LAST_DURATION_MS = 9; // last run duration (ms)
export const LAST_STATUS = 10; // last run status: "success" | "error"
export const LAST_MESSAGE = 11; // last run one-line summary (capped)
