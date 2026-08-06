/**
 * Positional layout of a topicprobe.p0 record's Message VALUE — a SELF-CONTAINED
 * consumer/partition snapshot: the work done since the previous sweep plus the
 * interval it covers, so a reader divides ONE record and never differences across
 * records. Small + positional (no keys) so the browser can replay 24h of it over
 * SSE cheaply. Mirrors includes/class-probe-record.php (a parity test pins these).
 */

export const SOURCE = 0; // source partition, e.g. "firehose.p0"
// 2..5 (cursor/end) + 8 (END_BYTES) are PHP-write-only; the rest are pinned.
export const READER = 1; // reader id = basename of the offsetlog dir
export const DISTANCE = 6; // bytes behind (the backlog)
export const MSGS_DELTA = 7; // messages the consumer sent during ELAPSED_MS
export const CACHE_SIZE = 9; // offsetlog cache size: byte size of the newest offsetlog segment
export const BYTES_READ_DELTA = 10; // bytes the consumer read during ELAPSED_MS
export const ELAPSED_MS = 11; // milliseconds the deltas above cover
