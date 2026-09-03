/**
 * The index constants a browser reader of a `topicprobe.p0` record addresses
 * its positional Message VALUE through.
 *
 * A `Topic_Probe` sweep emits one record per READY Consumer as a small
 * POSITIONAL array (no keys), so the dashboard replays a 24-hour window of it
 * over SSE cheaply. Each record is SELF-CONTAINED: MSGS_DELTA and
 * BYTES_READ_DELTA are the work done since that reader's previous sweep and
 * ELAPSED_MS is the interval covering it, so a reader divides ONE record and
 * never differences across records — a worker recycles roughly every 595
 * seconds, and differencing reads that recycle as a counter reset. SOURCE,
 * READER, DISTANCE and CACHE_SIZE are positions and levels read off disk,
 * correct as they stand across a restart. The Message TIMESTAMP is the sweep
 * instant, never duplicated here.
 *
 * Indices mirror `includes/class-probe-record.php`, which declares twelve
 * slots. The five missing here — the cursor pair, the partition-end pair and
 * END_BYTES — are PHP-write-only, rendered by `CLI::consumer_rows()` for `wp
 * nodes status`, which is why this file's numbering has gaps. The seven shared
 * values are pinned on both sides by `tests/unit/ProbeRecordTest.php`, because
 * a reader one slot off misreads every field after it.
 */

/**
 * What the reader tails: the basename of the partition directory
 * (`firehose.p0`), or the followed filename for a `File_Tail` (`debug.log`).
 * Blank when the node has no source configured. `TopicProbeViewNode` keeps it
 * on the consumer's entry rather than on each sample, because it names the
 * topic every one of that reader's samples came from.
 */
export const SOURCE = 0;

/**
 * Reader id — the basename of the consumer's offsetlog directory, which is
 * what tells two readers of one partition apart. `TopicProbeViewNode` keys its
 * per-consumer series by this slot, so an ephemeral reader, which has no
 * offsetlog dir and writes this blank, drops out of the charts instead of
 * colliding with its peers.
 */
export const READER = 1;

/**
 * Distance: bytes the consumer is behind. The overview graph plots it as a
 * level, not a rate — it is the backlog standing at the sweep instant.
 */
export const DISTANCE = 6;

/** Messages the consumer sent during ELAPSED_MS. */
export const MSGS_DELTA = 7;

/**
 * Offsetlog cache size: byte size of the consumer's newest offsetlog segment.
 * 0 for an ephemeral reader, and before the first checkpoint writes a segment.
 */
export const CACHE_SIZE = 9;

/**
 * Bytes this reader read during ELAPSED_MS. It cannot fall when retention
 * deletes a segment, the way the partition's on-disk footprint does, which is
 * why the byte-rate charts divide this one.
 */
export const BYTES_READ_DELTA = 10;

/**
 * Milliseconds the deltas above cover — the interval since this consumer's
 * previous sweep, which opens at the Consumer's construction, so the first
 * record covers time since birth.
 */
export const ELAPSED_MS = 11;
