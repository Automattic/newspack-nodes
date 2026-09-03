/**
 * Grid geometry for the topology canvas: the automatic layout, and the snap
 * every drag lands on.
 *
 * `autoLayout` turns a parsed `{nodes, edges}` graph into left-to-right layered
 * positions; `snapToGrid`, `snapPosition` and `snapClusterDelta` quantise a
 * pointer gesture; `placeBelow` finds a slot for a node that appears after the
 * layout ran. All of them measure from the four step-and-pad constants below,
 * which `SchematicCanvas` also draws its background grid from, so a dragged
 * card and a laid-out card cannot land on different grids. The snap helpers
 * quantise to HALF a step, because `autoLayout` puts a fan-out producer on a
 * half row and a full-step lattice could not reproduce its own output.
 *
 * Columns come from a Coffman-Graham-flavored layering: a true source pins to
 * column 0, a true sink to the rightmost column, and an interior node takes the
 * barycenter of its neighbours' columns clamped into the band its edges allow
 * (longest path from a source on the left, longest path to a sink on the
 * right), so a "processor tier" aligns in one column instead of spreading by
 * raw longest-path. Rows come from barycenter crossing-reduction in index
 * space, a median settle, and a symmetric spread of same-column overlaps.
 */

/** Horizontal distance between layout columns, in canvas pixels. */
export const X_STEP = 240;

/** Vertical distance between layout rows, in canvas pixels. */
export const Y_STEP = 110;

/** Canvas x of column 0, and the snap lattice's horizontal origin. */
export const X_PAD = 60;

/** Canvas y of row 0, and the snap lattice's vertical origin. */
export const Y_PAD = 80;

/**
 * Card width the snap grid centres on.
 *
 * `snapToGrid` converts a pointer centre into the top-left the canvas stores,
 * so it has to know how wide the card renders. `SchematicCanvas` owns the
 * rendered pair; a mismatch puts every drop off-centre by half the difference.
 */
const NODE_W = 196;

/** Card height the snap grid centres on; the partner of `NODE_W`. */
const NODE_H = 84;

/**
 * Snap a pointer drop to the nearest grid intersection.
 *
 * The drop point is where the pointer released, i.e. the card's centre; the
 * returned position is the card's top-left, which is what the canvas stores.
 *
 * @param {number} x Drop point's centre x, in canvas coordinates.
 * @param {number} y Drop point's centre y, in canvas coordinates.
 * @return {{x: number, y: number}} The snapped top-left position.
 */
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
 * Snap a top-left POSITION onto the lattice `snapToGrid` drops onto.
 *
 * `snapToGrid` takes a pointer centre and has to subtract the card size; a drag
 * already carries a top-left, so this one quantises it directly. Both land on
 * half-step intersections.
 *
 * @param {number} x Current top-left x, in canvas coordinates.
 * @param {number} y Current top-left y, in canvas coordinates.
 * @return {{x: number, y: number}} The snapped top-left position.
 */
export function snapPosition( x, y ) {
	const sx = X_STEP / 2;
	const sy = Y_STEP / 2;
	return {
		x: X_PAD + Math.round( ( x - X_PAD ) / sx ) * sx,
		y: Y_PAD + Math.round( ( y - Y_PAD ) / sy ) * sy,
	};
}

/**
 * The delta a hull drag should commit: snap the ANCHOR member's absolute target,
 * then move every member by that same delta.
 *
 * Snapping each member's own position would quantise away the cluster's internal
 * offsets and reshape the group you grabbed. Snapping the raw delta instead
 * preserves whatever offset a member already carries, so an off-grid cluster
 * could never be tidied by dragging its hull. Anchoring gives both: the shape
 * survives and the cluster lands on the grid. An empty map has no anchor, so
 * the raw delta passes through.
 *
 * @param {Object<string,{x: number, y: number}>} origin Members' start positions.
 * @param {number}                                dx     Raw pointer dx.
 * @param {number}                                dy     Raw pointer dy.
 * @return {{dx: number, dy: number}} The snapped delta to apply to every member.
 */
export function snapClusterDelta( origin, dx, dy ) {
	// Top-left-most member, so the anchor is stable across drags of one hull.
	const anchor = Object.values( origin ).reduce(
		( a, p ) =>
			! a || p.x < a.x || ( p.x === a.x && p.y < a.y ) ? p : a,
		null
	);
	if ( ! anchor ) {
		return { dx, dy };
	}
	const target = snapPosition( anchor.x + dx, anchor.y + dy );
	return { dx: target.x - anchor.x, dy: target.y - anchor.y };
}

/**
 * Tuck a node that appeared after the layout ran below the bottom-most card of
 * the left-most column.
 *
 * Hand it only the nodes currently on the canvas: an entry left behind by a
 * deleted node would tuck new cards underneath a card nobody can see. An empty
 * or missing map yields the origin cell.
 *
 * @param {?Object<string,{x: number, y: number}>} positions Node id to position.
 * @return {{x: number, y: number}} The new node's position.
 */
