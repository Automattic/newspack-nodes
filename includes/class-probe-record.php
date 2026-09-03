<?php
/**
 * The index constants every producer and reader of a `topicprobe.p0` record
 * addresses its positional Message VALUE through.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

/**
 * Probe_Record: the positional layout of a topicprobe.p0 record's Message
 * VALUE.
 *
 * A `Topic_Probe` snapshot is a small POSITIONAL array (no keys) so the
 * browser can replay 24h of it over SSE cheaply. Each record is
 * SELF-CONTAINED: the work `Consumer_Node::probe_stats()` drains for one
 * reader (`MSGS_DELTA`, `BYTES_READ_DELTA`) plus the `ELAPSED_MS` that work
 * covers, so a reader divides ONE record and never differences across records
 * — a worker recycles every ~595s, and differencing reads that recycle as a
 * counter reset. Every other slot is a POSITION or a LEVEL read off disk,
 * correct as it stands across a restart. The Message's TIMESTAMP is the sweep
 * instant, never duplicated here.
 *
 * Indices mirror `src/runtime/probe-record.js`, which declares only the seven
 * slots the browser reads; `tests/unit/ProbeRecordTest.php` pins those on both
 * sides plus the dense 0..11 ordering here, because a reader one slot off
 * misreads every field after it. The cursor and partition-end pairs stay
 * PHP-side, where `CLI::consumer_rows()` renders them for `wp nodes status`
 * and the Workers dashboard.
 */
class Probe_Record {

	/**
	 * What the reader tails: the basename of the partition directory
	 * (`firehose.p0`), or the followed filename for a `File_Tail`
	 * (`debug.log`). Blank when the node has no source configured.
	 */
	public const SOURCE = 0;

	/**
	 * Reader id — the basename of the consumer's offsetlog dir, which is
	 * what tells two readers of one partition apart. Every consumer of this
	 * log keys by it, so an ephemeral reader, which has no offsetlog dir and
	 * writes this blank, drops out of the status rows and the Graphite
	 * egress instead of colliding with its peers.
	 */
	public const READER = 1;

	/** Consumer offset: id of the segment the cursor sits in. */
	public const CURSOR_SEGMENT = 2;

	/** Consumer offset: byte within the cursor segment. */
	public const CURSOR_OFF = 3;

	/**
	 * Partition end: id of the last (newest) segment. One `compute_lag()`
	 * read captures the cursor and the end together, so a record never pairs
	 * a stale cursor with a fresh stat.
	 */
	public const END_SEGMENT = 4;

	/** Partition end: size of that last segment. */
	public const END_SIZE = 5;

	/**
	 * Distance: bytes the consumer is behind (the backlog), for the overview
	 * graph.
	 */
	public const DISTANCE = 6;

	/** Messages the consumer sent during ELAPSED_MS. */
	public const MSGS_DELTA = 7;

	/**
	 * Absolute partition byte position (Σ live segment sizes) — the on-disk
	 * footprint, NOT a rate source: retention deleting a segment makes it
	 * fall. Nothing reads it; a byte rate divides BYTES_READ_DELTA.
	 */
	public const END_BYTES = 8;

	/**
	 * Offsetlog cache size: byte size of the consumer's newest offsetlog
	 * segment. 0 for an ephemeral reader and before the first checkpoint
	 * writes a segment.
	 */
	public const CACHE_SIZE = 9;

	/**
	 * Bytes this reader read during ELAPSED_MS. Unlike END_BYTES it cannot
	 * fall when retention deletes a segment, which is why the byte-rate
	 * charts and the Graphite egress divide this one.
	 */
	public const BYTES_READ_DELTA = 10;

	/**
	 * Milliseconds the deltas above cover — the interval since this
	 * consumer's previous sweep, which opens at the Consumer's construction,
	 * so the first record covers time since birth.
	 */
	public const ELAPSED_MS = 11;

}
