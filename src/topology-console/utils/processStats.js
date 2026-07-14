/**
 * Roll a graph's nodes up into process-level totals for the inspector header
 * (roadmap [95]):
 *  - messagesIn  — sum of SOURCE counters (has_target, !accepts_fill): produced
 *  - messagesOut — sum of SINK counters (!has_target, accepts_fill): consumed
 *  - bytesRead / bytesWritten — summed across every node
 *
 * Port flags default true (matching parseMetadata), so a node that declares
 * neither counts toward neither in/out total.
 *
 * @param {Array<{count?:number, bytesRead?:number, bytesWritten?:number, has_target?:boolean, accepts_fill?:boolean}>} nodes
 * @return {{messagesIn:number, messagesOut:number, bytesRead:number, bytesWritten:number}} Totals.
 */
/**
 * A scope's ingress: produces without accepting. Shared with aggregateSeries so
 * the totals and the sparklines can't disagree about what a source is.
 *
 * @param {Object} n Node metadata.
 * @return {boolean} Whether the node produces into the scope.
 */
export function isSource( n ) {
	return ( n.has_target ?? true ) && ! ( n.accepts_fill ?? true );
}

/**
 * A scope's egress: accepts without producing.
 *
 * @param {Object} n Node metadata.
 * @return {boolean} Whether the node consumes out of the scope.
 */
export function isSink( n ) {
	return ! ( n.has_target ?? true ) && ( n.accepts_fill ?? true );
}

export function processStats( nodes ) {
	const stats = {
		messagesIn: 0,
		messagesOut: 0,
		bytesRead: 0,
		bytesWritten: 0,
	};
	for ( const n of nodes || [] ) {
		const count = n.count ?? 0;
		if ( isSource( n ) ) {
			stats.messagesIn += count;
		}
		if ( isSink( n ) ) {
			stats.messagesOut += count;
		}
		stats.bytesRead += n.bytesRead ?? 0;
		stats.bytesWritten += n.bytesWritten ?? 0;
	}
	return stats;
}
