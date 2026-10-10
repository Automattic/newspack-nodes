/**
 * Sum the Topic_Probe view's per-bucket deltas into the 24h totals behind the
 * SummaryCards "Messages · 24h" and "Bytes · 24h" cards.
 *
 * A bucket holds one CONSUMER's account of the windows one worker swept in
 * it: `msgs`/`bytes` tally what it moved. The total is every reader's deltas
 * over the retained buckets, the same per-partition per-worker values the
 * Overview's stacked charts plot, so two topologies tailing one partition
 * each count what they read.
 */

import { bucketTotals } from './nodes/probe-stream-view-node';

/**
 * Total the messages and bytes every reader in the map consumed.
 *
 * A reader naming no source is skipped, as the charts skip it.
 *
 * @param {?Object<string,{source?:string,buckets?:Array<import('./nodes/probe-stream-view-node').Bucket>}>} consumers The `topicprobe:view` consumers map, keyed by reader id; a missing map counts as empty.
 * @return {{msgs:number,bytes:number}} Messages and bytes consumed over the retained window, each rounded to an integer.
 */
export function probe24hTotals( consumers ) {
	let msgs = 0;
	let bytes = 0;
	for ( const c of Object.values( consumers || {} ) ) {
		if ( ! c.source ) {
			continue;
		}
		const t = bucketTotals( c.buckets || [], [ 'msgs', 'bytes' ] );
		msgs += t.msgs.sum;
		bytes += t.bytes.sum;
	}
	return { msgs: Math.round( msgs ), bytes: Math.round( bytes ) };
}
