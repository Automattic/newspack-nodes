<?php
/**
 * Probe_Record: the positional layout of a topicprobe.p0 record's Message VALUE.
 *
 * A `Topic_Probe` snapshot is a small POSITIONAL array (no keys) so the browser
 * can replay 24h of it over SSE cheaply. Each record is SELF-CONTAINED: the work
 * done since the previous sweep (`MSGS_DELTA`, `BYTES_READ_DELTA`) plus the
 * `ELAPSED_MS` that work covers, so a reader divides ONE record. Every other slot
 * is a POSITION or LEVEL read off disk, already correct across a restart. Nothing
 * is derived by differencing consecutive records — a worker recycles every ~595s,
 * and differencing read that as a counter reset (a literal 0 on the chart).
 *
 * Indices mirror `src/runtime/probe-record.js` (a parity test pins them).
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

class Probe_Record {

	/** Source partition the consumer tails, e.g. `firehose.p0`. */
	public const SOURCE = 0;

	/** Reader id — basename of the consumer's offsetlog dir (distinguishes two readers of one partition). */
	public const READER = 1;

	/** Consumer offset: segment id. */
	public const CURSOR_SEGMENT = 2;

	/** Consumer offset: byte within the cursor segment. */
	public const CURSOR_OFF = 3;

	/** Partition end: id of the last (newest) segment. */
	public const END_SEGMENT = 4;

	/** Partition end: size of that last segment. */
	public const END_SIZE = 5;

	/** Distance: bytes the consumer is behind (the backlog), for the overview graph. */
	public const DISTANCE = 6;

	/** Messages the consumer sent during ELAPSED_MS. */
	public const MSGS_DELTA = 7;

	/** Absolute partition byte position (Σ live segment sizes) — the on-disk footprint, NOT a rate source. */
	public const END_BYTES = 8;

	/** Offsetlog cache size: byte size of the consumer's newest offsetlog segment (0 for ephemeral readers). */
	public const CACHE_SIZE = 9;

	/** Bytes the consumer read during ELAPSED_MS; unlike END_BYTES it cannot fall when retention deletes a segment. */
	public const BYTES_READ_DELTA = 10;

	/** Milliseconds the deltas above cover — the interval since this consumer's previous sweep. */
	public const ELAPSED_MS = 11;

}
