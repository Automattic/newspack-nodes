<?php
/**
 * Probe_Record: the positional layout of a topicprobe.p0 record's Message VALUE.
 *
 * A `TopicProbe` snapshot is a small POSITIONAL array (no keys) so the browser
 * can replay 24h of it over SSE cheaply. It is the raw consumer/partition state
 * at one instant — the Message's TIMESTAMP is the time; everything else (rates,
 * totals) is DERIVED by readers from consecutive records, never logged.
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
	public const CURSOR_SEG = 2;

	/** Consumer offset: byte within the cursor segment. */
	public const CURSOR_OFF = 3;

	/** Partition end: id of the last (newest) segment. */
	public const END_SEG = 4;

	/** Partition end: size of that last segment. */
	public const END_SIZE = 5;

	/** Distance: bytes the consumer is behind (the backlog), for the overview graph. */
	public const DISTANCE = 6;

	/** Messages the consumer has sent. */
	public const MSGS = 7;

	/** Absolute partition byte position (Σ live segment sizes); readers derive the byte rate from its delta. */
	public const END_BYTES = 8;

}
