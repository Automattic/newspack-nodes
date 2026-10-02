/**
 * Current fleet backlog for the SummaryCards "Backlog" card: the sum of every
 * LIVE reader's newest backlog, the bytes it sits behind the head of its source.
 *
 * Nothing is deduped by source, as in the cache cards. A backlog is per-READER
 * — each consumer owns its position — so two topologies tailing `firehose.p0`
 * are two distinct debts and both count.
 */

import { isLiveSample } from './liveSample';

/**
 * Sum the newest backlog of every reader still reporting.
 *
 * Only a live sample counts (`isLiveSample`): the `topicprobe:view` model keeps
 * a reader that died while behind for the 24h charts, and its final backlog is
 * a debt no live reader is working off.
 *
 * @param {?Object<string,{latest?:{ts?:number,backlog?:number}}>} consumers The `topicprobe:view` consumers map; a missing map counts as empty.
 * @param {number}                                                 headS     The stream head, from `streamHead()`, the samples are judged against.
 * @return {number} Summed newest backlog in bytes; 0 when no reader is live.
 */
export function backlogTotal( consumers, headS ) {
	let total = 0;
	for ( const c of Object.values( consumers || {} ) ) {
		if ( isLiveSample( c.latest, headS ) ) {
			total += c.latest.backlog || 0;
		}
	}
	return total;
}
