/**
 * Grid geometry for the topology canvas: the automatic layout, and the snap
 * every drag lands on.
 *
 * `autoLayout` turns a parsed `{nodes, edges}` graph into positions;
 * `snapToGrid`, `snapPosition` and `snapClusterDelta` quantise a pointer
 * gesture; `placeBelow` finds a slot for a node that appears after the layout
 * ran. All of them measure from the four step-and-pad constants below, which
 * `SchematicCanvas` also draws its background grid from, so a dragged card and
 * a laid-out card cannot land on different grids. The snap helpers quantise to
 * HALF a step, because `autoLayout` puts a fan-out producer on a half row and a
 * full-step lattice could not reproduce its own output.
 *
 * The layout runs one of two regimes, chosen by whether the graph has HUBS:
 * nodes whose FAN-IN clears both `HUB_MIN_FAN_IN` and `HUB_MEDIAN_FACTOR`
 * times the median fan-in of the nodes anything feeds. Fan-in, not degree: a
 * node many separate slices feed is what a single layering scatters, because
 * the ordering sweep that runs against the flow hands every feeder of that
 * node one key and the feeders' own slices come apart around it. A node that
 * fans OUT orders its consumers with the flow and scatters nothing, so a Tee
 * feeding four partitions is a wire, not a backbone. The backbone sits to the
 * right of every band, so a hub that also feeds a band draws that edge
 * leftward; the realms' hubs are sinks or feed only a bridge.
 *
 * With no hub the graph is laid out whole, as one layered component. Columns
 * come from a Coffman-Graham-flavored layering: a true source pins to column 0,
 * a true sink to the rightmost column, and an interior node takes the
 * barycenter of its neighbours' columns clamped into the band its edges allow
 * (longest path from a source on the left, longest path to a sink on the
 * right), so a "processor tier" aligns in one column instead of spreading by
 * raw longest-path. Rows come from barycenter crossing-reduction in index
 * space, a median settle, and a symmetric spread of same-column overlaps.
 *
 * With hubs that single layering is wrong: the hubs make the graph deep, every
 * sink pins to its far end, and a two-node slice is stretched across the whole
 * width while one slice's members scatter over unrelated rows. So the backbone
 * — the hubs, plus any bridge whose every neighbour is a hub — comes out, each
 * weakly-connected component of what is left is laid out on its own by the
 * same layering and the bands stack alphabetically, and the backbone takes
 * the columns to their right, layered by its own longest path.
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
 * Alphabetical id order.
 *
 * Every tie in the layout breaks here, so one graph lays out one way however
 * its nodes reached the canvas.
 *
 * @param {string} a One id.
 * @param {string} b The other.
 * @return {number} The comparator's verdict.
 */
const byId = ( a, b ) => String( a ).localeCompare( String( b ) );

/** A hub's floor fan-in; below it a node is ordinary however sparse the graph. */
const HUB_MIN_FAN_IN = 4;

/** How far above the median fan-in a hub must sit, so a dense graph declares none. */
const HUB_MEDIAN_FACTOR = 3;

/**
 * Longest path to every node, walking `next` from the nodes nothing enters.
 *
 * Kahn's algorithm over `next`, so a node's value counts the edges on the
 * longest chain reaching it. Swapping the two arguments walks the graph the
 * other way, which is how the layering gets both its depth from the sources and
 * its height to the sinks out of one implementation. A cycle's nodes never
 * reach in-degree zero and keep the seed 0, which is what breaks a loop into a
 * layerable graph instead of hanging.
 *
 * @param {Array<string>}                ids  Nodes to walk, in seed order.
 * @param {Object<string,Array<string>>} next Edges to follow.
 * @param {Object<string,Array<string>>} prev The reverse of `next`, read for in-degree.
 * @return {Object<string,number>} Node id to longest-path length.
 */
const longestPath = ( ids, next, prev ) => {
	/** @type {Object<string,number>} */
	const dist = {};
	/** @type {Object<string,number>} */
	const indeg = {};
	for ( const id of ids ) {
		dist[ id ] = 0;
		indeg[ id ] = prev[ id ].length;
	}
	const queue = ids.filter( ( id ) => indeg[ id ] === 0 );
	while ( queue.length ) {
		const u = queue.shift();
		for ( const v of next[ u ] ) {
			if ( dist[ v ] < dist[ u ] + 1 ) {
				dist[ v ] = dist[ u ] + 1;
			}
			if ( --indeg[ v ] === 0 ) {
				queue.push( v );
			}
		}
	}
	return dist;
};