export function placeBelow( positions ) {
	const vals = Object.values( positions || {} );
	if ( vals.length === 0 ) {
		return { x: X_PAD, y: Y_PAD };
	}
	let minX = Infinity;
	for ( const p of vals ) {
		if ( p.x < minX ) {
			minX = p.x;
		}
	}
	let bottom = -Infinity;
	for ( const p of vals ) {
		if ( p.x === minX && p.y > bottom ) {
			bottom = p.y;
		}
	}
	return { x: minX, y: bottom + Y_STEP };
}

/**
 * Round a row index to the nearest half.
 *
 * Rows land on the same half-step lattice the snap helpers quantise to, so a
 * spread block's fractional row stays a position a later drag can reproduce.
 *
 * @param {number} v Row index, whole or fractional.
 * @return {number} The row rounded to the nearest 0.5.
 */
const snapHalf = ( v ) => Math.round( v * 2 ) / 2;

/**
 * Midpoint of an array's smallest and largest value.
 *
 * A fan centres on its OUTERMOST neighbours rather than their mean: a mean
 * drags the node toward whichever side is crowded, bending the one link to the
 * lone neighbour on the other side.
 *
 * @param {Array<number>} arr Neighbour rows; an empty array yields NaN.
 * @return {number} The midpoint of the extremes.
 */
const midMinMax = ( arr ) => ( Math.min( ...arr ) + Math.max( ...arr ) ) / 2;

/**
 * Median of a numeric array.
 *
 * The settle passes order a column by its neighbours' rows, where the median
 * resists the one distant neighbour that would drag a mean across the column.
 *
 * @param {Array<number>} arr Values to take the median of.
 * @return {number} The median, or 0 for an empty array.
 */
const median = ( arr ) => {
	const s = arr.slice().sort( ( a, b ) => a - b );
	const n = s.length;
	if ( ! n ) {
		return 0;
	}
	return n % 2 ? s[ ( n - 1 ) / 2 ] : ( s[ n / 2 - 1 ] + s[ n / 2 ] ) / 2;
};

/**
 * Sort by a numeric key, keeping the input order for equal keys.
 *
 * Columns start in alphabetical id order, so a tie resolves the same way on
 * every run and one topology always lays out identically.
 *
 * @param {Array<*>}            arr Items to sort.
 * @param {function(*): number} key The sort key for one item.
 * @return {Array<*>} A new sorted array; `arr` is left alone.
 */
const stableSort = ( arr, key ) =>
	arr
		.map( ( v, i ) => [ v, i ] )
		.sort( ( a, b ) => key( a[ 0 ] ) - key( b[ 0 ] ) || a[ 1 ] - b[ 1 ] )
		.map( ( x ) => x[ 0 ] );

/**
 * Lay a parsed graph out on the grid, using the layering described at the top.
 *
 * `parsed` is `{ nodes: [ { id } ], edges: [ { from, to } ] }`; null, or either
 * key missing, reads as empty. An edge whose endpoints are not both in `nodes`
 * is skipped, so a graph carrying a dangling edge lays out rather than throwing.
 * A graph with no edges at all becomes an alphabetical, roughly square grid; a
 * node with no edges inside a graph that has them stacks below one end column.
 *
 * @param {?{nodes?: Array<{id: string}>, edges?: Array<{from: string, to: string}>}} parsed The graph to lay out.
 * @return {{nodes: Array<{id: string, position: {x: number, y: number}}>, edges: Array<Object>}}
 * Every input node copied with a `position` added, and `edges` passed straight
 * through. Neither input array nor any input node is mutated.
 */
