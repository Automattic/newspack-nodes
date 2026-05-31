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

/**
 * Place a single newly-appeared node WITHOUT re-flowing the rest of the graph —
 * the cheap incremental counterpart to autoLayout. Anchors one column LEFT of a
 * pinned target, or RIGHT of a pinned source (mirroring autoLayout's left→right
 * producer→target flow); with no pinned neighbour it drops into a free row at the
 * left column. Nudges down to the next free grid cell to avoid overlapping a node
 * already at that spot. `positions` is the map of already-placed nodes (overrides
 * + earlier newcomers this pass).
 *
 * @param {string} nodeId    The new node's id.
 * @param {Object} parsed    { nodes, edges } graph (for the new node's edges).
 * @param {Object} positions Map of nodeId → { x, y } already placed.
 * @return {{x: number, y: number}} A grid position for the new node.
 */
export function placeNewNode( nodeId, parsed, positions ) {
	const edges = parsed?.edges ?? [];
	let x = X_PAD;
	let y = Y_PAD;
	let anchored = false;
	for ( const e of edges ) {
		if ( e.from === nodeId && positions[ e.to ] ) {
			x = positions[ e.to ].x - X_STEP;
			y = positions[ e.to ].y;
			anchored = true;
			break;
		}
	}
	if ( ! anchored ) {
		for ( const e of edges ) {
			if ( e.to === nodeId && positions[ e.from ] ) {
				x = positions[ e.from ].x + X_STEP;
				y = positions[ e.from ].y;
				anchored = true;
				break;
			}
		}
	}
	if ( ! anchored ) {
		let maxY = Y_PAD - Y_STEP;
		for ( const p of Object.values( positions ) ) {
			if ( p.x === X_PAD && p.y > maxY ) {
				maxY = p.y;
			}
		}
		y = maxY + Y_STEP;
	}
	if ( x < X_PAD ) {
		x = X_PAD;
	}
	while (
		Object.values( positions ).some( ( p ) => p.x === x && p.y === y )
	) {
		y += Y_STEP;
	}
	return { x, y };
}

