/**
 * Current fleet-global produced message rate (messages/sec) for the SummaryCards
 * "Messages/s" card: Σ over distinct sources of each source's latest msgRate.
 *
 * The probe's `SOURCE` is the per-PARTITION log a consumer tails (`firehose.p0`),
 * and `msgRate` is that partition's production rate (the record's own
 * MSGS_DELTA over its ELAPSED_MS). So co-readers
 * of ONE source (two topologies tailing `firehose.p0`) report the SAME rate — we
 * dedup them by source (max), never sum — while a topic's distinct partitions are
 * distinct sources (`firehose.p0`, `firehose.p1`), summed for the topic total.
 * We read each consumer's view-computed `latest` sample, not the raw series.
 */

/**
 * @param {Object<string,{source:string,latest:{msgRate:number}}>} consumers The `topicprobe:view` consumers map.
 * @return {number} Summed latest msgRate across distinct sources (0 if none).
 */
export function globalMsgRate( consumers ) {
	// source → max latest msgRate across co-readers (max dedups, no summing).
	const bySource = new Map();
	for ( const c of Object.values( consumers || {} ) ) {
		const source = c.source || '';
		if ( '' === source ) {
			continue;
		}
		const rate = c.latest?.msgRate || 0;
		bySource.set( source, Math.max( bySource.get( source ) || 0, rate ) );
	}

	let total = 0;
	for ( const rate of bySource.values() ) {
		total += rate;
	}
	return total;
}
