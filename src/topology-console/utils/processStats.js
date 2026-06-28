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
export function processStats( nodes ) {
	const stats = {
		messagesIn: 0,
		messagesOut: 0,
		bytesRead: 0,
		bytesWritten: 0,
	};
	for ( const n of nodes || [] ) {
		const count = n.count ?? 0;
		const hasTarget = n.has_target ?? true;
		const acceptsFill = n.accepts_fill ?? true;
		if ( hasTarget && ! acceptsFill ) {
			stats.messagesIn += count;
		}
		if ( ! hasTarget && acceptsFill ) {
			stats.messagesOut += count;
		}
		stats.bytesRead += n.bytesRead ?? 0;
		stats.bytesWritten += n.bytesWritten ?? 0;
	}
	return stats;
}