const snapHalf = ( v ) => Math.round( v * 2 ) / 2;
const midMinMax = ( arr ) => ( Math.min( ...arr ) + Math.max( ...arr ) ) / 2;
const median = ( arr ) => {
	const s = arr.slice().sort( ( a, b ) => a - b );
	const n = s.length;
	if ( ! n ) {
		return 0;
	}
	return n % 2 ? s[ ( n - 1 ) / 2 ] : ( s[ n / 2 - 1 ] + s[ n / 2 ] ) / 2;
};
// Stable numeric-key sort; ties keep prior order (which is alphabetical here, so
// the layout stays deterministic regardless of registration order).
const stableSort = ( arr, key ) =>
	arr
		.map( ( v, i ) => [ v, i ] )
		.sort( ( a, b ) => key( a[ 0 ] ) - key( b[ 0 ] ) || a[ 1 ] - b[ 1 ] )
		.map( ( x ) => x[ 0 ] );

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

	// ── force-layered layout (winner of the autoLayout bake-off + 3145-node bench) ──
	// x is the DAG-depth column; rows are driven by edge "springs" that pull each
	// node to the round-half midpoint of its placed neighbours (a fan-out producer /
	// fan-in sink lands between its targets / sources, a straight chain shares a row),
	// with intra-column order settled by barycenter crossing-reduction.
	//
	// Canonicalize to alphabetical node order so the layout is independent of the
	// order the runtime registers nodes in — the live graph hands them over
	// backbone-first, which must lay out the same as a topology file (alphabetical).
	const ids = [ ...nodes ]
		.map( ( n ) => n.id )
		.sort( ( a, b ) => String( a ).localeCompare( String( b ) ) );
	const declIdx = {};
	const succ = {};
	const pred = {};
	ids.forEach( ( id, i ) => {
		declIdx[ id ] = i;
		succ[ id ] = [];
		pred[ id ] = [];
	} );
	const nodeSet = new Set( ids );
	for ( const e of edges ) {
		// Skip edges whose endpoints aren't real nodes (the old Map-based layout
		// tolerated these via `|| []`; the plain-object adjacency would throw).
		if ( ! nodeSet.has( e.from ) || ! nodeSet.has( e.to ) ) {
			continue;
		}
		succ[ e.from ].push( e.to );
		pred[ e.to ].push( e.from );
	}

	// Column = longest-path depth (Kahn), every sink/isolated to the deepest column.
	const depth = {};
	const indeg = {};
	for ( const id of ids ) {
		depth[ id ] = 0;
		indeg[ id ] = pred[ id ].length;
	}
	const queue = ids.filter( ( id ) => indeg[ id ] === 0 );
	while ( queue.length ) {
		const u = queue.shift();
		for ( const v of succ[ u ] ) {
			if ( depth[ v ] < depth[ u ] + 1 ) {
				depth[ v ] = depth[ u ] + 1;
			}
			if ( --indeg[ v ] === 0 ) {
				queue.push( v );
			}
		}
	}
	let maxDepth = 0;
	for ( const id of ids ) {
		maxDepth = Math.max( maxDepth, depth[ id ] );
	}
	const col = {};
	for ( const id of ids ) {
		col[ id ] = succ[ id ].length === 0 ? maxDepth : depth[ id ];
	}

	const isIsolated = ( id ) =>
		succ[ id ].length === 0 && pred[ id ].length === 0;
	const columns = [];
	for ( let c = 0; c <= maxDepth; c++ ) {
		columns[ c ] = [];
	}
	for ( const id of ids ) {
		if ( ! isIsolated( id ) ) {
			columns[ col[ id ] ].push( id );
		}
	}
	const isolated = ids.filter( isIsolated );

	// Anchor = the widest connected column; rows propagate outward from it.
	let anchor = 0;
	for ( let c = 0; c <= maxDepth; c++ ) {
		if ( columns[ c ].length > columns[ anchor ].length ) {
			anchor = c;
		}
	}
	const sinkSide = anchor > maxDepth / 2;

	// Barycenter crossing-reduction in index space (alternating down/up sweeps).
	const pos = {};
	const reindex = () =>
		columns.forEach( ( a ) => a.forEach( ( id, i ) => ( pos[ id ] = i ) ) );
	reindex();
	const baryIndex = ( id, nb ) => {
		const a = nb.filter( ( x ) => pos[ x ] !== undefined );
		return a.length
			? a.reduce( ( s, x ) => s + pos[ x ], 0 ) / a.length
			: pos[ id ];
	};
	for ( let s = 0; s < 12; s++ ) {
		for ( let c = 1; c <= maxDepth; c++ ) {
			columns[ c ] = stableSort( columns[ c ], ( id ) =>
				baryIndex( id, pred[ id ] )
			);
			reindex();
		}
		for ( let c = maxDepth - 1; c >= 0; c-- ) {
			columns[ c ] = stableSort( columns[ c ], ( id ) =>
				baryIndex( id, succ[ id ] )
			);
			reindex();
		}
	}

	// Integer-stack the anchor in its order; pull every other node to the round-half
	// midpoint of its already-placed neighbours (the spring step).
	const assignRows = () => {
		const r = {};
		columns[ anchor ].forEach( ( id, i ) => ( r[ id ] = i ) );
		for ( let c = anchor + 1; c <= maxDepth; c++ ) {
			for ( const id of columns[ c ] ) {
				const nb = pred[ id ].filter( ( p ) => r[ p ] !== undefined );
				if ( nb.length ) {
					r[ id ] = midMinMax( nb.map( ( p ) => r[ p ] ) );
				}
			}
		}
		for ( let c = anchor - 1; c >= 0; c-- ) {
			for ( const id of columns[ c ] ) {
				const nb = succ[ id ].filter( ( k ) => r[ k ] !== undefined );
				if ( nb.length ) {
					r[ id ] = midMinMax( nb.map( ( k ) => r[ k ] ) );
				}
			}
		}
		return r;
	};
	let row = assignRows();

	// Fix the anchor's own order + orientation from its neighbours' rows: pick the
	// sign that puts the lowest-index anchor node on the side the layout flows from.
	const anchorKey = ( id ) =>
		median(
			( sinkSide ? pred[ id ] : succ[ id ] )
				.map( ( x ) => row[ x ] )
				.filter( ( v ) => v !== undefined )
		);
	const buildOrder = ( sign ) =>
		stableSort( columns[ anchor ], ( id ) => sign * anchorKey( id ) );
	const firstAtTop = ( ord ) => {
		const first = ord
			.slice()
			.sort( ( a, b ) => declIdx[ a ] - declIdx[ b ] )[ 0 ];
		return ord.indexOf( first ) <= ( ord.length - 1 ) / 2;
	};
	let chosen = buildOrder( 1 );
	for ( const sign of [ 1, -1 ] ) {
		const ord = buildOrder( sign );
		if ( firstAtTop( ord ) === sinkSide ) {
			chosen = ord;
			break;
		}
	}
	columns[ anchor ] = chosen;
	row = assignRows();

	// Settle the remaining columns by neighbour-row median (a few relaxation passes).
	for ( let it = 0; it < 6; it++ ) {
		for ( let c = anchor + 1; c <= maxDepth; c++ ) {
			columns[ c ] = stableSort( columns[ c ], ( id ) =>
				median(
					pred[ id ]
						.map( ( x ) => row[ x ] )
						.filter( ( v ) => v !== undefined )
				)
			);
		}
		for ( let c = anchor - 1; c >= 0; c-- ) {
			columns[ c ] = stableSort( columns[ c ], ( id ) =>
				median(
					succ[ id ]
						.map( ( x ) => row[ x ] )
						.filter( ( v ) => v !== undefined )
				)
			);
		}
		row = assignRows();
	}

	// Resolve same-column overlaps by spreading each colliding cluster symmetrically
	// around its barycenter (pool-adjacent-violators), not just pushing down — so a
	// producer's fan-out leaves straddle it (tee → out/_repl land above/below tee)
	// instead of dropping below. Non-overlapping columns are untouched.
	columns.forEach( ( arr ) => {
		const sorted = [ ...arr ].sort(
			( a, b ) => row[ a ] - row[ b ] || declIdx[ a ] - declIdx[ b ]
		);
		const blocks = [];
		for ( const id of sorted ) {
			let block = { ids: [ id ], first: row[ id ] };
			// Merge with the previous block while the 1-row-spaced layouts would
			// overlap; a merged block sits at the barycenter of its members' wants.
			while ( blocks.length ) {
				const prev = blocks[ blocks.length - 1 ];
				if ( block.first >= prev.first + prev.ids.length - 1e-9 ) {
					break;
				}
				const merged = prev.ids.concat( block.ids );
				let sum = 0;
				merged.forEach( ( m, k ) => ( sum += row[ m ] - k ) );
				block = { ids: merged, first: sum / merged.length };
				blocks.pop();
			}
			blocks.push( block );
		}
		for ( const b of blocks ) {
			const first = snapHalf( b.first );
			b.ids.forEach( ( m, k ) => ( row[ m ] = first + k ) );
		}
	} );

	// Isolated nodes stack below the deepest connected column.
	let maxRow = -Infinity;
	columns[ maxDepth ].forEach(
		( id ) => ( maxRow = Math.max( maxRow, row[ id ] ) )
	);
	if ( maxRow === -Infinity ) {
		maxRow = -1;
	}
	isolated.forEach( ( id, i ) => {
		col[ id ] = maxDepth;
		row[ id ] = maxRow + 1 + i;
	} );

	// Normalize: shift every row so the topmost is 0 (the barycenter spread can push
	// a fan-out cluster to negative rows when its producer sits near the top).
	let minRow = Infinity;
	for ( const id of ids ) {
		if ( row[ id ] < minRow ) {
			minRow = row[ id ];
		}
	}
	if ( minRow !== Infinity && minRow !== 0 ) {
		for ( const id of ids ) {
			row[ id ] -= minRow;
		}
	}

	const positioned = nodes.map( ( n ) => ( {
		...n,
		position: {
			x: X_PAD + ( col[ n.id ] ?? 0 ) * X_STEP,
			y: Y_PAD + ( row[ n.id ] ?? 0 ) * Y_STEP,
		},
	} ) );

	return { nodes: positioned, edges };
}
