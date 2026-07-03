/**
 * Positional layout of a topicprobe.p0 record's Message VALUE — the raw
 * consumer/partition snapshot at one instant. Small + positional (no keys) so
 * the browser can replay 24h of it over SSE cheaply; rates/totals are DERIVED
 * from consecutive records, never logged. Mirrors includes/class-probe-record.php
 * (a parity test pins the indices).
 */

export const SOURCE = 0; // source partition, e.g. "firehose.p0"
export const READER = 1; // reader id = basename of the offsetlog dir
export const CURSOR_SEGMENT = 2; // consumer offset: segment id
export const CURSOR_OFF = 3; // consumer offset: byte within the cursor segment
export const END_SEGMENT = 4; // partition end: last segment id
export const END_SIZE = 5; // partition end: last segment size
export const DISTANCE = 6; // bytes behind (the backlog)
export const MSGS = 7; // messages the consumer has sent
export const END_BYTES = 8; // absolute partition byte position (Σ live segment sizes); byte rate = Δ/Δt
export const CACHE_SIZE = 9; // offsetlog cache size: byte size of the newest offsetlog segment
