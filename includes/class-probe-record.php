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
 * A `Topic_Probe` sweep writes two kinds of record into one layout, as a
 * small POSITIONAL array (no keys) so the browser can replay 24h of it over
 * SSE cheaply. A CONSUMER record (`Consumer_Node::probe_stats()`) carries one
 * reader's stats and names it in READER. A PARTITION record
 * (`Partition_Node::probe_stats()`) carries one directory's size and leaves
 * READER blank, which is what marks it. A Partition record fills SOURCE,
 * END_SEGMENT, END_SIZE, END_BYTES and END_DISK_BYTES; a Consumer record
 * fills every slot but END_BYTES and END_DISK_BYTES. Both builders start
 * from `BLANK`, so a slot a kind never fills is 0.
 *
 * Either durable reader writes a CONSUMER record: a `Consumer_Node` and a
 * broker's `Remote_Consumer_Node`, both through
 * `Durable_Reader::probe_record()`. A slot a reader cannot know is null, the
 * one place a Consumer record carries one: a broker's reader cannot see its
 * spoke's log end, so its END pair and DISTANCE are always null, and a
 * cursor segment is null until the spoke, or for a `File_Tail` the file it
 * opens, names the generation.
 *
 * A Consumer record is SELF-CONTAINED: the work it drains for one reader
 * (`MSGS_DELTA`, `BYTES_READ_DELTA`) plus the `ELAPSED_MS` that work covers,
 * so a reader divides ONE record and never differences across records — a
 * worker recycles every ~595s, and differencing reads that recycle as a
 * counter reset. Every other slot is a POSITION or a LEVEL read off disk,
 * correct as it stands across a restart. The Message's TIMESTAMP is the
 * sweep instant, never duplicated here.
 *
 * Indices mirror `src/runtime/probe-record.js`, which declares only the nine
 * slots the browser reads; `tests/unit/ProbeRecordLayoutsTest.php` pins those
 * on both sides plus the dense 0..12 ordering and `BLANK` here, because a
 * reader one slot off misreads every field after it. The cursor and partition-end pairs stay
 * PHP-side, where `CLI::consumer_rows()` renders them for `wp nodes status`
 * and the Workers dashboard.
 */
class Probe_Record {

	/**
	 * What the record is about. On a Consumer record, the basename of the
	 * partition directory it tails (`firehose.p0`), the followed filename
	 * for a `File_Tail` (`debug.log`), or the spoke's log a broker's reader
	 * carries, named `Log_Discovery::remote_for()`'s way
	 * (`remote/austin:firehose.p0`), blank when the node has no source
	 * configured; `CLI::relag_from_disk()` rebuilds paths from it. On a
	 * Partition record, the log's SSE stamp (`firehose.p0`, `offsets/…`), or
	 * its path under the runtime base outside the stamped roots
	 * (`ipc/<worker-id>/output`), since a basename names many directories.
	 */
	public const SOURCE = 0;

	/**
	 * The reader id, the basename of the consumer's offsetlog dir, which is
	 * what tells two readers of one partition apart; a broker's reader reports
	 * under `Remote_Source_Node::reader_id()`. Blank on a Partition
	 * record, and only there: `Topic_Probe` sends no record for an
	 * ephemeral reader, which has no offsetlog dir to name. Every consumer of
	 * this log keys readers by it, so a blank one drops out of the status
	 * rows and the Graphite egress.
	 */
	public const READER = 1;

	/** Id of the segment the cursor sits in; null where the reader does not know it. */
	public const CURSOR_SEGMENT = 2;

	/** Byte within the cursor segment. */
	public const CURSOR_OFF = 3;

	/**
	 * Id of the partition's last (newest) segment. One `compute_lag()` read
	 * captures a Consumer's cursor and end together, so a record never pairs
	 * a stale cursor with a fresh stat. Null for a broker's reader, which
	 * cannot see its spoke's end.
	 */
	public const END_SEGMENT = 4;

	/** Size of that last segment; null for a broker's reader. */
	public const END_SIZE = 5;

	/**
	 * Bytes from the cursor to the log's end, in the log's own bytes: the
	 * backlog the overview graph plots and the `consumer-lag` alert reads.
	 * Null for a broker's reader, which cannot see its spoke's end.
	 */
	public const DISTANCE = 6;

	/** Messages the consumer sent during ELAPSED_MS. */
	public const MSGS_DELTA = 7;

	/**
	 * The partition's byte length, Σ live segment sizes. A level, NOT a rate
	 * source: retention deleting a segment makes it fall, so a byte
	 * rate divides BYTES_READ_DELTA.
	 */
	public const END_BYTES = 8;

	/**
	 * Byte size of the consumer's newest offsetlog segment. 0 for an
	 * ephemeral reader and before the first checkpoint writes a segment.
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

	/**
	 * The disk the partition's live segments take, Σ `blocks × 512`.
	 * Below END_BYTES on a compressing filesystem, above it where every
	 * segment's tail fills a whole block.
	 */
	public const END_DISK_BYTES = 12;

	/** Every slot in layout order: blank for the two names, 0 elsewhere. */
	public const BLANK = [ '', '', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ];
}
