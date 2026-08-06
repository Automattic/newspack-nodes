/**
 * Sum the Topic_Probe view's per-sample deltas into produced 24h totals for the
 * SummaryCards "messages sent" / "bytes sent" cards.
 *
 * Each sample already carries the work its own window did (`msgs`, `bytes`), so
 * this is a plain sum — no rate × dt reconstruction, and the first sample counts
 * like any other. Those deltas are per-PARTITION production, so every reader
 * tailing one source reports the same numbers: we merge a source's readers BY
 * TIMESTAMP (taking the max per ts — identical across readers, so max dedupes
 * without summing) before adding it up. That unions their time windows (a
 * newer-but-shorter reader isn't dropped) while never double-counting. The
 * series ring already windows it to ~24h.
 */

/**
 * @param {Object<string,{source:string,series:Array}>} consumers The `topicprobe:view` consumers map.
 * @return {{ msgs: number, bytes: number }} Produced totals over the retained window.
 */
export function probe24hTotals( consumers ) {
	// source → Map(ts → {msgs, bytes}), merged across its readers.
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
			const prev = byTs.get( s.ts ) || { msgs: 0, bytes: 0 };
			byTs.set( s.ts, {
				msgs: Math.max( prev.msgs, s.msgs || 0 ),
				bytes: Math.max( prev.bytes, s.bytes || 0 ),
			} );
		}
	}

	let msgs = 0;
	let bytes = 0;
	for ( const byTs of bySource.values() ) {
		for ( const sample of byTs.values() ) {
			msgs += sample.msgs;
			bytes += sample.bytes;
		}
	}
	return { msgs: Math.round( msgs ), bytes: Math.round( bytes ) };
}
