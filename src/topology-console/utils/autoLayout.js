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

// Snap a drop point (SVG-space, presumed near a node center) to the nearest
// grid intersection and return the corresponding top-left position the
// renderer stores. Shared by the topology console (live + edit drop) and the
// debug overlay so a fresh drop lands on the same grid the existing nodes
// already snap to.
export function snapToGrid( x, y ) {
	const sx = X_STEP / 2;
	const sy = Y_STEP / 2;
	const ox = X_PAD + NODE_W / 2;
	const oy = Y_PAD + NODE_H / 2;
	const centerX = Math.round( ( x - ox ) / sx ) * sx + ox;
	const centerY = Math.round( ( y - oy ) / sy ) * sy + oy;
	return {
		x: centerX - NODE_W / 2,
		y: centerY - NODE_H / 2,
	};
}

export function autoLayout( parsed ) {
	const nodes = parsed?.nodes ?? [];
	const edges = parsed?.edges ?? [];

	// No edges → alpha-sorted column-major grid. The depth-driven layout
	// would stack every node in column 0 (all depth=0 without predecessors),
	// which makes a request-scope service-CI graph (independent CIs with no
	// targets) read as one long column.
	if ( edges.length === 0 && nodes.length > 0 ) {
		const sorted = [ ...nodes ].sort( ( a, b ) =>
			a.id.localeCompare( b.id )
		);
		const rowCount = Math.max( 1, Math.ceil( Math.sqrt( sorted.length ) ) );
		const positioned = sorted.map( ( n, i ) => ( {
			...n,
			position: {
				x: X_PAD + Math.floor( i / rowCount ) * X_STEP,
				y: Y_PAD + ( i % rowCount ) * Y_STEP,
			},
		} ) );
		return { nodes: positioned, edges };
	}

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
	// forward edges — BUT skip source-only nodes (no incoming). Sources
	// anchor the left edge; pulling them right just to be closer to a
	// faraway target marrons col 0 visually empty. Walk in decreasing-
	// depth order so targets settle first.
	const sortedByDepthDesc = [ ...nodes ].sort(
		( a, b ) => depth.get( b.id ) - depth.get( a.id )
	);
	for ( const n of sortedByDepthDesc ) {
		const preds = incoming.get( n.id ) || [];
		if ( preds.length === 0 ) {
			continue; // source-only: stays at col 0
		}
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

	// Align sinks (no outgoing) and isolated nodes (no edges) to the max-depth
	// column. Without this, a fan-out that reaches sinks at uneven natural
	// depths leaves them scattered across columns — e.g. a request-builder
	// → completed:tee → partition chain puts some partitions at depth 3 and
	// some at depth 4. Pushing every leaf right makes them stack cleanly in
	// the rightmost column, and an isolated node (`_repl` in the live worker
	// graph) joins them instead of marooning the left edge.
	let maxDepth = 0;
	for ( const d of depth.values() ) {
		if ( d > maxDepth ) {
			maxDepth = d;
		}
	}
	if ( maxDepth > 0 ) {
		for ( const n of nodes ) {
			const outs = outgoing.get( n.id ) || [];
			if ( outs.length === 0 ) {
				depth.set( n.id, maxDepth );
			}
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
	// Snap precision: HALF-row for multi-target fan-outs (so 4 targets at
	// rows 0,1,2,3 put the source at 1.5 — the visual midpoint between
	// rows 1 and 2). Single-target snap takes the exact target row so
	// straight pairs stay on the same row.
	for ( let i = depthsAscending.length - 1; i >= 0; i-- ) {
		const d = depthsAscending[ i ];
		for ( const n of byDepth.get( d ) ) {
			const targets = outgoing.get( n.id ) || [];
			const targetRows = targets
				.map( ( t ) => row.get( t ) )
				.filter( ( r ) => r !== undefined );
			if ( targetRows.length === 1 ) {
				row.set( n.id, targetRows[ 0 ] );
			} else if ( targetRows.length > 1 ) {
				const mean =
					targetRows.reduce( ( a, b ) => a + b, 0 ) /
					targetRows.length;
				row.set( n.id, Math.round( mean * 2 ) / 2 );
			}
		}
	}

	// Pass 3: per-column resnap + deconflict, left-to-right.
	//
	// For columns beyond 0, re-snap each node to FLOOR(mean of finalized
	// predecessor rows) before deconfliction. Pass 1 placed columns by
	// barycenter using col 0's input-order rows, but Pass 2 + same-column
	// deconflict have since moved col 0 around — without this resnap,
	// targets stay at their stale Pass-1 rows and the dashed edges run
	// diagonally instead of horizontally. Floor (vs round) biases a target
	// toward its FIRST predecessor, which is the natural pair partner.
	//
	// Deconflict tiebreak = "straightness" (more edges whose other endpoint
	// shares the row keeps it), then alpha.
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
		if ( d > 0 ) {
			for ( const n of columnNodes ) {
				// Re-snap LEAVES only — middle nodes keep Pass 2's
				// target-snap row (= midpoint of fan-out). Re-snapping a
				// middle node to its predecessor's row would pull it AWAY
				// from the midpoint of its targets.
				const outs = outgoing.get( n.id ) || [];
				if ( outs.length > 0 ) {
					continue;
				}
				const preds = incoming.get( n.id ) || [];
				// Fan-out leaves (single pred, sibling count > 1) keep the
				// Pass 1 barycenter row — pulling all siblings to the pred's
				// row collapses them, then deconflict bumps them DOWNWARD,
				// shifting the midpoint off the pred. Pass 1's alpha-spread
				// already centers them around the pred.
				if ( preds.length === 1 ) {
					const siblings = outgoing.get( preds[ 0 ] ) || [];
					if ( siblings.length > 1 ) {
						continue;
					}
				}
				const predRows = preds
					.map( ( p ) => row.get( p ) )
					.filter( ( r ) => r !== undefined );
				if ( predRows.length ) {
					const mean =
						predRows.reduce( ( a, b ) => a + b, 0 ) /
						predRows.length;
					row.set( n.id, Math.floor( mean ) );
				}
			}
		}
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

	// Pass 3b: right-to-left re-snap of MIDDLE nodes (nodes with outgoing
	// edges) to mean of FINAL target rows. After Pass 3's per-column
	// deconflict, leaves may have shifted (e.g. gyroscope moved from row 2
	// → row 1 because it now wins the row-1 slot via straightness over an
	// errors-partition sibling). Pass 2 set middle nodes using the
	// pre-deconflict rows, so completed:tee at row 1 (mean of completed:
	// partition row 0 and gyroscope row 2) is stale once gyroscope sits at
	// row 1. Re-snapping middle nodes here with finalized target rows puts
	// each middle node at the actual midpoint of its targets.
	//
	// Single target → exact target row (preserves straight pairs).
	// Multi target → round-to-half-row for visual midpoint precision.
	for ( let i = depthsAscending.length - 1; i >= 0; i-- ) {
		const d = depthsAscending[ i ];
		const columnNodes = byDepth.get( d ).slice();
		for ( const n of columnNodes ) {
			const outs = outgoing.get( n.id ) || [];
			if ( outs.length === 0 ) {
				continue; // leaves stay put
			}
			const targetRows = outs
				.map( ( t ) => row.get( t ) )
				.filter( ( r ) => r !== undefined );
			if ( targetRows.length === 1 ) {
				row.set( n.id, targetRows[ 0 ] );
			} else if ( targetRows.length > 1 ) {
				const mean =
					targetRows.reduce( ( a, b ) => a + b, 0 ) /
					targetRows.length;
				row.set( n.id, Math.round( mean * 2 ) / 2 );
			}
		}
		// Deconflict middle nodes against each other in this column. Bumps
		// are integer-row, which can push a half-row node onto an integer
		// row — accepted, since the alternative is overlap.
		columnNodes.sort( ( a, b ) => {
			const ra = row.get( a.id );
			const rb = row.get( b.id );
			if ( ra !== rb ) {
				return ra - rb;
			}
			const sa = straightnessAt( a.id, ra );
			const sb = straightnessAt( b.id, rb );
			if ( sa !== sb ) {
				return sb - sa;
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
