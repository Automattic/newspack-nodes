/**
 * The index constants a browser reader of a `tablestats.p0` record addresses
 * its positional Message VALUE through, and the ROW_ constants that index
 * one operation's row inside VERBS.
 *
 * A `Table_Probe` sweep emits one record per Table: VERBS maps each operation
 * called in the window to its row, and ELAPSED_MS is the interval that work
 * covers, so a reader divides ONE record and never differences across
 * records. An operation absent from VERBS did nothing in the window. The
 * Message TIMESTAMP is the sweep instant.
 *
 * Indices mirror `includes/class-tablestats-record.php`, and
 * `tests/unit/ProbeRecordLayoutsTest.php` pins both halves.
 */

/** `{table}.p{N}`; the view keys each Table's series by this slot. */
export const IDENTITY = 0;

/** The backend the Table names. */
export const BACKEND = 1;

/** Operation name to its window's row. */
export const VERBS = 2;

/** 1 while the Table's last purge came back full, else 0. */
export const PURGE_BEHIND = 3;

/** WAL checkpoints in a row that left frames behind. */
export const WAL_STALLED = 4;

/** db + -wal + -shm bytes of a SQLite Table; 0 for any other backend. */
export const FILE_BYTES = 5;

/** Milliseconds the window covers. */
export const ELAPSED_MS = 6;

/** A row's calls in the window. */
export const ROW_CALLS = 0;

/** Keys or rows the calls asked. */
export const ROW_ASKED = 1;

/** Keys or rows answered or written. */
export const ROW_ANSWERED = 2;

/** Encoded bytes a durable arm handled. */
export const ROW_BYTES = 3;

/** Total milliseconds, all calls together. */
export const ROW_MS = 4;

/** The longest call in the window, in milliseconds. */
export const ROW_MAX_MS = 5;

/** Requests answered with a TM_ERROR. */
export const ROW_ERRORS = 6;