export function autoLayout( parsed ) {
	const nodes = parsed?.nodes ?? [];
	const edges = parsed?.edges ?? [];

	// Edgeless nodes would all stack in column 0; grid them instead.
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

	// Coffman-Graham columns + spring rows; alpha-canonical so live == .tsl.
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
		// Skip dangling edges (adjacency would throw on a missing endpoint).
		if ( ! nodeSet.has( e.from ) || ! nodeSet.has( e.to ) ) {
			continue;
		}
		succ[ e.from ].push( e.to );
		pred[ e.to ].push( e.from );
	}

	const isSource = ( id ) => pred[ id ].length === 0;
	const isSink = ( id ) => succ[ id ].length === 0;
	const isIsolated = ( id ) => isSource( id ) && isSink( id );

	// Longest-path depth from sources (Kahn).
	const depth = {};
	const indeg = {};
	for ( const id of ids ) {
		depth[ id ] = 0;
		indeg[ id ] = pred[ id ].length;
	}
	const dq = ids.filter( ( id ) => indeg[ id ] === 0 );
	while ( dq.length ) {
		const u = dq.shift();
		for ( const v of succ[ u ] ) {
			if ( depth[ v ] < depth[ u ] + 1 ) {
				depth[ v ] = depth[ u ] + 1;
			}
			if ( --indeg[ v ] === 0 ) {
				dq.push( v );
			}
		}
	}
	let maxDepth = 0;
	for ( const id of ids ) {
		maxDepth = Math.max( maxDepth, depth[ id ] );
	}

	// Longest-path height to sinks (reverse Kahn) — feasibility upper bound.
	const height = {};
	const outdeg = {};
	for ( const id of ids ) {
		height[ id ] = 0;
		outdeg[ id ] = succ[ id ].length;
	}
	const hq = ids.filter( ( id ) => outdeg[ id ] === 0 );
	while ( hq.length ) {
		const u = hq.shift();
		for ( const p of pred[ u ] ) {
			if ( height[ p ] < height[ u ] + 1 ) {
				height[ p ] = height[ u ] + 1;
			}
			if ( --outdeg[ p ] === 0 ) {
				hq.push( p );
			}
		}
	}

	// Coffman-Graham: pin sources/sinks, relax interior to barycenter in-band.
	const col = {};
	for ( const id of ids ) {
		if ( isIsolated( id ) ) {
			col[ id ] = null;
		} else if ( isSource( id ) ) {
			col[ id ] = 0;
		} else if ( isSink( id ) ) {
			col[ id ] = maxDepth;
		} else {
			col[ id ] = depth[ id ];
		}
	}
	for ( let pass = 0; pass < 20; pass++ ) {
		for ( const id of ids ) {
			if ( col[ id ] === null || isSource( id ) || isSink( id ) ) {
				continue;
			}
			const lo = depth[ id ];
			const hi = maxDepth - height[ id ];
			if ( lo >= hi ) {
				col[ id ] = lo;
				continue;
			}
			const nb = [ ...pred[ id ], ...succ[ id ] ]
				.map( ( n ) => col[ n ] )
				.filter( ( v ) => v !== null );
			if ( ! nb.length ) {
				col[ id ] = lo;
				continue;
			}
			const bary = nb.reduce( ( a, b ) => a + b, 0 ) / nb.length;
			col[ id ] = Math.max( lo, Math.min( hi, Math.round( bary ) ) );
		}
	}

	// Isolated cards go left only when the graph is deep and source-heavy.
	const sourceCount = ids.filter(
		( id ) => isSource( id ) && ! isIsolated( id )
	).length;
	const isolatedToLeft = maxDepth >= 3 && sourceCount >= maxDepth;
	const isolatedCol = isolatedToLeft ? 0 : maxDepth;
	for ( const id of ids ) {
		if ( isIsolated( id ) ) {
			col[ id ] = isolatedCol;
		}
	}

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

	// Barycenter crossing-reduction in index space (alternating sweeps).
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

	// Integer-stack the anchor; spring others to neighbour-row midpoint.
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
		// @longform A component that never reaches the anchor column is
		// seeded by neither sweep, and the spread pass below turns an
		// unset row into NaN — the card then renders off-graph, silently.
		// Stack the leftovers under their own column instead.
		for ( let c = 0; c <= maxDepth; c++ ) {
			let next = null;
			for ( const id of columns[ c ] ) {
				if ( r[ id ] !== undefined ) {
					continue;
				}
				if ( null === next ) {
					const taken = columns[ c ]
						.map( ( x ) => r[ x ] )
						.filter( ( v ) => v !== undefined );
					next = taken.length ? Math.max( ...taken ) + 1 : 0;
				}
				r[ id ] = next++;
			}
		}
		return r;
	};
	let row = assignRows();

	// Orient the anchor so the lowest-index node sits on the flow-from side.
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

	// Settle remaining columns by neighbour-row median (a few passes).
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

	// Spread same-column overlaps symmetrically (PAV) so fan-out straddles.
	columns.forEach( ( arr ) => {
		const sorted = [ ...arr ].sort(
			( a, b ) => row[ a ] - row[ b ] || declIdx[ a ] - declIdx[ b ]
		);
		const blocks = [];
		for ( const id of sorted ) {
			let block = { ids: [ id ], first: row[ id ] };
			// Merge into the previous block while 1-row-spaced layouts overlap.
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

	// Isolated nodes stack below the deepest node of the column they joined.
	let maxRow = -Infinity;
	columns[ isolatedCol ].forEach(
		( id ) => ( maxRow = Math.max( maxRow, row[ id ] ) )
	);
	if ( maxRow === -Infinity ) {
		maxRow = -1;
	}
	isolated.forEach( ( id, i ) => {
		col[ id ] = isolatedCol;
		row[ id ] = maxRow + 1 + i;
	} );

	// Normalize rows so the topmost is 0 (spread can push clusters negative).
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