/**
 * Narrow an adjacency map to the edges staying inside one id set.
 *
 * A band is laid out on its own, so an edge leaving it — into a hub, or into
 * another band — must not reach the layering, or the band would be sized and
 * ordered by nodes it does not contain.
 *
 * @param {Array<string>}                ids       The id set.
 * @param {Object<string,Array<string>>} adjacency The whole graph's neighbours.
 * @return {Object<string,Array<string>>} Neighbours inside `ids` only.
 */
const restrictAdjacency = ( ids, adjacency ) => {
	const inside = new Set( ids );
	/** @type {Object<string,Array<string>>} */
	const out = {};
	for ( const id of ids ) {
		out[ id ] = adjacency[ id ].filter( ( n ) => inside.has( n ) );
	}
	return out;
};

/**
 * Shift every row so the topmost sits at 0.
 *
 * A spread block averages its members' desired rows, so it can settle above the
 * first row; the canvas draws from the origin.
 *
 * @param {Array<string>}         ids Nodes to shift.
 * @param {Object<string,number>} row Rows, mutated in place.
 */
const normalizeRows = ( ids, row ) => {
	let minRow = Infinity;
	for ( const id of ids ) {
		if ( row[ id ] < minRow ) {
			minRow = row[ id ];
		}
	}
	if ( minRow === Infinity || minRow === 0 ) {
		return;
	}
	for ( const id of ids ) {
		row[ id ] -= minRow;
	}
};

/**
 * Spread one column's overlapping rows apart, symmetrically.
 *
 * Pool-adjacent-violators: merge a card into the block above it while their
 * one-row-apart layouts would overlap, and re-centre the merged block on the
 * mean of its members' desired rows. Centring is what makes a fan-out straddle
 * its targets instead of shunting the whole stack downward.
 *
 * @param {Array<string>}         members Ids sharing the column.
 * @param {Object<string,number>} row     Desired rows, mutated in place.
 * @param {Object<string,number>} order   Tie-break rank for equal rows.
 */
