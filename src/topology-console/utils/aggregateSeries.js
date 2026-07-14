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
 */

import { isSource, isSink } from './processStats';

/**
 * Sum each node's samples into `out`, aligned at the END. Histories differ in
 * length — a node only starts recording once its first data arrives — so the
 * LAST sample of every node is the same poll, and the k-th from the end is too.
 *
 * @param {number[]} out     Accumulator, longest-history length.
 * @param {number[]} history One node's samples.
 */
function addFromEnd( out, history ) {
	for ( let k = 0; k < history.length; k++ ) {
		out[ out.length - 1 - k ] += history[ history.length - 1 - k ];
	}
}

// The scope's series is as long as its longest-lived member's history.
function longest( rates, nodes, key ) {
	let max = 0;
	for ( const n of nodes ) {
		const len = rates.get( n.id )?.[ key ]?.length ?? 0;
		max = len > max ? len : max;
	}
	return max;
}

/**
 * @param {Map}   rates useGraphRates' per-node map (`rateRef.current`).
 * @param {Array} nodes The nodes in scope.
 * @return {{in: number[], out: number[], read: number[], write: number[]}} Series.
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
