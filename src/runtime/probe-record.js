/**
 * The index constants a browser reader of a `topicprobe.p0` record addresses
 * its positional Message VALUE through.
 *
 * A `Topic_Probe` sweep emits two kinds of record into one POSITIONAL array
 * (no keys), so the dashboard replays a 24-hour window of it over SSE
 * cheaply. A Consumer record carries one reader's stats and names it in
 * READER; a Partition record carries one directory's size and leaves READER
 * blank, which is what marks it. A Partition record fills SOURCE,
 * END_SEGMENT, END_SIZE, END_BYTES and END_DISK_BYTES; a Consumer record
 * fills every slot but END_BYTES and END_DISK_BYTES. A slot a kind never
 * fills is 0. A Consumer record is SELF-CONTAINED:
 * MSGS_DELTA and BYTES_READ_DELTA are the work done since that reader's
 * previous sweep and ELAPSED_MS is the interval covering it, so a reader
 * divides ONE record and never differences across records — a worker
 * recycles roughly every 595 seconds, and differencing reads that recycle as
 * a counter reset. Every other slot is a position or a level read off disk,
 * correct as it stands across a restart. The Message TIMESTAMP is the sweep
 * instant, never duplicated here.
 *
 * Indices mirror `includes/class-probe-record.php`, which declares thirteen
 * slots. The four missing here — the cursor pair and the partition-end pair
 * — are PHP-write-only, rendered by `CLI::consumer_rows()` for `wp nodes
 * status`, which is why this file's numbering has gaps. The nine shared
 * values are pinned on both sides by `tests/unit/ProbeRecordLayoutsTest.php`,
 * because a reader one slot off misreads every field after it.
 */

/**
 * What the record is about. On a Consumer record, the basename of the partition
 * directory it tails (`firehose.p0`) or a `File_Tail`'s filename;
 * `TopicProbeViewNode` keeps it on the consumer's entry rather than on each
 * sample, because it names the topic every one of that reader's samples came
 * from. On a Partition record, the log's SSE stamp (`firehose.p0`,
 * `offsets/…`), or its path under the runtime base outside the stamped roots,
 * which the view keys partitions by.
 */
export const SOURCE = 0;

/**
 * The reader id, the basename of the consumer's offsetlog directory, which
 * tells two readers of one partition apart. `TopicProbeViewNode` keys its
 * per-consumer series by this slot. Blank on a Partition record, and only
 * there.
 */
export const READER = 1;

/**
 * Bytes the consumer is behind. The overview graph plots it as a level, not a
 * rate — it is the backlog standing at the sweep instant.
 */
export const DISTANCE = 6;

/** Messages the consumer sent during ELAPSED_MS. */
export const MSGS_DELTA = 7;

/**
 * The partition's byte length, the sum of the live segments' sizes. A level the
 * Overview's Partition Size panel holds, never a rate source.
 */
export const END_BYTES = 8;

/**
 * Byte size of the consumer's newest offsetlog segment. 0 for an ephemeral
 * reader, and before the first checkpoint writes a segment.
 */
export const CACHE_SIZE = 9;

/**
 * Bytes this reader read during ELAPSED_MS. It cannot fall when retention
 * deletes a segment, the way END_BYTES does, which is why the byte-rate charts
 * divide this one.
 */
export const BYTES_READ_DELTA = 10;

/**
 * Milliseconds the deltas above cover — the interval since this consumer's
 * previous sweep, which opens at the Consumer's construction, so the first
 * record covers time since birth.
 */
export const ELAPSED_MS = 11;

/**
 * The disk the partition's live segments take, the sum of each one's
 * `blocks × 512`, which the Overview's On Disk panel holds as a level.
 */
export const END_DISK_BYTES = 12;
