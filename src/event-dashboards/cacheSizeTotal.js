/**
 * Offsetlog cache size for the SummaryCards "Total Cache" card: the sum of
 * each live reader's newest offsetlog segment, which is what its position
 * cache costs on disk.
 *
 * Nothing is deduped by source, as in every reader card. An offsetlog is
 * per-READER — each consumer keeps its own position cache — so two topologies
 * tailing `firehose.p0` own two distinct caches and both count, as both stack
 * in the Overview's cache-size chart. We read each consumer's view-computed
 * `latest.cacheSize` rather than its series, because the card shows the level
 * now and the chart plots the history.
 */

import { isLiveReader } from './liveSample';

/**
 * Sum the newest cache size across every live reader in the map.
 *
 * Only a live reader counts (`isLiveReader`); one naming no source is skipped,
 * as the charts skip it.
 *
 * @param {?Object<string,{source?:string,latest?:{ts?:number,cacheSize?:number}}>} consumers The `topicprobe:view` consumers map; a missing map counts as empty.
 * @param {number}                                                                  headS     The stream head, from `streamHead()`, the samples are judged against.
 * @return {number} Summed newest cache size in bytes; 0 when no reader is live.
 */
export function cacheSizeTotal( consumers, headS ) {
	let total = 0;
	for ( const c of Object.values( consumers || {} ) ) {
		if ( isLiveReader( c, headS ) ) {
			total += c.latest.cacheSize || 0;
		}
	}
	return total;
}
