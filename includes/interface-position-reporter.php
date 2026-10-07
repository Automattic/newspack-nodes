<?php
/**
 * Position_Reporter: a durable reader that states where it stands on the one
 * live-position log.
 *
 * `Topic_Probe` writes every reader's cursor, backlog and throughput into
 * `topicprobe.p0`, and `wp nodes status`, the Workers dashboard, the
 * `consumer-lag` alert and the Aggregator cards all read that log through
 * `CLI::consumer_rows()`. The backlog is the distance from the cursor to the
 * log's end in the log's own bytes, and null where the reader cannot see the
 * end: a broker's reader never can, since nothing its spoke sends names the
 * end, so the `consumer-lag` alert covers a Consumer and never a hub reader. Two classes read durably — `Consumer_Node`, which
 * tails a local Partition, and `Remote_Consumer_Node`, which reads one stream
 * of a spoke's connection — and neither extends the other, so the probe claims
 * a reader by this contract rather than by class.
 *
 * @package Newspack_Nodes
 */

namespace Newspack_Nodes;

\defined( 'ABSPATH' ) || exit;

interface Position_Reporter {

	/**
	 * The CONSUMER `Probe_Record` for this reader: SOURCE, READER, the cursor
	 * and end pairs, the backlog, and the work since the previous call over
	 * the interval it covers.
	 *
	 * A DRAINING read: the counters re-baseline, so the sweep calls it once a
	 * reader per sweep. Null while the reader stands nowhere at all, which
	 * leaves its window open for the next sweep. A blank READER is a reader
	 * with no id to report under, and the probe drops it.
	 *
	 * @return array<int,int|string|null>|null A `Probe_Record`-indexed positional array, or null.
	 */
	public function probe_stats(): ?array;
}
