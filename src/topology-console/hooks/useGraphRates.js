import { useEffect, useRef, useState } from '@wordpress/element';

// 60 samples at ~1s = ~1 minute of trailing rate history.
const RATE_HISTORY_MAX = 60;

/**
 * Per-node msg/s + byte/s rate tracking, one tick per graph object. Negative
 * deltas (a worker respawn resets counters) clamp to zero. `resetKey` clears
 * the accumulated map when the graph identity changes (e.g. the console swaps
 * worker/topology). Returns { rateRef, rateVersion } for SchematicCanvas.
 *
 * @param {Object} graph    { nodes, edges } whose per-node counters drive the rates.
 * @param {string} resetKey Identity key; a change clears the accumulated rate map.
 * @return {Object} { rateRef, rateVersion }.
 */
export function useGraphRates( graph, resetKey ) {
	const rateRef = useRef( new Map() );
	const [ rateVersion, setRateVersion ] = useState( 0 );

	// Drop accumulated rates when the graph identity changes.
	useEffect( () => {
		rateRef.current = new Map();
		setRateVersion( ( v ) => v + 1 );
	}, [ resetKey ] );

	useEffect( () => {
		const now = Date.now() / 1000;
		let touched = false;
		for ( const n of graph.nodes ) {
			const prevEntry = rateRef.current.get( n.id );
			const count = n.count || 0;
			const bytesRead = n.bytesRead || 0;
			const bytesWritten = n.bytesWritten || 0;
			const hasMessages =
				( prevEntry && prevEntry.hasMessages ) || count > 0;
			const hasRead = ( prevEntry && prevEntry.hasRead ) || bytesRead > 0;
			const hasWritten =
				( prevEntry && prevEntry.hasWritten ) || bytesWritten > 0;
			// A node's rate baseline is only trustworthy once it reflects a REAL
			// counter reading. The first dump_metadata backfills the full
			// cumulative counter at once (a worker that has run for minutes
			// reports e.g. 12k messages / 2.3 MB in ONE response); a delta against
			// a cold 0-baseline turns that backfill into a bogus ~12k/s spike that
			// poisons the peak. So a node stays "cold" (rate 0, no history) until
			// its first reading WITH data seeds the baseline — real per-interval
			// rates accrue only from the next sample on.
			const warm = !! ( prevEntry && prevEntry.warm );
			const hasData = count > 0 || bytesRead > 0 || bytesWritten > 0;
			if ( prevEntry && warm && prevEntry.ts < now ) {
				const rawDCount = count - prevEntry.count;
				const dCount = rawDCount < 0 ? 0 : rawDCount;
				const rawDRead = bytesRead - ( prevEntry.bytesRead || 0 );
				const dRead = rawDRead < 0 ? 0 : rawDRead;
				const rawDWritten =
					bytesWritten - ( prevEntry.bytesWritten || 0 );
				const dWritten = rawDWritten < 0 ? 0 : rawDWritten;
				const dTime = Math.max( 1, now - prevEntry.ts );
				const rate = dCount / dTime;
				const readRate = dRead / dTime;
				const writtenRate = dWritten / dTime;
				const history = prevEntry.history || [];
				const readHistory = prevEntry.readHistory || [];
				const writtenHistory = prevEntry.writtenHistory || [];
				history.push( rate );
				readHistory.push( readRate );
				writtenHistory.push( writtenRate );
				if ( history.length > RATE_HISTORY_MAX ) {
					history.shift();
				}
				if ( readHistory.length > RATE_HISTORY_MAX ) {
					readHistory.shift();
				}
				if ( writtenHistory.length > RATE_HISTORY_MAX ) {
					writtenHistory.shift();
				}
				rateRef.current.set( n.id, {
					count,
					bytesRead,
					bytesWritten,
					ts: now,
					rate,
					readRate,
					writtenRate,
					lastChangedTs: dCount > 0 ? now : prevEntry.lastChangedTs,
					history,
					readHistory,
					writtenHistory,
					hasMessages,
					hasRead,
					hasWritten,
					warm: true,
				} );
				touched = true;
			} else if ( ! prevEntry || ! warm ) {
				// Cold node (a placeholder, or seen before any data ever arrived —
				// a warm node never reaches this branch). Seed the baseline without
				// emitting a rate; it warms the moment a reading carries data, so
				// the NEXT sample computes a real delta against this baseline rather
				// than treating the cumulative backfill as a rate. A cold node has
				// accrued no rate history yet, so it starts empty.
				rateRef.current.set( n.id, {
					count,
					bytesRead,
					bytesWritten,
					ts: now,
					rate: 0,
					readRate: 0,
					writtenRate: 0,
					lastChangedTs: now,
					history: [],
					readHistory: [],
					writtenHistory: [],
					hasMessages,
					hasRead,
					hasWritten,
					warm: hasData,
				} );
				touched = true;
			}
		}
		// Drop entries for nodes that vanished from the graph.
		const liveIds = new Set( graph.nodes.map( ( n ) => n.id ) );
		for ( const id of rateRef.current.keys() ) {
			if ( ! liveIds.has( id ) ) {
				rateRef.current.delete( id );
				touched = true;
			}
		}
		if ( touched ) {
			setRateVersion( ( v ) => v + 1 );
		}
	}, [ graph ] );

	return { rateRef, rateVersion };
}
