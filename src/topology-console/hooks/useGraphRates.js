/**
 * Per-node message and byte rates for the topology console's sparklines.
 *
 * `dump_metadata` reports CUMULATIVE counters, on a cadence that scales with
 * graph size (`computePollIntervalMs`, floored at 5 seconds), so a rate exists
 * nowhere in a snapshot. This file keeps every node's previous reading and
 * divides each delta by the wall-clock time that actually elapsed, so a slower
 * poll on a large graph does not read as a busier node. The canvas cards, the
 * Inspector's Activity section and `aggregateSeries` all plot what it
 * accumulates.
 *
 * @typedef  {Object}   RateEntry
 * @property {number}   count          Cumulative message counter at the last reading — the baseline the next delta subtracts.
 * @property {number}   bytesRead      Cumulative bytes read at the last reading.
 * @property {number}   bytesWritten   Cumulative bytes written at the last reading.
 * @property {number}   ts             Wall-clock seconds of that reading.
 * @property {number}   rate           Messages per second over the last interval.
 * @property {number}   readRate       Bytes read per second over the last interval.
 * @property {number}   writtenRate    Bytes written per second over the last interval.
 * @property {number}   lastChangedTs  Seconds of the last reading whose message counter MOVED, or of the seed reading while the node is still cold. The Inspector shows it as `last_seen`.
 * @property {number[]} history        Trailing `rate` samples, oldest first, capped at `RATE_HISTORY_MAX`.
 * @property {number[]} readHistory    Trailing `readRate` samples.
 * @property {number[]} writtenHistory Trailing `writtenRate` samples.
 * @property {boolean}  hasMessages    The node has reported messages. Sticky, so a respawn zeroing the counters does not pull the row out of the Inspector.
 * @property {boolean}  hasRead        The node has reported bytes read. Sticky.
 * @property {boolean}  hasWritten     The node has reported bytes written. Sticky.
 * @property {boolean}  warm           A baseline reading carrying data exists, so the next reading yields a real delta.
 */

import { useEffect, useRef, useState } from '@wordpress/element';

/**
 * Samples of trailing rate history kept per series, per node.
 *
 * The window this covers is this count times the metadata poll interval, which
 * is why `formatActivityWindow` computes the Activity label from both rather
 * than printing a fixed one. Exported because the card sparkline right-aligns
 * its points against this same capacity: a second copy would shift every
 * plotted point the moment one of them moved.
 *
 * @type {number}
 */
export const RATE_HISTORY_MAX = 60;

/**
 * Track every graph node's message and byte rates across snapshots.
 *
 * A node's first reading carrying data is a BASELINE, never a sample. The
 * canvas paints a node before `dump_metadata` backfills its cumulative
 * counters, and reading that backfill as one interval's traffic plots the
 * node's whole lifetime as a single spike — which then sets the scale every
 * real sample is drawn against. A negative delta clamps to zero for the same
 * reason, a worker respawn restarting the counters at zero. The interval
 * floors at one second, so a snapshot arriving milliseconds after the last one
 * reads low rather than dividing a delta by nearly nothing.
 *
 * `resetKey` clears the map when the console swaps worker or topology. A node
 * id is a node NAME, and the partitions of one topology mount the same names,
 * so a delta carried across the swap would subtract one worker's counters from
 * another's.
 *
 * `rateRef` is stable and its history arrays are mutated in place, so React
 * sees nothing change: `rateVersion` is what re-renders the consumers and what
 * a derivation off `rateRef.current` lists as its dependency.
 *
 * @param {{nodes:Array<{id:string,count?:number,bytesRead?:number,bytesWritten?:number}>}} graph    Graph whose per-node counters drive the rates.
 * @param {string}                                                                          resetKey Identity key; a change clears the accumulated map.
 * @return {{rateRef:{current:Map<string,RateEntry>},rateVersion:number}} The rate map behind a stable ref, and the counter that ticks whenever it changes.
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
			// A node warms on the first reading that carries data.
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
				// Seed a baseline: a rate needs a second reading.
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
