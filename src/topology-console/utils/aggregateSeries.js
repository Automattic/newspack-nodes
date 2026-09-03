/**
 * aggregateSeries — roll a set of nodes' RECORDED rate histories up into one
 * scope's sparkline series.
 *
 * useGraphRates has been recording every node since page load, so a scope
 * selected now can show the minute that already happened instead of
 * accumulating a fresh series from zero. The in/out split reuses processStats'
 * source/sink predicates, so a message hopping between two members of the scope
 * isn't counted at either end, and the totals can't disagree with the graph.
 *
 * The series is DERIVED from live per-node state, not a record: when a node
 * leaves the graph useGraphRates drops its history, so the scope's past samples
 * shrink to match. A hull that loses a node reads as though it always ran
 * without it. That's the price of showing history that predates the selection.
 *
 * @typedef {import('../hooks/useGraphRates').RateEntry} RateEntry
 */

import { isSource, isSink } from './processStats';

/**
 * Sum each node's samples into `out`, aligned at the END. Histories differ in
 * length — a node only starts recording once its first data arrives — so the
 * LAST sample of every node is the same poll, and the k-th from the end is too.
 *
 * `out` has to be at least as long as `history`, which is why callers size it
 * through `longest()` over the same node set: a longer history writes at a
 * negative index, which lands off the array and loses the sample.
 *
 * @param {number[]} out     Accumulator, longest-history length.
 * @param {number[]} history One node's samples.
 */
function addFromEnd( out, history ) {
	for ( let k = 0; k < history.length; k++ ) {
		out[ out.length - 1 - k ] += history[ history.length - 1 - k ];
	}
}

/**
 * Measure the longest history `nodes` have recorded for one series, which is
 * how long the scope's series is: the member that warmed first sets the
 * window, and every shorter history right-aligns inside it.
 *
 * @param {Map<string,RateEntry>}                    rates useGraphRates' per-node map.
 * @param {Array<{id:string}>}                       nodes The nodes to measure.
 * @param {'history'|'readHistory'|'writtenHistory'} key   Which of an entry's sample rings to measure.
 * @return {number} Sample count, zero when no member has recorded anything.
 */
function longest( rates, nodes, key ) {
	let max = 0;
	for ( const n of nodes ) {
		const len = rates.get( n.id )?.[ key ]?.length ?? 0;
		max = len > max ? len : max;
	}
	return max;
}

/**
 * Roll one scope's per-node histories into the four series its sparklines
 * plot: `in` over the scope's sources, `out` over its sinks, `read` and
 * `write` over every member. A node the map holds no entry for is dropped from
 * the scope, so a selection made before the first poll lands returns four empty
 * series rather than a row of zeroes.
 *
 * @param {?Map<string,RateEntry>}                                        rates useGraphRates' per-node map (`rateRef.current`).
 * @param {?Array<{id:string,has_target?:boolean,accepts_fill?:boolean}>} nodes The nodes in scope.
 * @return {{in:number[], out:number[], read:number[], write:number[]}} One sample ring per series, oldest first.
 */
export function aggregateSeries( rates, nodes ) {
	const scope = ( nodes || [] ).filter( ( n ) => rates?.get( n.id ) );
	const zeroes = ( n ) => new Array( n ).fill( 0 );
	const sources = scope.filter( isSource );
	const sinks = scope.filter( isSink );
	const series = {
		in: zeroes( longest( rates, sources, 'history' ) ),
		out: zeroes( longest( rates, sinks, 'history' ) ),
		read: zeroes( longest( rates, scope, 'readHistory' ) ),
		write: zeroes( longest( rates, scope, 'writtenHistory' ) ),
	};
	for ( const n of scope ) {
		const entry = rates.get( n.id );
		if ( isSource( n ) ) {
			addFromEnd( series.in, entry.history || [] );
		}
		if ( isSink( n ) ) {
			addFromEnd( series.out, entry.history || [] );
		}
		addFromEnd( series.read, entry.readHistory || [] );
		addFromEnd( series.write, entry.writtenHistory || [] );
	}
	return series;
}
