/**
 * Sum the Topic_Probe view's per-sample deltas into the 24h totals behind the
 * SummaryCards "Messages · 24h" and "Bytes · 24h" cards.
 *
 * A sample is one CONSUMER's account of one window: `msgs`/`bytes` are what it
 * moved. The total is every reader's deltas over the retained window, the
 * same per-partition per-worker values the Overview's stacked charts plot, so
 * two topologies tailing one partition each count what they read.
 */

/**
 * Total the messages and bytes every reader in the map consumed.
 *
 * A reader naming no source is skipped, as the charts skip it. Deltas are
 * clamped non-negative, so a corrupt frame cannot subtract from a total.
 *
 * @param {?Object<string,{source?:string,series?:Array<{msgs?:number,bytes?:number}>}>} consumers The `topicprobe:view` consumers map, keyed by reader id; a missing map counts as empty.
 * @return {{msgs:number,bytes:number}} Messages and bytes consumed over the retained window, each rounded to an integer.
 */
export function probe24hTotals( consumers ) {
	let msgs = 0;
	let bytes = 0;
	for ( const c of Object.values( consumers || {} ) ) {
		if ( ! c.source ) {
			continue;
		}
		for ( const s of c.series || [] ) {
			msgs += Math.max( 0, Number( s.msgs ) || 0 );
			bytes += Math.max( 0, Number( s.bytes ) || 0 );
		}
	}
	return { msgs: Math.round( msgs ), bytes: Math.round( bytes ) };
}
