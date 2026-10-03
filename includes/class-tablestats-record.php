<?php
/**
 * The index constants every producer and reader of a `tablestats.p0` record
 * addresses its positional Message VALUE through.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Tablestats_Record: the positional layout of a tablestats.p0 record's
 * Message VALUE, one per Table per `Table_Probe` sweep.
 *
 * Each record is SELF-CONTAINED: `VERBS` holds the work each operation did
 * since that Table's previous sweep, and `ELAPSED_MS` the interval it covers,
 * so a reader divides ONE record and never differences across records — a
 * worker recycles every ~595s. `VERBS` maps an operation name to a
 * positional row the `ROW_*` constants index; an operation with no call in
 * the window is absent. The other slots are levels read at the sweep, each
 * null where the Table's backend has no such thing, so a reader learns what
 * applies from the record rather than from the backend's name. The Message
 * TIMESTAMP is the sweep instant, never duplicated here.
 *
 * Indices mirror `src/runtime/tablestats-record.js`, and
 * `tests/unit/ProbeRecordLayoutsTest.php` pins both halves.
 */
class Tablestats_Record {

	/** `{table}.p{N}`, the Table's file stem; its bare name with no partition bound. */
	public const IDENTITY = 0;

	/** The backend the Table names: memcache, apcu, sqlite, wpdb or auto. */
	public const BACKEND = 1;

	/** Operation name => its window's row, indexed by the ROW_* constants. */
	public const VERBS = 2;

	/** 1 while the last purge came back with a full batch, else 0; null off a durable arm. */
	public const PURGE_BEHIND = 3;

	/** WAL checkpoints in a row that left frames behind; null off SQLite. */
	public const WAL_STALLED = 4;

	/** db + -wal + -shm bytes of a SQLite Table; null for any other backend. */
	public const FILE_BYTES = 5;

	/** Milliseconds the window covers, from the Table's construction for the first. */
	public const ELAPSED_MS = 6;

	/** A row's calls in the window. */
	public const ROW_CALLS = 0;

	/** Keys or rows the calls asked, as `Table_Node::stats()` counts them. */
	public const ROW_ASKED = 1;

	/** Keys or rows answered or written. */
	public const ROW_ANSWERED = 2;

	/** Encoded bytes a durable arm handled; 0 on a volatile one. */
	public const ROW_BYTES = 3;

	/** Total milliseconds, all calls together. */
	public const ROW_MS = 4;

	/** The longest call in the window, in milliseconds. */
	public const ROW_MAX_MS = 5;

	/** Requests answered with a TM_ERROR. */
	public const ROW_ERRORS = 6;
}
