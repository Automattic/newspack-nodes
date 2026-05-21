/**
 * Compute x/y positions for a parsed {nodes, edges} graph.
 *
 * Left-to-right column layout (column = deepest predecessor + 1) with a
 * three-pass row assignment: barycenter, target-snap, deconflict.
 * Returns new node objects with `position: {x, y}`; does not mutate.
 */

// Exported so drag-snap lands on the same grid (single source of truth).
export const X_STEP = 240;
export const Y_STEP = 110;
export const X_PAD = 60;
export const Y_PAD = 80;
export const NODE_W = 196;
export const NODE_H = 84;

export function autoLayout( parsed ) {
	const nodes = parsed?.nodes ?? [];
	const edges = parsed?.edges ?? [];

	const incoming = new Map();
	const outgoing = new Map();
	for ( const e of edges ) {
		const inList = incoming.get( e.to ) || [];
		inList.push( e.from );
		incoming.set( e.to, inList );
		const outList = outgoing.get( e.from ) || [];
		outList.push( e.to );
		outgoing.set( e.from, outList );
	}

	// Depth assignment via DFS with cycle break.
	const depth = new Map();
	const visit = ( name, stack = new Set() ) => {
		if ( depth.has( name ) ) {
			return depth.get( name );
		}
		if ( stack.has( name ) ) {
			depth.set( name, 0 );
			return 0;
		}
		stack.add( name );
		const preds = incoming.get( name ) || [];
		const d =
			preds.length === 0
				? 0
				: 1 + Math.max( 0, ...preds.map( ( p ) => visit( p, stack ) ) );
		stack.delete( name );
		depth.set( name, d );
		return d;
	};
	nodes.forEach( ( n ) => visit( n.id ) );

	// Push each node right to `min(target depths) - 1` to shorten long
	// forward edges. Walk in decreasing-depth order so targets settle first.
	const sortedByDepthDesc = [ ...nodes ].sort(
		( a, b ) => depth.get( b.id ) - depth.get( a.id )
	);
	for ( const n of sortedByDepthDesc ) {
		const targets = outgoing.get( n.id ) || [];
		if ( targets.length === 0 ) {
			continue;
		}
		const targetDepths = targets
			.map( ( t ) => depth.get( t ) )
			.filter( ( d ) => d !== undefined );
		if ( targetDepths.length === 0 ) {
			continue;
		}
		const minTargetDepth = Math.min( ...targetDepths );
		if ( minTargetDepth - 1 > depth.get( n.id ) ) {
			depth.set( n.id, minTargetDepth - 1 );
		}
	}

	// Bucket nodes by depth.
	const byDepth = new Map();
	for ( const n of nodes ) {
		const d = depth.get( n.id ) ?? 0;
		if ( ! byDepth.has( d ) ) {
			byDepth.set( d, [] );
		}
		byDepth.get( d ).push( n );
	}
	const depthsAscending = Array.from( byDepth.keys() ).sort(
		( a, b ) => a - b
	);

	// Pass 1: barycenter row assignment (left-to-right).
	const row = new Map();
	for ( const d of depthsAscending ) {
		const columnNodes = byDepth.get( d );
		if ( d === 0 ) {
			columnNodes.forEach( ( n, i ) => row.set( n.id, i ) );
			continue;
		}
		const scored = columnNodes.map( ( n ) => {
			const preds = incoming.get( n.id ) || [];
			const predRows = preds
				.map( ( p ) => row.get( p ) )
				.filter( ( r ) => r !== undefined );
			const bary = predRows.length
				? predRows.reduce( ( a, b ) => a + b, 0 ) / predRows.length
				: Number.POSITIVE_INFINITY;
			return { node: n, bary };
		} );
		scored.sort( ( a, b ) => {
			if ( a.bary !== b.bary ) {
				return a.bary - b.bary;
			}
			return a.node.id.localeCompare( b.node.id );
		} );
		scored.forEach( ( s, i ) => row.set( s.node.id, i ) );
	}

	// Pass 2: snap each producer's row to the mean of its target rows,
	// right-to-left. Mean (not min) sits a producer between split targets.
	for ( let i = depthsAscending.length - 1; i >= 0; i-- ) {
		const d = depthsAscending[ i ];
		for ( const n of byDepth.get( d ) ) {
			const targets = outgoing.get( n.id ) || [];
			const targetRows = targets
				.map( ( t ) => row.get( t ) )
				.filter( ( r ) => r !== undefined );
			if ( targetRows.length ) {
				const mean =
					targetRows.reduce( ( a, b ) => a + b, 0 ) /
					targetRows.length;
				row.set( n.id, Math.round( mean ) );
			}
		}
	}

	// Pass 3: deconflict same-row column-mates. Tiebreaker = "straightness"
	// (more edges whose other endpoint shares the row keeps it), then alpha.
	const straightnessAt = ( nodeId, targetRow ) => {
		let count = 0;
		for ( const p of incoming.get( nodeId ) || [] ) {
			if ( row.get( p ) === targetRow ) {
				count++;
			}
		}
		for ( const t of outgoing.get( nodeId ) || [] ) {
			if ( row.get( t ) === targetRow ) {
				count++;
			}
		}
		return count;
	};
	for ( const d of depthsAscending ) {
		const columnNodes = byDepth.get( d ).slice();
		columnNodes.sort( ( a, b ) => {
			const ra = row.get( a.id );
			const rb = row.get( b.id );
			if ( ra !== rb ) {
				return ra - rb;
			}
			const sa = straightnessAt( a.id, ra );
			const sb = straightnessAt( b.id, rb );
			if ( sa !== sb ) {
				return sb - sa; // higher straightness wins the row
			}
			return a.id.localeCompare( b.id );
		} );
		const seen = new Set();
		for ( const n of columnNodes ) {
			let r = row.get( n.id );
			while ( seen.has( r ) ) {
				r++;
			}
			row.set( n.id, r );
			seen.add( r );
		}
	}

	const positioned = nodes.map( ( n ) => {
		const d = depth.get( n.id ) ?? 0;
		const r = row.get( n.id ) ?? 0;
		return {
			...n,
			position: { x: X_PAD + d * X_STEP, y: Y_PAD + r * Y_STEP },
		};
	} );

	return { nodes: positioned, edges };
}
