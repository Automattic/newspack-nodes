/**
 * The source/sink predicates and the process-level roll-up behind the console's
 * two stats headers: the Inspector's process view and HullPanel's hull stats.
 *
 * `aggregateSeries` imports the same two predicates, so a scope's totals and
 * the sparklines beside them classify every node identically and cannot
 * disagree about which members are its edges.
 *
 * Both predicates read a missing port flag as true, matching what
 * `parseMetadata` writes for a node whose `node_schema()` declares neither.
 * A node holding both ports is a through-node and counts toward neither total,
 * so a message moving between two members of a scope reads as interior traffic
 * rather than as an arrival plus a departure.
 */

/**
 * Whether the node is one of the scope's ingresses, producing into it without
 * accepting from it.
 *
 * @param {{has_target?:boolean, accepts_fill?:boolean}} n Node metadata.
 * @return {boolean} Whether the node produces into the scope.
 */
export function isSource( n ) {
	return ( n.has_target ?? true ) && ! ( n.accepts_fill ?? true );
}

/**
 * Whether the node is one of the scope's egresses, accepting into it without
 * producing out of it.
 *
 * @param {{has_target?:boolean, accepts_fill?:boolean}} n Node metadata.
 * @return {boolean} Whether the node consumes out of the scope.
 */
export function isSink( n ) {
	return ! ( n.has_target ?? true ) && ( n.accepts_fill ?? true );
}

/**
 * Rolls a scope's nodes up into the four totals a stats header displays.
 *
 * `messagesIn` sums the counters of the scope's sources and `messagesOut`
 * those of its sinks, which is what makes the pair describe the boundary's own
 * traffic: a hop between two members lands in neither sum. The byte counters
 * carry no such boundary — every node reports the bytes crossing its own I/O
 * seam — so they sum across every member.
 *
 * A scope built entirely of through-nodes therefore reports zero messages in
 * and out while its byte totals still climb. That traffic belongs to whichever
 * enclosing scope holds its source and its sink.
 *
 * @param {Array<{count?:number, bytesRead?:number, bytesWritten?:number, has_target?:boolean, accepts_fill?:boolean}>} [nodes] Node metadata for the scope; a missing list totals zero.
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
