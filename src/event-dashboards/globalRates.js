/**
 * The fleet-global byte rates behind the SummaryCards "Read" and "Write" cards:
 * every reader's cursor advance summed, and every log partition's head advance
 * summed, both in bytes per second.
 *
 * The two maps `reconstructWorkers` builds are keyed differently, and that is
 * the whole difference between the sums. Read rates are keyed by READER id, so
 * two topologies tailing `firehose.p0` are two entries and both count — each
 * drags its own cursor through the full stream. One entry per reader is also
 * what makes the plain sum right for a reader that fans out to several
 * handlers: it moves those bytes once, so it must appear once. Write rates are
 * keyed by the concrete log-partition name (`firehose.p0`), one entry per
 * on-disk partition however many readers watch it, because the head advances
 * once. A topic's partitions are distinct keys either way, so `firehose.p0` and
 * `firehose.p1` sum into the topic's total.
 */

/**
 * Sum both rate maps independently.
 *
 * A non-numeric entry is skipped rather than added, because one `null` or one
 * string would carry NaN through to the card and hide every real rate behind
 * it. A missing map counts as empty, which is what a pre-poll render passes.
 *
 * @param {?Object<string,number>} byteRates  Read rate per reader id (`model.byteRates`).
 * @param {?Object<string,number>} writeRates Write rate per concrete log-partition name (`model.writeRates`).
 * @return {{readRate:number,writeRate:number}} Summed bytes per second; both 0 for empty maps.
 */
export function globalRates( byteRates, writeRates ) {
	const sum = ( map ) =>
		Object.values( map || {} ).reduce(
			( acc, v ) => acc + ( Number.isFinite( v ) ? v : 0 ),
			0
		);
	return { readRate: sum( byteRates ), writeRate: sum( writeRates ) };
}
