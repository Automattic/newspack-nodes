/**
 * Sum the Topic_Probe view's per-sample deltas into the 24h totals behind the
 * SummaryCards "Messages · 24h" and "Bytes · 24h" cards.
 *
 * A sample is one CONSUMER's account of one window: `msgs`/`bytes` are what it
 * moved, and `elapsed` is how long that took, so the record covers
 * `[ts - elapsed, ts]`. Two topologies tailing one source each report that
 * window, from two worker processes on independent timers whose `microtime`
 * stamps never collide, so merging co-readers by exact `ts` dedups only the
 * same-process case and leaves the total a multiple of the reader count.
 *
 * Each source is therefore integrated over the UNION of its readers' windows,
 * oldest end first: a window already covered adds nothing, one that extends the
 * covered span adds the fraction of itself that sticks out. Co-readers collapse,
 * a newer-but-shorter reader still widens the span, and every instant is counted
 * from exactly one reader.
 *
 * What the number IS, then: what one reader consumed per instant, summed over
 * the retained window — production only insofar as its readers keep up.
 */

/**
 * Total the messages and bytes consumed across every source in the map.
 *
 * An entry reporting no source is skipped, because collapsing co-readers is
 * keyed on the source and an unattributable window is exactly what would
 * double-count. Deltas are clamped non-negative as the windows are built, so a
 * corrupt frame cannot subtract from a total the cards present as produced work.
 *
 * @param {?Object<string,{source?:string,series?:Array<{ts?:number,elapsed?:number,msgs?:number,bytes?:number}>}>} consumers The `topicprobe:view` consumers map, keyed by reader id; a missing map counts as empty.
 * @return {{msgs:number,bytes:number}} Messages and bytes consumed over the retained window, each rounded to an integer.
 */
export function probe24hTotals( consumers ) {
	// source → every reader's windows, to be unioned below.
	const bySource = new Map();
	for ( const c of Object.values( consumers || {} ) ) {
		const source = c.source || '';
		if ( '' === source ) {
			continue;
		}
		let windows = bySource.get( source );
		if ( ! windows ) {
			windows = [];
			bySource.set( source, windows );
		}
		for ( const s of c.series || [] ) {
			const end = Number( s.ts ) || 0;
			windows.push( {
				start: end - Math.max( 0, Number( s.elapsed ) || 0 ),
				end,
				msgs: Math.max( 0, Number( s.msgs ) || 0 ),
				bytes: Math.max( 0, Number( s.bytes ) || 0 ),
			} );
		}
	}

	let msgs = 0;
	let bytes = 0;
	for ( const windows of bySource.values() ) {
		// Oldest end first; on a tie the wider window claims the span.
		windows.sort( ( a, b ) => a.end - b.end || a.start - b.start );
		let covered = -Infinity;
		for ( const w of windows ) {
			if ( w.end <= covered ) {
				continue;
			}
			// Partial only when the window straddles `covered`, so end > start.
			const share =
				w.start >= covered
					? 1
					: ( w.end - covered ) / ( w.end - w.start );
			msgs += w.msgs * share;
			bytes += w.bytes * share;
			covered = w.end;
		}
	}
	return { msgs: Math.round( msgs ), bytes: Math.round( bytes ) };
}
