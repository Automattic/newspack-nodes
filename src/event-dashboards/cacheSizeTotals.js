/**
 * Offsetlog cache-size totals for the SummaryCards "Avg Cache" and "Total Cache"
 * cards: the sum and the per-reader average of the newest offsetlog segment's
 * byte size, which is what each consumer's position cache costs on disk.
 *
 * Nothing is deduped by source, unlike the "Messages/s" and the 24h cards. An
 * offsetlog is per-READER — each consumer keeps its own position cache — so two
 * topologies tailing `firehose.p0` own two distinct caches and both count. We
 * read each consumer's view-computed `latest.cacheSize` rather than its series,
 * because these cards show the level now and the charts plot the history.
 */

/**
 * Sum and average the newest cache size across every reader in the map.
 *
 * The average divides by the number of entries, not by the number holding a
 * cache, so a reader with no offsetlog, or one whose first checkpoint has yet to
 * land, reports 0 and pulls it down. There is no freshness filter, unlike
 * `backlogTotal`: an offsetlog segment is a file that outlives its reader, so a
 * consumer that stopped reporting still owns those bytes until the view evicts
 * its entry.
 *
 * @param {?Object<string,{latest:{cacheSize:number}}>} consumers The `topicprobe:view` consumers map; a missing map counts as empty.
 * @return {{total:number,avg:number}} Summed and averaged newest cache size in bytes; both 0 for an empty map.
 */
export function cacheSizeTotals( consumers ) {
	const list = Object.values( consumers || {} );
	let total = 0;
	for ( const c of list ) {
		total += c.latest?.cacheSize || 0;
	}
	return { total, avg: list.length ? total / list.length : 0 };
}
