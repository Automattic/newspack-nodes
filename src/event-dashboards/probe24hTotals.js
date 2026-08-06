/**
 * Integrate the Topic_Probe view's rate series into produced 24h totals for the
 * SummaryCards "messages sent" / "bytes sent" cards: Σ (rate × dt) over each
 * source's series, summed across sources.
 *
 * The probe's `msgRate`/`byteRate` are per-PARTITION production rates (Δ MSGS /
 * Δ ts, Δ END_BYTES / Δ ts), so every reader tailing one source reports the same
 * numbers. We merge a source's readers BY TIMESTAMP (taking the max rate per ts —
 * identical across readers, so max dedupes without summing) before integrating:
 * that unions their time windows (a newer-but-shorter reader isn't dropped) while
 * never double-counting. A reset interval (rate 0) contributes nothing, so the
 * total is reset-safe; the series ring already windows it to ~24h.
 */

/**
 * @param {Object<string,{source:string,series:Array}>} consumers The `topicprobe:view` consumers map.
 * @return {{ msgs: number, bytes: number }} Produced totals over the retained window.
 */
export function probe24hTotals( consumers ) {
	// source → Map(ts → {msgRate, byteRate}), merged across its readers.
	const bySource = new Map();
	for ( const c of Object.values( consumers || {} ) ) {
		const source = c.source || '';
		if ( '' === source ) {
			continue;
		}
		let byTs = bySource.get( source );
		if ( ! byTs ) {
			byTs = new Map();
			bySource.set( source, byTs );
		}
		for ( const s of c.series || [] ) {
			const prev = byTs.get( s.ts );
			const msgRate = s.msgRate || 0;
			const byteRate = s.byteRate || 0;
			if ( ! prev ) {
				byTs.set( s.ts, { msgRate, byteRate } );
			} else {
				prev.msgRate = Math.max( prev.msgRate, msgRate );
				prev.byteRate = Math.max( prev.byteRate, byteRate );
			}
		}
	}

	let msgs = 0;
	let bytes = 0;
	for ( const byTs of bySource.values() ) {
		const tss = [ ...byTs.keys() ].sort( ( a, b ) => a - b );
		for ( let i = 1; i < tss.length; i++ ) {
			const dt = tss[ i ] - tss[ i - 1 ];
			if ( dt <= 0 ) {
				continue;
			}
			const cur = byTs.get( tss[ i ] );
			msgs += cur.msgRate * dt;
			bytes += cur.byteRate * dt;
		}
	}
	return { msgs: Math.round( msgs ), bytes: Math.round( bytes ) };
}
