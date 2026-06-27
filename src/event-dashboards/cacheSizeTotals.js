/**
 * Offsetlog cache-size totals for the SummaryCards "Avg / Total Cache" cards:
 * the average and sum of each reader's newest offsetlog-segment byte size.
 *
 * Unlike the rate cards, this is NOT deduped by source — the offsetlog is
 * per-CONSUMER (each reader keeps its own position cache), so two readers of one
 * source contribute two distinct caches. We read each consumer's view-computed
 * `latest.cacheSize`, not the raw series.
 */

/**
 * @param {Object<string,{latest:{cacheSize:number}}>} consumers The `topicprobe:view` consumers map.
 * @return {{total:number, avg:number}} Summed + averaged latest cache size (0/0 if none).
 */
export function cacheSizeTotals( consumers ) {
	const list = Object.values( consumers || {} );
	let total = 0;
	for ( const c of list ) {
		total += c.latest?.cacheSize || 0;
	}
	return { total, avg: list.length ? total / list.length : 0 };
}
