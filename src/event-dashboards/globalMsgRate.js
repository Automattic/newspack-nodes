/**
 * The fleet-global message rate behind the SummaryCards "Messages/s" card: the
 * sum, over distinct probe sources, of the newest LIVE rate reported for each.
 *
 * A probe record's `SOURCE` names the single log a consumer tails — one
 * PARTITION (`firehose.p0`), or the followed filename for a `File_Tail` — and
 * `msgRate` is the messages that consumer sent divided by the window the record
 * covers, which matches the source's production rate while the reader keeps up.
 * Two topologies tailing `firehose.p0` therefore report the same stream twice,
 * so co-readers dedup by source to the largest rate; summing them would count
 * that one stream twice. Distinct partitions of a topic (`firehose.p0`,
 * `firehose.p1`) carry distinct messages, so those DO sum into the topic total.
 *
 * The map comes from the `topicprobe:view` node, which has already divided each
 * self-contained record into a `latest` sample. Reading that sample instead of
 * the series keeps the rate computed in one place.
 */

import { isLiveSample } from './liveSample';

/**
 * Sum the newest message rate across distinct probe sources.
 *
 * Only a live sample counts (`isLiveSample`), so a reader that stopped on a
 * burst cannot outrank the live co-reader of its source.
 *
 * @param {Object<string,{source?:string,latest?:{ts?:number,msgRate?:number}}>} consumers The `topicprobe:view` consumers map, keyed by reader id.
 * @param {number}                                                               headS     The stream head, from `streamHead()`, the samples are judged against.
 * @return {number} Messages per second, 0 when no entry carries a source and a live sample.
 */
export function globalMsgRate( consumers, headS ) {
	const bySource = new Map();
	for ( const c of Object.values( consumers || {} ) ) {
		const source = c.source || '';
		if ( '' === source || ! isLiveSample( c.latest, headS ) ) {
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
