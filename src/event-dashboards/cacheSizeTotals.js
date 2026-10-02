/**
 * Offsetlog cache-size totals for the SummaryCards "Avg Cache" and "Total Cache"
 * cards: the sum and the per-reader average of the newest offsetlog segment's
 * byte size, which is what each live consumer's position cache costs on disk.
 *
 * Nothing is deduped by source, unlike the "Messages/s" and the 24h cards. An
 * offsetlog is per-READER — each consumer keeps its own position cache — so two
 * topologies tailing `firehose.p0` own two distinct caches and both count. We
 * read each consumer's view-computed `latest.cacheSize` rather than its series,
 * because these cards show the level now and the charts plot the history.
 */

import { isLiveSample } from './liveSample';

/**
 * Sum and average the newest cache size across every live reader in the map.
 *
 * Only a live sample counts (`isLiveSample`), in the total and in the count the
 * average divides by. Among those, a reader with no offsetlog, or one whose
 * first checkpoint has yet to land, reports 0 and pulls the average down.
 *
 * @param {?Object<string,{latest?:{ts?:number,cacheSize?:number}}>} consumers The `topicprobe:view` consumers map; a missing map counts as empty.
 * @param {number}                                                   headS     The stream head, from `streamHead()`, the samples are judged against.
 * @return {{total:number,avg:number}} Summed and averaged newest cache size in bytes; both 0 when no reader is live.
 */
export function cacheSizeTotals( consumers, headS ) {
	const live = Object.values( consumers || {} ).filter( ( c ) =>
		isLiveSample( c.latest, headS )
	);
	let total = 0;
	for ( const c of live ) {
		total += c.latest.cacheSize || 0;
	}
	return { total, avg: live.length ? total / live.length : 0 };
}