const spreadColumn = ( members, row, order ) => {
	const sorted = [ ...members ].sort(
		( a, b ) => row[ a ] - row[ b ] || order[ a ] - order[ b ]
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
};

/**
 * The nodes every slice is wired into: the backbone a single layering would
 * stretch the whole graph around.
 *
 * Fan-in is the predecessor count over the non-dangling edges. The floor
 * keeps a sparse graph's busiest node ordinary, and the median multiple keeps
 * a uniformly dense graph from declaring most of itself a hub — a backbone is
 * only a backbone when it stands well clear of what it serves. The median is
 * taken over the nodes anything feeds, since every source's zero would
 * otherwise drag it to nothing.
 *
 * @param {Array<string>}                ids  Every node.
 * @param {Object<string,Array<string>>} pred Predecessors.
 * @return {Set<string>} The hub ids, empty when the graph has no backbone.
 */
const hubIds = ( ids, pred ) => {
	const fed = ids.filter( ( id ) => pred[ id ].length > 0 );
	const cut = Math.max(
		HUB_MIN_FAN_IN,
		HUB_MEDIAN_FACTOR * median( fed.map( ( id ) => pred[ id ].length ) )
	);
	return new Set( fed.filter( ( id ) => pred[ id ].length >= cut ) );
};

/**
 * Weakly-connected components of an id set, each sorted.
 *
 * `ids` arrives alphabetical and is walked in that order, so the first unvisited
 * node of a component IS that component's lowest-sorting id and the components
 * come out alphabetically — which is what puts one subject's slices together on
 * the canvas. A node whose every edge leaves the set is a component of one.
 *
 * @param {Array<string>}                ids  The id set to partition.
 * @param {Object<string,Array<string>>} succ Successors.
 * @param {Object<string,Array<string>>} pred Predecessors.
 * @return {Array<Array<string>>} Each component's sorted members.
 */
const componentsOf = ( ids, succ, pred ) => {
	const inside = new Set( ids );
	const seen = new Set();
	const out = [];
	for ( const start of ids ) {
		if ( seen.has( start ) ) {
			continue;
		}
		const members = [];
		const stack = [ start ];
		seen.add( start );
		while ( stack.length ) {
			const id = stack.pop();
			members.push( id );
			for ( const n of [ ...succ[ id ], ...pred[ id ] ] ) {
				if ( inside.has( n ) && ! seen.has( n ) ) {
					seen.add( n );
					stack.push( n );
				}
			}
		}
		out.push( members.sort( byId ) );
	}
	return out;
};

/**
 * Lay ONE component out in grid units, using the layering described at the top.
 *
 * The driver calls this on the whole graph when it finds no hub, and on each
 * band when it does, so a band is sized by its own depth rather than the
 * graph's. `succ` and `pred` must already be narrowed to `ids`.
 *
 * @param {Array<string>}                ids  The component's nodes, alphabetical.
 * @param {Object<string,Array<string>>} succ Successors inside the component.
 * @param {Object<string,Array<string>>} pred Predecessors inside the component.
 * @return {{col: Object<string,number>, row: Object<string,number>}} Grid units,
 * rows normalised so the topmost is 0.
 */
const layoutComponent = ( ids, succ, pred ) => {
	/** @type {Object<string,number>} */
	const declIdx = {};
	ids.forEach( ( id, i ) => ( declIdx[ id ] = i ) );

	const isSource = ( id ) => pred[ id ].length === 0;
	const isSink = ( id ) => succ[ id ].length === 0;
	const isIsolated = ( id ) => isSource( id ) && isSink( id );

	// Longest path from the sources, and to the sinks — the feasibility band.
	const depth = longestPath( ids, succ, pred );
	const height = longestPath( ids, pred, succ );
	let maxDepth = 0;
	for ( const id of ids ) {
		maxDepth = Math.max( maxDepth, depth[ id ] );
	}

	// Coffman-Graham: pin sources/sinks, relax interior to barycenter in-band.
	/** @type {Object<string,number>} */
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
	/** @type {Object<string,number>} */
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
		/** @type {Object<string,number>} */
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
	columns.forEach( ( arr ) => spreadColumn( arr, row, declIdx ) );

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

	normalizeRows( ids, row );
	return { col, row };
};

/**
 * The backbone: the hubs plus every BRIDGE, a node whose every neighbour is a
 * hub. A bridge stacked as a loner would put `_http`, which only joins
 * `_shell` to `_output`, in the band column with both its edges running back
 * across the canvas; placed with the hubs it takes its place in their chain.
 *
 * @param {Set<string>}                  hubs The hub ids.
 * @param {Array<string>}                ids  Every node, alphabetical.
 * @param {Object<string,Array<string>>} succ Successors.
 * @param {Object<string,Array<string>>} pred Predecessors.
 * @return {Array<string>} The backbone ids, alphabetical.
 */
const backboneOf = ( hubs, ids, succ, pred ) =>
	ids.filter( ( id ) => {
		if ( hubs.has( id ) ) {
			return true;
		}
		const nb = [ ...succ[ id ], ...pred[ id ] ];
		return nb.length > 0 && nb.every( ( n ) => hubs.has( n ) );
	} );

/**
 * Column and row for the backbone, appended to the maps the bands filled.
 * Columns come from the longest path among the backbone's own nodes, offset by
 * `baseCol`, so `settings:consumer → settings-sync → spoke → null` reads left
 * to right past the bands. A row is the midpoint of the band rows the node
 * serves; a node serving no band centres on the backbone neighbours already
 * placed, which is why band-serving nodes are placed first. Same-column
 * collisions spread as a band column's do.
 *
 * @param {Array<string>}                backbone Backbone ids, alphabetical.
 * @param {Object<string,Array<string>>} succ     Whole-graph successors.
 * @param {Object<string,Array<string>>} pred     Whole-graph predecessors.
 * @param {number}                       baseCol  The column depth 0 takes.
 * @param {Object<string,number>}        col      Column map, extended in place.
 * @param {Object<string,number>}        row      Row map, extended in place.
 */
const placeBackbone = ( backbone, succ, pred, baseCol, col, row ) => {
	const inside = new Set( backbone );
	const depth = longestPath(
		backbone,
		restrictAdjacency( backbone, succ ),
		restrictAdjacency( backbone, pred )
	);
	/** @type {Object<string,number>} */
	const order = {};
	backbone.forEach( ( id, i ) => ( order[ id ] = i ) );
	const rowsOf = ( list ) =>
		list.map( ( n ) => row[ n ] ).filter( ( v ) => v !== undefined );

	// One partition pass: band-serving nodes first, then the bridges.
	const serving = [];
	const bridges = [];
	for ( const id of backbone ) {
		const neighbours = [ ...pred[ id ], ...succ[ id ] ];
		( neighbours.some( ( n ) => ! inside.has( n ) )
			? serving
			: bridges
		).push( id );
	}
	for ( const id of [ ...serving, ...bridges ] ) {
		col[ id ] = baseCol + depth[ id ];
		const neighbours = [ ...pred[ id ], ...succ[ id ] ];
		const served = rowsOf(
			neighbours.filter( ( n ) => ! inside.has( n ) )
		);
		const rows = served.length ? served : rowsOf( neighbours );
		row[ id ] = rows.length ? snapHalf( midMinMax( rows ) ) : 0;
	}

	/** @type {Object<string,Array<string>>} */
	const byCol = {};
	for ( const id of backbone ) {
		( byCol[ col[ id ] ] ??= [] ).push( id );
	}
	for ( const members of Object.values( byCol ) ) {
		spreadColumn( members, row, order );
	}
};

/**
 * Lay a hub-bearing graph out as stacked bands with the backbone to their
 * right.
 *
 * Each band is one weakly-connected component of the graph minus its backbone,
 * laid out on its own so its width is its own depth, and offset one row below
 * the band above it — the row step IS the gap, since a card is shorter than
 * `Y_STEP`. A component of one carries no shape worth a band of its own, so
 * those stack together under the bands, as an edgeless node does today.
 *
 * @param {Array<string>}                ids  Every node, alphabetical.
 * @param {Object<string,Array<string>>} succ Successors.
 * @param {Object<string,Array<string>>} pred Predecessors.
 * @param {Set<string>}                  hubs The hub ids.
 * @return {{col: Object<string,number>, row: Object<string,number>}} Grid units,
 * rows normalised so the topmost is 0.
 */
const layoutBands = ( ids, succ, pred, hubs ) => {
	/** @type {Object<string,number>} */
	const col = {};
	/** @type {Object<string,number>} */
	const row = {};
	const backbone = backboneOf( hubs, ids, succ, pred );
	const inside = new Set( backbone );
	const banded = ids.filter( ( id ) => ! inside.has( id ) );
	const loners = [];
	let maxCol = -1;
	let nextRow = 0;
	for ( const members of componentsOf( banded, succ, pred ) ) {
		if ( members.length === 1 ) {
			loners.push( members[ 0 ] );
			continue;
		}
		const band = layoutComponent(
			members,
			restrictAdjacency( members, succ ),
			restrictAdjacency( members, pred )
		);
		let height = 0;
		for ( const id of members ) {
			col[ id ] = band.col[ id ];
			row[ id ] = band.row[ id ] + nextRow;
			maxCol = Math.max( maxCol, col[ id ] );
			height = Math.max( height, band.row[ id ] );
		}
		nextRow += height + 1;
	}
	for ( const id of loners ) {
		col[ id ] = 0;
		row[ id ] = nextRow++;
		maxCol = Math.max( maxCol, 0 );
	}

	placeBackbone( backbone, succ, pred, maxCol + 1, col, row );

	normalizeRows( ids, row );
	return { col, row };
};

/**
 * Lay a parsed graph out on the grid, in whichever of the two regimes described
 * at the top its hubs select.
 *
 * `parsed` is `{ nodes: [ { id } ], edges: [ { from, to } ] }`; null, or either
 * key missing, reads as empty. An edge whose endpoints are not both in `nodes`
 * is skipped, so a graph carrying a dangling edge lays out rather than throwing.
 * A graph with no edges at all becomes an alphabetical, roughly square grid.
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

	// Alpha-canonical ids, so the live graph lays out like its .tsl.
	const ids = [ ...nodes ].map( ( n ) => n.id ).sort( byId );
	/** @type {Object<string,Array<string>>} */
	const succ = {};
	/** @type {Object<string,Array<string>>} */
	const pred = {};
	for ( const id of ids ) {
		succ[ id ] = [];
		pred[ id ] = [];
	}
	const nodeSet = new Set( ids );
	for ( const e of edges ) {
		// Skip dangling edges (adjacency would throw on a missing endpoint).
		if ( ! nodeSet.has( e.from ) || ! nodeSet.has( e.to ) ) {
			continue;
		}
		succ[ e.from ].push( e.to );
		pred[ e.to ].push( e.from );
	}

	const hubs = hubIds( ids, pred );
	const { col, row } =
		hubs.size === 0
			? layoutComponent( ids, succ, pred )
			: layoutBands( ids, succ, pred, hubs );

	const positioned = nodes.map( ( n ) => ( {
		...n,
		position: {
			x: X_PAD + ( col[ n.id ] ?? 0 ) * X_STEP,
			y: Y_PAD + ( row[ n.id ] ?? 0 ) * Y_STEP,
		},
	} ) );

	return { nodes: positioned, edges };
}
