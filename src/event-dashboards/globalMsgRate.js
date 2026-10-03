/**
 * The fleet-global message rate behind the SummaryCards "Messages/s" card: the
 * sum of every LIVE reader's newest rate, the same values the Overview's
 * stacked message-rate chart plots per partition per worker.
 *
 * Each reader counts, co-readers of one partition included: two topologies
 * tailing `firehose.p0` each move that stream, and each is a series in the
 * chart, so the card is the sum the chart's column reads.
 *
 * The map comes from the `topicprobe:view` node, which has already divided each
 * self-contained record into a `latest` sample. Reading that sample instead of
 * the series keeps the rate computed in one place.
 */

import { isLiveReader } from './liveSample';

/**
 * Sum the newest message rate of every live reader.
 *
 * Only a live reader counts (`isLiveReader`), so a reader that stopped on a
 * burst adds nothing, and one naming no source is skipped, as the charts
 * skip it.
 *
 * @param {Object<string,{source?:string,latest?:{ts?:number,msgRate?:number}}>} consumers The `topicprobe:view` consumers map, keyed by reader id.
 * @param {number}                                                               headS     The stream head, from `streamHead()`, the samples are judged against.
 * @return {number} Messages per second, 0 when no entry carries a source and a live sample.
 */
export function globalMsgRate( consumers, headS ) {
	let total = 0;
	for ( const c of Object.values( consumers || {} ) ) {
		if ( isLiveReader( c, headS ) ) {
			total += c.latest?.msgRate || 0;
		}
	}
	return total;
}
