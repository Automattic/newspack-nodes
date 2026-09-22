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
 * The graph lays out as BANDS: each weakly-connected component is layered on
 * its own, so a two-node slice spans two columns whatever depth its neighbours
 * reach, and one slice's members never share rows with another's. The bands
 * gather into BLOCKS — a hub with the bands that feed it, or a band feeding no
 * hub on its own, merged with every block a wire joins it to — and the blocks
 * pack into side-by-side stacks toward a canvas about as wide as it is tall,
 * widest blocks first; a small graph fills one stack. A block that would open
 * a new stack waits for every other block instead, then takes any room above
 * or below the cards in the columns it would cover, clear of every wire
 * already drawn, so a tall block's short neighbours sit beside its feeders
 * rather than past its hub. An edgeless node is a block of one.
 *
 * Within a band, columns come from a Coffman-Graham-flavored layering: a true
 * source starts in column 0, a true sink seats one column past its own depth
 * and rises to the furthest consumer it shares a feeder with, and an interior
 * node takes the barycenter of its neighbours' columns clamped
 * into the range its edges allow (longest path from a source on the left,
 * longest path to a sink on the right), so a "processor tier" aligns in one
 * column instead of spreading by raw longest-path. Rows come from barycenter
 * crossing-reduction in index space, a median settle, and a symmetric spread
 * of same-column overlaps — with a wire that spans two or more columns
 * standing in for itself as a placeholder in every column between, so the
 * sweeps put a card on the right side of it, and a last pass (`clearWires`)
 * nudging any card off the span such a wire is drawn across. A source whose
 * successors all sit in one column, two or more columns on, has a column to
 * choose, so its wires take no placeholder: `seatSources` seats it inside its
 * band, growing the band downward so its height covers the seat, then again
 * once its block is laid out. Where that column lies left of the anchor, it waits
 * there for the row spread, so it straddles a card fanning to the same
 * column instead of taking the nearest row that card leaves free.
 *
 * HUBS leave their band for the column right after the bands that feed them,
 * on those bands' middle row, with the bands they feed continuing to their
 * right, level with them — a hub is not always the end of its chain. A hub
 * is a node whose FAN-IN clears both `HUB_MIN_FAN_IN` and `HUB_MEDIAN_FACTOR`
 * times the median fan-in of the nodes anything feeds; the backbone is the
 * hubs plus any bridge whose every neighbour is a hub. A node many separate slices
 * feed would otherwise weld those slices into one component, and the ordering
 * sweep that runs against the flow hands every feeder of that node one key, so
 * the feeders' own slices come apart around it. Fan-in, not degree: a node
 * that fans OUT orders its consumers with the flow and scatters nothing, so a
 * Tee feeding four partitions is a wire, not a hub. A band wired to several
 * hubs goes with the one serving the fewest bands — a publication's own over
 * the fleet's — and a hub every band left for a closer one sits beside the
 * block holding most of its feeders. A block's hubs layer by their own
 * longest path; a hub that also feeds a band draws that edge leftward.
 *
 * Half a step opens between two columns where three or more wires meet one
 * node across that boundary — into a hub, out of a Tee, or neither — so
 * converging and diverging wires have room to fan. A wire running on past
 * the next column crowds no boundary. The shift is per column, not per block,
 * because stacks share columns.
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
 * Each key is taken ONCE, before the sort: a comparator reads its operands
 * O(n log n) times, and every key here walks a node's neighbours.
 *
 * @param {Array<*>}            arr Items to sort.
 * @param {function(*): number} key The sort key for one item.
 * @return {Array<*>} A new sorted array; `arr` is left alone.
 */
const stableSort = ( arr, key ) =>
	arr
		.map( ( v, i ) => [ v, i, key( v ) ] )
		.sort( ( a, b ) => a[ 2 ] - b[ 2 ] || a[ 1 ] - b[ 1 ] )
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

/** Wires to one adjacent column before a half step opens at that boundary. */
const GAP_MIN_WIRES = 3;

/** A hub's floor fan-in; below it a node is ordinary however sparse the graph. */
const HUB_MIN_FAN_IN = 4;

/** How far above the median fan-in a hub must sit, so a dense graph declares none. */
const HUB_MEDIAN_FACTOR = 3;

/** Fewer nodes than a poll's timer, tee and fetcher is no slice to band. */
const SLICE_MIN = 3;

/** Past this a part is a sheet of its own, not one slice sharing an egress. */
const SLICE_MAX = 8;

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
 * Pool-adjacent-violators: merge a member into the block above it while
 * their layouts would overlap, and re-centre the merged block on the mean of
 * its members' desired rows. Centring is what makes a fan-out straddle its
 * targets instead of shunting the whole stack downward. A card takes a row; a
 * through wire's placeholder none, since `clearWires` keeps the cards off the
 * wire's whole span.
 *
 * @param {Array<string>}            members Ids sharing the column.
 * @param {Object<string,number>}    row     Desired rows, mutated in place.
 * @param {Object<string,number>}    order   Tie-break rank for equal rows.
 * @param {( id: string ) => number} size    Rows a member occupies.
 */
const spreadColumn = ( members, row, order, size = () => 1 ) => {
	const sorted = [ ...members ].sort(
		( a, b ) => row[ a ] - row[ b ] || order[ a ] - order[ b ]
	);
	const blocks = [];
	// Where a member sits inside its block, and how tall the block is.
	const offsets = ( ids ) => {
		const at = [];
		let sum = 0;
		for ( const m of ids ) {
			at.push( sum );
			sum += size( m );
		}
		return { at, height: sum };
	};
	for ( const id of sorted ) {
		let block = { ids: [ id ], first: row[ id ] };
		// Merge into the previous block while their layouts overlap.
		while ( blocks.length ) {
			const prev = blocks[ blocks.length - 1 ];
			if (
				block.first >=
				prev.first + offsets( prev.ids ).height - 1e-9
			) {
				break;
			}
			const merged = prev.ids.concat( block.ids );
			const { at } = offsets( merged );
			let sum = 0;
			merged.forEach( ( m, k ) => ( sum += row[ m ] - at[ k ] ) );
			block = { ids: merged, first: sum / merged.length };
			blocks.pop();
		}
		blocks.push( block );
	}
	for ( const b of blocks ) {
		const first = snapHalf( b.first );
		const { at } = offsets( b.ids );
		b.ids.forEach( ( m, k ) => ( row[ m ] = first + at[ k ] ) );
	}
};

/**
 * Every half row outward from `from`: `from` itself, then half a row below and
 * above it, a row below and above, and on out, below first.
 *
 * The one search order every row hunt shares, so a caller taking the first row
 * that will do and one taking the best of them break a tie the same way.
 *
 * @param {number} from    The row to search out from.
 * @param {number} [limit] Half-row steps to try each way.
 * @yield {number} Each row in turn.
 */
function* rowsOutward( from, limit = Infinity ) {
	yield from;
	for ( let k = 1; k <= limit; k++ ) {
		yield from + k / 2;
		yield from - k / 2;
	}
}

/**
 * The nearest half row to `from` that `ok` accepts.
 *
 * @param {number}                   from    The row to search out from.
 * @param {( r: number ) => boolean} ok      Whether a row will do.
 * @param {number}                   [limit] Half-row steps to try each way.
 * @return {number|undefined} The row, or undefined when none within the limit does.
 */
const nearestRow = ( from, ok, limit = Infinity ) => {
	for ( const r of rowsOutward( from, limit ) ) {
		if ( ok( r ) ) {
			return r;
		}
	}
	return undefined;
};

/**
 * How many of `ids` sit within a row of the interval `lo`..`hi`, `skip` aside.
 *
 * The ONE "a card holds this row" rule: a card whose centre falls inside the
 * interval is drawn over it, and a caller wanting a yes-or-no reads the count
 * as one. A card with no row yet holds nothing.
 *
 * @param {Array<string>}             ids    Ids sharing one column.
 * @param {Object<string,number>}     row    Rows.
 * @param {number}                    lo     Low edge, exclusive.
 * @param {number}                    hi     High edge, exclusive.
 * @param {( id: string ) => boolean} [skip] Ids to leave out, the asker first.
 * @return {number} How many hold the interval.
 */
const cardsWithin = ( ids, row, lo, hi, skip ) => {
	let k = 0;
	for ( const o of ids ) {
		if ( row[ o ] === undefined || skip?.( o ) ) {
			continue;
		}
		if ( row[ o ] > lo + 1e-9 && row[ o ] < hi - 1e-9 ) {
			k++;
		}
	}
	return k;
};

/** Rows a card keeps between its centre and a wire: half its own height. */
const WIRE_CLEARANCE = 0.5;

/**
 * Move every card off the wires that cross its column.
 *
 * A wire spanning two or more columns is drawn as one cubic from its source
 * to its sink, and over a card's width in a column between it runs nearly
 * the whole way from the one row to the other — so a card whose centre lies
 * inside that span, or within half a card of it, is drawn over. The
 * placeholders put such a card on the right SIDE of its wires; this pass
 * puts it the right DISTANCE from them, nudging it to the nearest half row
 * outside every span crossing its column and clear of every card sharing it.
 *
 * Each sweep reads the spans once, from the rows as they stand, and moves
 * every card off them. A nudged card ends wires of its own, whose spans move
 * with it, so a second sweep catches most of what the first uncovered; an
 * unbounded repeat would not converge, since two columns' wires can push
 * each other's cards down the canvas without end, so two is the budget. What
 * it leaves is a card the nudge of its own neighbour put back on a wire.
 *
 * @param {Array<string>}           ids      The cards to move.
 * @param {Array<[string, string]>} wires    The through wires, as `[from, to]`.
 * @param {Object<string,number>}   col      Columns.
 * @param {Object<string,number>}   row      Rows, mutated in place.
 * @param {Array<string>}           [others] Cards a nudge must also keep clear of; the movers by default.
 */
const clearWires = ( ids, wires, col, row, others = ids ) => {
	if ( ! wires.length ) {
		return;
	}
	/** @type {Object<number,Array<string>>} */
	const byCol = {};
	for ( const id of new Set( [ ...ids, ...others ] ) ) {
		( byCol[ col[ id ] ] ??= [] ).push( id );
	}
	const inside = ( r, list ) =>
		list.some( ( [ lo, hi ] ) => r > lo + 1e-9 && r < hi - 1e-9 );
	for ( let sweep = 0; sweep < 2; sweep++ ) {
		/** @type {Object<number,Array<[number, number]>>} */
		const spans = {};
		for ( const c of Object.keys( byCol ).map( Number ) ) {
			spans[ c ] = wires
				.filter(
					( [ a, b ] ) =>
						Math.min( col[ a ], col[ b ] ) < c &&
						c < Math.max( col[ a ], col[ b ] )
				)
				.map( ( [ a, b ] ) => [
					Math.min( row[ a ], row[ b ] ) - WIRE_CLEARANCE,
					Math.max( row[ a ], row[ b ] ) + WIRE_CLEARANCE,
				] );
		}
		let moved = false;
		for ( const id of ids ) {
			const c = col[ id ];
			const list = spans[ c ];
			if ( ! list.length || ! inside( row[ id ], list ) ) {
				continue;
			}
			// Past the spans' extent plus the column's cards, a row is clear.
			const reach =
				2 *
				( Math.max( ...list.map( ( [ , hi ] ) => hi ) ) -
					Math.min( ...list.map( ( [ lo ] ) => lo ) ) +
					byCol[ c ].length +
					1 );
			const mine = ( o ) => o === id;
			// The nearest clear half row, below before above on a tie.
			const found = nearestRow(
				row[ id ],
				( r ) =>
					! inside( r, list ) &&
					! cardsWithin( byCol[ c ], row, r - 1, r + 1, mine ),
				reach
			);
			if ( found !== undefined ) {
				row[ id ] = found;
				moved = true;
			}
		}
		if ( ! moved ) {
			return;
		}
	}
};

/**
 * Seat each source whose column is a choice last, once every card and wire
 * around it is placed.
 *
 * Only a source whose successors all sit in one column, two or more columns
 * on, has a column to choose; it is laid out without its wires and seated
 * here. Any other is laid out with its band: beside its first successor it has
 * nowhere to go, and a wire to a further column crosses the ones between
 * wherever it sits, so its wires keep their placeholders. Its seat stays left of every node
 * it feeds that is no hub, and right of any hub it feeds from further left, so
 * no wire of its runs backward but one into a hub. The candidates are its
 * current seat and each column in that range, at rows within three of the
 * midpoint of what it feeds. A seat is clear when no card sits within a row of
 * it in its column, no other wire's span covers it, and each of its own wires
 * passes no card in the columns between. A seat costs the rows it sits off
 * that midpoint plus a quarter per column of wire beyond the shortest, and the
 * cheapest clear one wins, the largest fans choosing first. With none clear, a
 * source takes the rightmost column in its range, at the free row its wires
 * cross fewest cards from, or failing that the nearest row no card or wire
 * holds. A source wired to a node outside its block keeps the column its band
 * gave it and chooses only its row: nothing here can see where that wire lands.
 *
 * @param {Array<string>}                sources The sources to seat.
 * @param {Object<string,Array<string>>} next    Each source's real successors.
 * @param {Set<string>}                  hubs    The block's hubs.
 * @param {Array<string>}                cards   Every card a seat must clear.
 * @param {Array<[string, string]>}      wires   Long wires, extended in place by each seated source's own.
 * @param {Object<string,number>}        col     Columns, mutated in place.
 * @param {Object<string,number>}        row     Rows, mutated in place.
 * @param {number}                       [floor] Topmost row a seat may take; a band's own top is fixed by the stack.
 */
const seatSources = (
	sources,
	next,
	hubs,
	cards,
	wires,
	col,
	row,
	floor = -Infinity
) => {
	const rows = cards.map( ( id ) => row[ id ] );
	// Half-row steps that walk a search past every card in the block.
	const reach = 2 * ( Math.max( ...rows ) - Math.min( ...rows ) ) + 8;
	/** @type {Object<number,Array<string>>} */
	const byCol = {};
	for ( const id of cards ) {
		( byCol[ col[ id ] ] ??= [] ).push( id );
	}
	// Each column's long wires, so a seat reads only those that cross it.
	/** @type {Object<number,Array<[string, string]>>} */
	const across = {};
	const lay = ( [ a, b ] ) => {
		const far = Math.max( col[ a ], col[ b ] );
		for ( let c = Math.min( col[ a ], col[ b ] ) + 1; c < far; c++ ) {
			( across[ c ] ??= [] ).push( [ a, b ] );
		}
	};
	wires.forEach( lay );
	const onWire = ( [ a, b ], r ) =>
		r > Math.min( row[ a ], row[ b ] ) - WIRE_CLEARANCE + 1e-9 &&
		r < Math.max( row[ a ], row[ b ] ) + WIRE_CLEARANCE - 1e-9;
	const near = ( id, c, lo, hi ) =>
		cardsWithin( byCol[ c ] ?? [], row, lo, hi, ( o ) => o === id );
	const order = stableSort(
		[ ...sources ].sort( byId ),
		( id ) => -next[ id ].length
	);
	for ( const id of order ) {
		const fed = next[ id ].filter( ( k ) => row[ k ] !== undefined );
		if ( ! fed.length ) {
			continue;
		}
		const want = snapHalf( midMinMax( fed.map( ( k ) => row[ k ] ) ) );
		const free = ( c, r ) =>
			r >= floor - 1e-9 &&
			! near( id, c, r - 1, r + 1 ) &&
			! ( across[ c ] ?? [] ).some( ( w ) => onWire( w, r ) );
		// Cards between the seat and a successor, on that wire.
		const crossings = ( c, r ) =>
			fed.reduce( ( sum, k ) => {
				const lo = Math.min( r, row[ k ] ) - WIRE_CLEARANCE;
				const hi = Math.max( r, row[ k ] ) + WIRE_CLEARANCE;
				const far = Math.max( c, col[ k ] );
				for ( let x = Math.min( c, col[ k ] ) + 1; x < far; x++ ) {
					sum += near( id, x, lo, hi );
				}
				return sum;
			}, 0 );
		const cost = ( c, r ) =>
			Math.abs( r - want ) +
			fed.reduce( ( sum, k ) => sum + Math.abs( col[ k ] - c ) - 1, 0 ) /
				4;
		// Left of all it feeds but a hub, right of a hub it feeds from behind.
		const ahead = fed.filter( ( k ) => ! hubs.has( k ) );
		const last =
			Math.min(
				...( ahead.length ? ahead : fed ).map( ( k ) => col[ k ] )
			) - 1;
		const behind = fed
			.map( ( k ) => col[ k ] )
			.filter( ( c ) => c <= last );
		const first = behind.length ? Math.max( ...behind ) + 1 : 0;
		const stay = fed.length < next[ id ].length || first > last;
		const columns = [];
		for (
			let c = stay ? col[ id ] : first;
			c <= ( stay ? col[ id ] : last );
			c++
		) {
			columns.push( c );
		}
		const candidates = columns.includes( col[ id ] )
			? [ [ col[ id ], row[ id ] ] ]
			: [];
		for ( const c of columns ) {
			for ( let d = -3; d <= 3; d += 0.5 ) {
				candidates.push( [ c, want + d ] );
			}
		}
		let seat = stableSort( candidates, ( [ c, r ] ) => cost( c, r ) ).find(
			( [ c, r ] ) => free( c, r ) && ! crossings( c, r )
		);
		if ( ! seat ) {
			const c = columns[ columns.length - 1 ];
			// @longform Nothing in range is clear, so take the least-crossed
			// free row rather than the nearest: dropping the count altogether
			// ran a source's wire over three cards it could have missed.
			let best;
			let fewest = Infinity;
			for ( const at of rowsOutward( want, reach ) ) {
				if ( ! free( c, at ) ) {
					continue;
				}
				const hit = crossings( c, at );
				if ( hit < fewest ) {
					fewest = hit;
					best = at;
				}
				if ( ! fewest ) {
					break;
				}
			}
			seat = [ c, best ?? nearestRow( want, ( at ) => free( c, at ) ) ];
		}
		byCol[ col[ id ] ] = byCol[ col[ id ] ].filter( ( o ) => o !== id );
		[ col[ id ], row[ id ] ] = seat;
		( byCol[ col[ id ] ] ??= [] ).push( id );
		for ( const k of fed ) {
			if ( Math.abs( col[ k ] - col[ id ] ) >= 2 ) {
				wires.push( [ id, k ] );
				lay( [ id, k ] );
			}
		}
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
 * `layoutBands` calls this on each band, so a band is sized by its own depth
 * rather than the graph's. `succ` and `pred` must already be narrowed to
 * `ids`, and every id has an edge inside the band: a lone node never gets
 * here.
 *
 * @param {Array<string>}                ids   The component's nodes, alphabetical.
 * @param {Object<string,Array<string>>} succ  Successors inside the component.
 * @param {Object<string,Array<string>>} pred  Predecessors inside the component.
 * @param {( id: string ) => boolean}    unfed Whether nothing in the whole graph feeds a node.
 * @return {{col: Object<string,number>, row: Object<string,number>, wires: Array<[string, string]>, deferred: Array<string>}}
 * Grid units, rows normalised so the topmost is 0, the wires spanning two or
 * more columns, and the sources `seatSources` seats last.
 */
const layoutComponent = ( ids, succ, pred, unfed ) => {
	/** @type {Object<string,number>} */
	const declIdx = {};
	ids.forEach( ( id, i ) => ( declIdx[ id ] = i ) );

	const isSource = ( id ) => pred[ id ].length === 0;
	const isSink = ( id ) => succ[ id ].length === 0;

	// Longest path from the sources, and to the sinks — the feasibility band.
	const depth = longestPath( ids, succ, pred );
	const height = longestPath( ids, pred, succ );
	let maxDepth = 0;
	for ( const id of ids ) {
		maxDepth = Math.max( maxDepth, depth[ id ] );
	}

	// @longform Coffman-Graham: sources pinned, interior relaxed, and a sink
	// seated within reach of what feeds it — pinned to the band's far column
	// instead, a shallow sink drags its wire across every card between. The
	// stretch is taste, one column of slack to read as terminal; the rise to a
	// sibling consumer is not, since it keeps a source's successors in one
	// column, which is the seat `seatSources` needs to hold the two level. It
	// aligns on where a sibling SEATS: an interior sibling the relaxation
	// below moves right leaves the sink a column shy of it.
	const SINK_STRETCH = 1;
	const seat = ( id ) =>
		isSink( id )
			? Math.min( maxDepth, depth[ id ] + SINK_STRETCH )
			: depth[ id ];
	// @longform The two furthest seats among each feeder's successors, so a
	// sink reads one number per feeder rather than re-walking every sibling:
	// one feeder of k sinks costs O(k), not O(k²), and no argument list grows
	// with the fan-out. The runner-up covers the sink that IS the furthest.
	/** @type {Object<string,{first: number, firstId: ?string, second: number}>} */
	const furthest = {};
	for ( const p of ids ) {
		let first = -Infinity;
		let firstId = null;
		let second = -Infinity;
		for ( const s of succ[ p ] ) {
			const at = seat( s );
			if ( at > first ) {
				second = first;
				first = at;
				firstId = s;
			} else if ( at > second ) {
				second = at;
			}
		}
		furthest[ p ] = { first, firstId, second };
	}
	/** @type {Object<string,number>} */
	const col = {};
	for ( const id of ids ) {
		if ( isSource( id ) ) {
			col[ id ] = 0;
		} else if ( isSink( id ) ) {
			// Seats read off `depth`, so no column depends on the id order.
			let peer = -Infinity;
			for ( const p of pred[ id ] ) {
				const f = furthest[ p ];
				peer = Math.max( peer, f.firstId === id ? f.second : f.first );
			}
			col[ id ] = Math.min( maxDepth, Math.max( seat( id ), peer ) );
		} else {
			col[ id ] = depth[ id ];
		}
	}
	for ( let pass = 0; pass < 20; pass++ ) {
		for ( const id of ids ) {
			if ( isSource( id ) || isSink( id ) ) {
				continue;
			}
			const lo = depth[ id ];
			const hi = maxDepth - height[ id ];
			if ( lo >= hi ) {
				col[ id ] = lo;
				continue;
			}
			const nb = [ ...pred[ id ], ...succ[ id ] ].map(
				( n ) => col[ n ]
			);
			if ( ! nb.length ) {
				col[ id ] = lo;
				continue;
			}
			const bary = nb.reduce( ( a, b ) => a + b, 0 ) / nb.length;
			col[ id ] = Math.max( lo, Math.min( hi, Math.round( bary ) ) );
		}
	}

	// Seated last: a source feeding one column, two or more columns on.
	const later = new Set(
		ids.filter(
			( id ) =>
				unfed( id ) &&
				new Set( succ[ id ].map( ( n ) => col[ n ] ) ).size === 1 &&
				Math.min( ...succ[ id ].map( ( n ) => col[ n ] ) ) -
					col[ id ] >=
					2
		)
	);

	// @longform Sugiyama's virtual nodes: a wire spanning two or more columns
	// takes a placeholder in every column between, so the ordering sweeps
	// count the crossings it makes with real cards there and the row spread
	// keeps those cards off the rows it runs through. The wire is still drawn
	// straight from source to sink; the placeholders only shape the rows. The
	// wires of a source seated last take none; `seatSources` places it.
	const laid = [ ...ids ];
	/** @type {Array<[string, string]>} */
	const wires = [];
	succ = { ...succ };
	pred = { ...pred };
	for ( const id of ids ) {
		succ[ id ] = [ ...succ[ id ] ];
		pred[ id ] = [ ...pred[ id ] ];
	}
	for ( const from of ids ) {
		for ( const to of [ ...succ[ from ] ] ) {
			if ( col[ to ] - col[ from ] < 2 || later.has( from ) ) {
				continue;
			}
			wires.push( [ from, to ] );
			let tail = from;
			for ( let c = col[ from ] + 1; c < col[ to ]; c++ ) {
				const v = `\0${ from }\u2192${ to }@${ c }`;
				laid.push( v );
				declIdx[ v ] = laid.length - 1;
				col[ v ] = c;
				succ[ v ] = [ to ];
				pred[ v ] = [ tail ];
				succ[ tail ] = succ[ tail ].map( ( x ) =>
					x === to ? v : x
				);
				tail = v;
			}
			pred[ to ] = pred[ to ].map( ( x ) => ( x === from ? tail : x ) );
		}
	}

	// @longform The placeholders lead each column: the sweeps below start
	// from a through wire hugging the top and a card falling clear of it, and
	// the barycenter heuristic settles where it starts when two orders tie.
	const columns = [];
	for ( let c = 0; c <= maxDepth; c++ ) {
		columns[ c ] = [];
	}
	for ( const id of laid.slice( ids.length ).concat( ids ) ) {
		columns[ col[ id ] ].push( id );
	}

	// @longform A card takes a row, a placeholder none: `clearWires` clears
	// the span. A late source still in column 0 takes none either, or a
	// spread would push its neighbours off rows it is about to leave.
	const real = new Set( ids );
	const unseated = new Set( later );
	const footprint = ( id ) =>
		real.has( id ) && ! unseated.has( id ) ? 1 : 0;
	const cards = ( c ) =>
		columns[ c ].filter( ( id ) => real.has( id ) ).length;

	// Anchor = the column of most cards; rows propagate outward from it.
	let anchor = 0;
	for ( let c = 0; c <= maxDepth; c++ ) {
		if ( cards( c ) > cards( anchor ) ) {
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

	// Columns are fixed by now, so a node's spread over them is counted once.
	const spreadOver = ( adj ) => {
		/** @type {Object<string,Object<number,number>>} */
		const over = {};
		for ( const id of laid ) {
			/** @type {Object<number,number>} */
			const k = {};
			for ( const n of adj[ id ] ) {
				k[ col[ n ] ] = ( k[ col[ n ] ] ?? 0 ) + 1;
			}
			over[ id ] = k;
		}
		return over;
	};
	const succOver = spreadOver( succ );
	const predOver = spreadOver( pred );

	// @longform A neighbour serving several of one column keys every one of
	// them alike, so two slices sharing a tee interleave. The neighbour serving
	// fewest of the column is the one that tells them apart, and an all-round
	// tie keys on the whole set, as an unshared graph always did. A through
	// wire's placeholder serves one card by construction, so this prefers a
	// long feed of a node's own over a short one it shares — the sweeps read
	// index space, and the row-median passes below need none of it, keying on
	// rows these sweeps have already pulled apart.
	const leastShared = ( nb, over, c ) => {
		const served = ( n ) => over[ n ][ c ] ?? 0;
		const min = Math.min( ...nb.map( served ) );
		return nb.filter( ( n ) => served( n ) === min );
	};

	// @longform A node is sorted only in its own column, so its key never
	// varies. An index compares only within one column, so a sweep keys on the
	// column it just ordered, reaching further only for a node with no
	// neighbour there.
	const keyedBy = ( adj, over, step ) => {
		/** @type {Object<string,Array<string>>} */
		const keyed = {};
		for ( const id of laid ) {
			const near = adj[ id ].filter(
				( n ) => col[ n ] === col[ id ] + step
			);
			keyed[ id ] = leastShared(
				near.length ? near : adj[ id ],
				over,
				col[ id ]
			);
		}
		return keyed;
	};
	const predKeyed = keyedBy( pred, succOver, -1 );
	const succKeyed = keyedBy( succ, predOver, 1 );
	for ( let s = 0; s < 12; s++ ) {
		for ( let c = 1; c <= maxDepth; c++ ) {
			columns[ c ] = stableSort( columns[ c ], ( id ) =>
				baryIndex( id, predKeyed[ id ] )
			);
			reindex();
		}
		for ( let c = maxDepth - 1; c >= 0; c-- ) {
			columns[ c ] = stableSort( columns[ c ], ( id ) =>
				baryIndex( id, succKeyed[ id ] )
			);
			reindex();
		}
	}
	// @longform A late source sweeps from column 0, then waits beside what it
	// feeds, so the row spread straddles it with a card fanning to the same
	// column. Only left of the anchor: right of it, rows seat from the left,
	// and re-spreading a column once the next has centred on it bends chains.
	for ( const id of later ) {
		const at = col[ succ[ id ][ 0 ] ] - 1;
		if ( at < anchor ) {
			columns[ col[ id ] ] = columns[ col[ id ] ].filter(
				( x ) => x !== id
			);
			col[ id ] = at;
			columns[ at ].push( id );
			unseated.delete( id );
		}
	}
	reindex();

	// Spread what a sweep seated; a card with no row yet has none to spread.
	const spreadSet = ( members, r ) =>
		spreadColumn(
			members.filter( ( id ) => r[ id ] !== undefined ),
			r,
			declIdx,
			footprint
		);

	// Stack the anchor; spring the rest to neighbour midpoints.
	const assignRows = ( spread = false ) => {
		/** @type {Object<string,number>} */
		const r = {};
		let stacked = 0;
		for ( const id of columns[ anchor ] ) {
			r[ id ] = stacked;
			stacked += footprint( id );
		}
		for ( let c = anchor + 1; c <= maxDepth; c++ ) {
			for ( const id of columns[ c ] ) {
				const nb = pred[ id ].filter( ( p ) => r[ p ] !== undefined );
				if ( nb.length ) {
					r[ id ] = midMinMax( nb.map( ( p ) => r[ p ] ) );
				}
			}
			if ( spread ) {
				spreadSet( columns[ c ], r );
			}
		}
		for ( let c = anchor - 1; c >= 0; c-- ) {
			for ( const id of columns[ c ] ) {
				const nb = succ[ id ].filter( ( k ) => r[ k ] !== undefined );
				if ( nb.length ) {
					r[ id ] = midMinMax( nb.map( ( k ) => r[ k ] ) );
				}
			}
			if ( spread ) {
				spreadSet( columns[ c ], r );
			}
		}
		// @longform A card fed only from left of the anchor had no feeder row
		// when the forward sweep reached it; it seats from them now, on the
		// nearest row its column leaves free, moving no card already placed.
		for ( let c = anchor + 1; c <= maxDepth; c++ ) {
			for ( const id of columns[ c ] ) {
				const nb = pred[ id ].filter( ( p ) => r[ p ] !== undefined );
				if ( r[ id ] !== undefined || ! nb.length ) {
					continue;
				}
				const want = snapHalf( midMinMax( nb.map( ( p ) => r[ p ] ) ) );
				const skip = ( o ) => o === id || ! footprint( o );
				r[ id ] = nearestRow(
					want,
					( at ) =>
						! cardsWithin( columns[ c ], r, at - 1, at + 1, skip )
				);
			}
		}
		// @longform A component that never reaches the anchor column is
		// seeded by neither sweep, and a card left without a row renders
		// off-graph, silently. Stack the leftovers under their own column.
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
	// @longform Rows derive from the anchor's order and that order from the
	// rows, so the pass above sorted on rows the sweep order laid. Refine until
	// it holds. The rows now carry the chosen orientation, so a refinement
	// sorts ascending: sorting descending again would flip the column back.
	for ( let i = 0; i < 6; i++ ) {
		const ord = buildOrder( 1 );
		if ( ord.every( ( id, k ) => id === columns[ anchor ][ k ] ) ) {
			break;
		}
		columns[ anchor ] = ord;
		row = assignRows();
	}

	// @longform Settle the other columns by neighbour-row median. The last
	// pass spreads same-column overlaps symmetrically (PAV) so a fan-out
	// straddles, each column before the next one out reads it: a chain
	// centred on a card the spread then moved would bend half a row.
	const passes = 6;
	for ( let it = 0; it < passes; it++ ) {
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
		row = assignRows( it === passes - 1 );
	}

	// The placeholders have done their work; only the cards leave here.
	for ( const id of laid ) {
		if ( ! real.has( id ) ) {
			delete col[ id ];
			delete row[ id ];
		}
	}
	const stays = ids.filter( ( id ) => ! unseated.has( id ) );
	clearWires( stays, wires, col, row );
	normalizeRows( ids, row );
	return { col, row, wires, deferred: [ ...later ] };
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
	// A node whose served rows lie in another block waits for the rest.
	const later = [];
	for ( const id of [ ...serving, ...bridges ] ) {
		col[ id ] = baseCol + depth[ id ];
		const served = rowsOf(
			[ ...pred[ id ], ...succ[ id ] ].filter(
				( n ) => ! inside.has( n )
			)
		);
		if ( served.length ) {
			row[ id ] = snapHalf( midMinMax( served ) );
		} else {
			later.push( id );
		}
	}
	for ( const id of later ) {
		const rows = rowsOf( [ ...pred[ id ], ...succ[ id ] ] );
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
 * The blocks a graph lays out as: one per hub group, one per hub-less band.
 *
 * A band is one weakly-connected component of the graph minus its backbone.
 * Each band picks the hub it is wired to that has the fewest feeder bands —
 * the publication's own hub over the fleet-wide one — and the bands that
 * picked one hub form its group, with the hub beside them. A hub no band
 * picked, because every band wired to it had a closer hub, attaches to the
 * group holding most of its feeders; a bridge, whose every neighbour is a
 * hub, follows the first of them. A band wired to no hub is a block of its own.
 * Blocks a wire joins are then one block: each is packed on its own, so a wire
 * crossing between two of them has nothing holding its direction.
 *
 * @param {Array<string>}                ids  Every node, alphabetical.
 * @param {Object<string,Array<string>>} succ Successors.
 * @param {Object<string,Array<string>>} pred Predecessors.
 * @param {Set<string>}                  hubs The hub ids.
 * @return {Array<{key: string, bands: Array<Array<string>>, hubs: Array<string>}>}
 * The blocks, each with its bands in alphabetical order and its backbone ids.
 */
const blocksOf = ( ids, succ, pred, hubs ) => {
	const backbone = backboneOf( hubs, ids, succ, pred );
	const inside = new Set( backbone );
	const bands = componentsOf(
		ids.filter( ( id ) => ! inside.has( id ) ),
		succ,
		pred
	);

	// The hubs each band is wired to, and how many bands each hub serves.
	const wired = bands.map( ( band ) => {
		const set = new Set();
		for ( const id of band ) {
			for ( const n of [ ...succ[ id ], ...pred[ id ] ] ) {
				if ( hubs.has( n ) ) {
					set.add( n );
				}
			}
		}
		return [ ...set ].sort( byId );
	} );
	/** @type {Object<string,number>} */
	const feeders = {};
	for ( const set of wired ) {
		for ( const h of set ) {
			feeders[ h ] = ( feeders[ h ] ?? 0 ) + 1;
		}
	}

	/** @type {Object<string,{key: string, bands: Array<Array<string>>, hubs: Array<string>}>} */
	const blocks = {};
	const block = ( key ) => ( blocks[ key ] ??= { key, bands: [], hubs: [] } );
	/** @type {Object<string,string>} */
	const groupOfHub = {};
	bands.forEach( ( band, i ) => {
		const set = wired[ i ];
		if ( ! set.length ) {
			block( band[ 0 ] ).bands.push( band );
			return;
		}
		const home = stableSort( set, ( h ) => feeders[ h ] )[ 0 ];
		block( home ).bands.push( band );
		groupOfHub[ home ] = home;
	} );
	// A hub nobody picked goes where most of its feeder bands went.
	for ( const h of backbone ) {
		if ( groupOfHub[ h ] || ! hubs.has( h ) ) {
			continue;
		}
		/** @type {Object<string,number>} */
		const votes = {};
		bands.forEach( ( band, i ) => {
			if ( wired[ i ].includes( h ) ) {
				const home = stableSort(
					wired[ i ],
					( x ) => feeders[ x ]
				)[ 0 ];
				votes[ home ] = ( votes[ home ] ?? 0 ) + 1;
			}
		} );
		const homes = stableSort(
			Object.keys( votes ).sort( byId ),
			( k ) => -votes[ k ]
		);
		if ( homes.length ) {
			groupOfHub[ h ] = homes[ 0 ];
		}
	}
	// A bridge or a hub fed only by hubs follows its first settled neighbour.
	for ( let settled = true; settled;  ) {
		settled = false;
		const before = { ...groupOfHub };
		for ( const id of backbone ) {
			if ( before[ id ] ) {
				continue;
			}
			const near = [ ...pred[ id ], ...succ[ id ] ]
				.filter( ( n ) => inside.has( n ) && before[ n ] )
				.sort( byId );
			if ( near.length ) {
				groupOfHub[ id ] = before[ near[ 0 ] ];
				settled = true;
			}
		}
	}
	// Each connected run wired to nothing settled is a block, keyed by hub.
	const left = backbone.filter( ( id ) => ! groupOfHub[ id ] );
	for ( const run of componentsOf( left, succ, pred ) ) {
		const key = run.find( ( id ) => hubs.has( id ) ) ?? run[ 0 ];
		for ( const id of run ) {
			groupOfHub[ id ] = key;
		}
	}
	for ( const id of backbone ) {
		block( groupOfHub[ id ] ).hubs.push( id );
	}
	// One block, then: the grouping above only orders the bands it stacks.
	/** @type {Object<string,string>} */
	const keyOf = {};
	for ( const b of Object.values( blocks ) ) {
		for ( const band of b.bands ) {
			for ( const id of band ) {
				keyOf[ id ] = b.key;
			}
		}
		for ( const id of b.hubs ) {
			keyOf[ id ] = b.key;
		}
	}
	/** @type {Object<string,Array<string>>} */
	const joined = {};
	for ( const k of Object.keys( blocks ) ) {
		joined[ k ] = [];
	}
	for ( const id of ids ) {
		for ( const n of succ[ id ] ) {
			if ( keyOf[ id ] && keyOf[ n ] && keyOf[ id ] !== keyOf[ n ] ) {
				joined[ keyOf[ id ] ].push( keyOf[ n ] );
				joined[ keyOf[ n ] ].push( keyOf[ id ] );
			}
		}
	}
	/** @type {Object<string,string>} */
	const home = {};
	for ( const run of componentsOf(
		Object.keys( blocks ).sort( byId ),
		joined,
		joined
	) ) {
		for ( const k of run ) {
			home[ k ] = run[ 0 ];
		}
	}
	/** @type {Object<string,{key: string, bands: Array<Array<string>>, hubs: Array<string>}>} */
	const merged = {};
	for ( const b of Object.values( blocks ) ) {
		const into = ( merged[ home[ b.key ] ] ??= {
			key: home[ b.key ],
			bands: [],
			hubs: [],
		} );
		into.bands.push( ...b.bands );
		into.hubs.push( ...b.hubs );
	}
	for ( const b of Object.values( merged ) ) {
		b.hubs.sort( byId );
	}
	return Object.values( merged );
};

/**
 * Widen one column's row interval to take in another.
 *
 * @param {Object<number,[number, number]>} spans Column to its top and bottom rows, mutated.
 * @param {number}                          c     The column.
 * @param {number}                          lo    Top row to take in.
 * @param {number}                          hi    Bottom row to take in.
 */
const widen = ( spans, c, lo, hi ) => {
	const was = spans[ c ];
	spans[ c ] = was
		? [ Math.min( was[ 0 ], lo ), Math.max( was[ 1 ], hi ) ]
		: [ lo, hi ];
};

/**
 * Widen every column strictly between a wire's two ends to take in the rows
 * the wire spans.
 *
 * @param {Object<number,[number, number]>} spans Column to its top and bottom rows, mutated.
 * @param {number}                          c1    One end's column.
 * @param {number}                          r1    That end's row.
 * @param {number}                          c2    The other end's column.
 * @param {number}                          r2    That end's row.
 */
const coverWire = ( spans, c1, r1, c2, r2 ) => {
	for ( let c = Math.min( c1, c2 ) + 1; c < Math.max( c1, c2 ); c++ ) {
		widen( spans, c, Math.min( r1, r2 ), Math.max( r1, r2 ) );
	}
};

/**
 * Rows a stack fills before the next opens: the height of a square holding
 * every block, each with its gap column.
 *
 * @param {Array<{width: number, height: number}>} blocks The blocks, in grid units.
 * @return {number} Rows.
 */
const stackRows = ( blocks ) => {
	let area = 0;
	for ( const b of blocks ) {
		area += ( b.width + 1 ) * b.height;
	}
	return Math.ceil( Math.sqrt( ( area * X_STEP ) / Y_STEP ) );
};

/**
 * Lay a graph out as packed blocks: each hub group's bands stacked with the
 * hub in the column right after them, and the blocks filling side-by-side
 * stacks toward a canvas about as wide as it is tall.
 *
 * Each band is laid out on its own, so its width is its own depth, and offset
 * one row below the band above it — the row step IS the gap, since a card is
 * shorter than `Y_STEP`. The blocks pack widest first, so a narrow block never
 * sits under empty columns, and alphabetically among equals; a stack takes
 * blocks until it reaches the square's height, then the next opens one gap
 * column to the right. A block past the height waits until every other block
 * is down, then looks for room above or below what the columns it would cover
 * hold, and stacks only when none fits — every wire of its own lands inside
 * it, so the room it takes crosses nothing. A small graph fills one stack,
 * which is the old single column of bands.
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

	const unfed = ( id ) => ! pred[ id ].length;
	const blocks = blocksOf( ids, succ, pred, hubs ).map( ( b ) => {
		/** @type {Object<string,number>} */
		const bc = {};
		/** @type {Object<string,number>} */
		const br = {};
		const hubSet = new Set( b.hubs );
		// @longform A band a hub feeds continues the chain past it, so it
		// goes right of the hubs; every other band feeds them from the left.
		const fed = ( members ) =>
			members.some( ( id ) =>
				pred[ id ].some( ( n ) => hubSet.has( n ) )
			);
		const feeders = b.bands.filter( ( m ) => ! fed( m ) );
		const consumers = b.bands.filter( fed );

		/** @type {Array<[string, string]>} */
		const bandWires = [];
		/** @type {Array<string>} */
		const deferred = [];
		// Stack bands from `atCol`; returns the stack's width and height.
		const stack = ( bands, atCol ) => {
			let next = 0;
			let width = 0;
			for ( const members of bands ) {
				const inBand = restrictAdjacency( members, succ );
				const band =
					members.length === 1
						? {
								col: { [ members[ 0 ] ]: 0 },
								row: { [ members[ 0 ] ]: 0 },
								wires: [],
								deferred: unfed( members[ 0 ] ) ? members : [],
						  }
						: layoutComponent(
								members,
								inBand,
								restrictAdjacency( members, pred ),
								unfed
						  );
				// @longform A late source seats inside its band before the
				// band below stacks against it: laid out with no footprint,
				// the row its band left it was the one row between two
				// packed bands, and where a flat wire held that row the
				// block-level seat walked past the next band. Seated here,
				// the band's height covers it, and it grows downward only:
				// the band's top is the row the stack gave it. The wires it
				// lays stay out of the band's, which the block-level pass
				// reads before it reseats the source against every wire the
				// block holds, or the source's own wire would refuse it.
				if ( band.deferred.length ) {
					seatSources(
						band.deferred,
						inBand,
						hubSet,
						members,
						[ ...band.wires ],
						band.col,
						band.row,
						0
					);
				}
				let height = 0;
				for ( const id of members ) {
					bc[ id ] = atCol + band.col[ id ];
					br[ id ] = band.row[ id ] + next;
					width = Math.max( width, band.col[ id ] + 1 );
					height = Math.max( height, band.row[ id ] );
				}
				bandWires.push( ...band.wires );
				deferred.push( ...band.deferred );
				next += height + 1;
			}
			return { width, height: next };
		};

		const left = stack( feeders, 0 );
		placeBackbone( b.hubs, succ, pred, left.width, bc, br );
		let hubRight = left.width;
		for ( const h of b.hubs ) {
			hubRight = Math.max( hubRight, bc[ h ] + 1 );
		}
		// The consumers hang level with the hubs that feed them.
		const right = stack( consumers, hubRight );
		if ( consumers.length ) {
			const hubRows = [];
			for ( const members of consumers ) {
				for ( const id of members ) {
					for ( const n of pred[ id ] ) {
						if ( hubSet.has( n ) ) {
							hubRows.push( br[ n ] );
						}
					}
				}
			}
			const shift = snapHalf(
				midMinMax( hubRows ) - ( right.height - 1 ) / 2
			);
			for ( const members of consumers ) {
				for ( const id of members ) {
					br[ id ] += shift;
				}
			}
		}
		// @longform A wire to a hub is no wire inside a band, so the band's
		// own pass never saw it: a chain's head feeding the hub directly ran
		// its wire along the chain's row, through the chain. Each band clears
		// its cards off its own hub wires here. Only its own: a hub's fan-in
		// crosses every band between, and clearing those would scatter each
		// band's sinks away from their sources for wires that are not theirs.
		// The backbone clears off every hub wire: a bridge seated on its
		// hub's row sits in the path of everything feeding that hub. A
		// source seated last leaves its hub wire out, placed clear of all.
		const seatedLast = new Set( deferred );
		/** @type {Array<[string, string]>} */
		const hubWires = [];
		for ( const id of Object.keys( bc ) ) {
			for ( const to of succ[ id ] ) {
				if (
					! seatedLast.has( id ) &&
					( hubSet.has( to ) || hubSet.has( id ) ) &&
					bc[ to ] !== undefined &&
					Math.abs( bc[ to ] - bc[ id ] ) >= 2
				) {
					hubWires.push( [ id, to ] );
				}
			}
		}
		const all = Object.keys( bc );
		// Farthest from the hubs first, so each half cascades outward.
		const hubMid = b.hubs.length
			? midMinMax( b.hubs.map( ( h ) => br[ h ] ) )
			: 0;
		const farFirst = stableSort(
			b.bands,
			( m ) =>
				-Math.abs( midMinMax( m.map( ( id ) => br[ id ] ) ) - hubMid )
		);
		for ( const members of farFirst ) {
			const own = new Set( members );
			clearWires(
				members,
				hubWires.filter(
					( [ from, to ] ) => own.has( from ) || own.has( to )
				),
				bc,
				br,
				all
			);
		}
		clearWires( b.hubs, hubWires, bc, br, all );
		// Last, once every card and wire a seat must clear is placed.
		seatSources(
			deferred,
			succ,
			hubSet,
			all,
			[ ...bandWires, ...hubWires ],
			bc,
			br
		);
		normalizeRows( Object.keys( br ), br );
		let widest = 0;
		let bottom = 0;
		for ( const id of Object.keys( bc ) ) {
			widest = Math.max( widest, bc[ id ] );
			bottom = Math.max( bottom, br[ id ] );
		}
		/** @type {Object<number,[number, number]>} */
		const hull = {};
		for ( const id of Object.keys( bc ) ) {
			widen( hull, bc[ id ], br[ id ], br[ id ] );
			for ( const to of succ[ id ] ) {
				if ( bc[ to ] !== undefined ) {
					coverWire( hull, bc[ id ], br[ id ], bc[ to ], br[ to ] );
				}
			}
		}
		return {
			...b,
			col: bc,
			row: br,
			hull,
			width: widest + 1,
			height: bottom + 1,
		};
	} );

	const order = stableSort(
		[ ...blocks ].sort( ( a, b ) => byId( a.key, b.key ) ),
		( b ) => -b.width
	);
	const limit = stackRows( blocks );
	// Each canvas column's rows, top to bottom, that cards and wires take.
	/** @type {Object<number,[number, number]>} */
	const taken = {};
	const filled = new Set();
	let rows = 0;
	const place = ( b, atCol, atRow ) => {
		for ( const id of Object.keys( b.col ) ) {
			col[ id ] = atCol + b.col[ id ];
			row[ id ] = atRow + b.row[ id ];
			filled.add( col[ id ] );
		}
		for ( const [ c, [ lo, hi ] ] of Object.entries( b.hull ) ) {
			widen( taken, atCol + Number( c ), lo + atRow, hi + atRow );
		}
		// A wire to a block already down crosses the columns between.
		for ( const id of Object.keys( b.col ) ) {
			for ( const n of [ ...succ[ id ], ...pred[ id ] ] ) {
				if ( b.col[ n ] !== undefined || col[ n ] === undefined ) {
					continue;
				}
				coverWire( taken, col[ id ], row[ id ], col[ n ], row[ n ] );
			}
		}
		rows = Math.max( rows, atRow + b.height );
	};
	// The first row clear below what a block's columns hold at `atCol`.
	const clearBelow = ( b, atCol ) =>
		Math.max(
			-Infinity,
			...Object.entries( b.hull )
				.filter( ( [ c ] ) => taken[ atCol + Number( c ) ] )
				.map(
					( [ c, h ] ) =>
						taken[ atCol + Number( c ) ][ 1 ] + 1 - h[ 0 ]
				)
		);
	// @longform Room for a block inside the canvas drawn so far: a row one
	// clear of what each column it covers holds, above it or below, in the
	// leftmost columns that fit, nearest the canvas's middle row. Only
	// columns already holding cards qualify, so a block never lands in the
	// gap column between two stacks.
	const roomFor = ( b, width ) => {
		const mid = ( rows - 1 ) / 2;
		for ( let at = 0; at + b.width <= width; at++ ) {
			const pairs = Object.entries( b.hull ).map( ( [ c, h ] ) => [
				filled.has( at + Number( c ) ) && taken[ at + Number( c ) ],
				h,
			] );
			if ( pairs.some( ( [ t ] ) => ! t ) ) {
				continue;
			}
			const above = Math.min(
				...pairs.map( ( [ t, h ] ) => t[ 0 ] - 1 - h[ 1 ] )
			);
			const below = Math.max(
				...pairs.map( ( [ t, h ] ) => t[ 1 ] + 1 - h[ 0 ] )
			);
			const fits = [ above, below ].filter(
				( r ) => r >= 0 && r + b.height <= rows
			);
			if ( fits.length ) {
				const off = ( r ) => Math.abs( r + ( b.height - 1 ) / 2 - mid );
				return { col: at, row: stableSort( fits, off )[ 0 ] };
			}
		}
		return null;
	};
	let stackCol = 0;
	let stackWidth = 0;
	let stackRow = 0;
	const stackOn = ( b ) => {
		let at = Math.max( stackRow, clearBelow( b, stackCol ) );
		if ( stackRow > 0 && at + b.height > limit ) {
			stackCol += stackWidth + 1;
			stackWidth = 0;
			at = 0;
		}
		place( b, stackCol, at );
		stackWidth = Math.max( stackWidth, b.width );
		stackRow = at + b.height;
	};
	// A block's every wire lands inside it, so size alone decides who waits.
	const later = [];
	for ( const b of order ) {
		if ( stackRow > 0 && stackRow + b.height > limit ) {
			later.push( b );
			continue;
		}
		stackOn( b );
	}
	for ( const b of later ) {
		const room = roomFor( b, stackCol + stackWidth );
		if ( room ) {
			place( b, room.col, room.row );
		} else {
			stackOn( b );
		}
	}

	normalizeRows( ids, row );
	return { col, row };
};

/**
 * Lay a parsed graph out on the grid, as the bands described at the top.
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
	const seen = new Set();
	for ( const e of edges ) {
		// Skip a dangling edge, and a wire declared twice (it weighs twice).
		const key = `${ e.from }\u2192${ e.to }`;
		if (
			! nodeSet.has( e.from ) ||
			! nodeSet.has( e.to ) ||
			seen.has( key )
		) {
			continue;
		}
		seen.add( key );
		succ[ e.from ].push( e.to );
		pred[ e.to ].push( e.from );
	}

	const hubs = hubIds( ids, pred );
	// @longform A pure sink several SLICES drain is the egress a wide fan-in
	// makes, and the count alone misses it: three slices sit under the cut, so
	// one band held all three and the sweep against the flow keyed every feeder
	// alike. It costs the corpus wires — 30,452 to 31,273 through cards — and
	// buys a slice reading as a slice on every console page. Walk out from each
	// feeder rather than parting the whole graph: a part over SLICE_MAX is
	// disqualified anyway, so the walk abandons there.
	const partFrom = ( from, sink ) => {
		const part = new Set( [ from ] );
		const queue = [ from ];
		while ( queue.length ) {
			const at = queue.pop();
			if ( hubs.has( at ) ) {
				return null; // Another hub packs this part into its own block.
			}
			for ( const n of [ ...succ[ at ], ...pred[ at ] ] ) {
				if ( n === sink || part.has( n ) ) {
					continue;
				}
				if ( part.size >= SLICE_MAX ) {
					return null; // A sheet of its own, not a slice.
				}
				part.add( n );
				queue.push( n );
			}
		}
		return part;
	};
	for ( const id of ids ) {
		if ( succ[ id ].length || pred[ id ].length < 2 || hubs.has( id ) ) {
			continue;
		}
		// @longform A part another hub serves, or one too big to be a slice,
		// disqualifies the sink outright — promoting it anyway packs that part
		// into the other block and bends its wire backward. A part too SMALL
		// is nobody else's business: one lone node wired to the egress would
		// otherwise collapse every slice on the page back into one band.
		const claimed = new Set();
		let slices = 0;
		let refused = false;
		for ( const p of pred[ id ] ) {
			if ( claimed.has( p ) ) {
				continue;
			}
			const part = partFrom( p, id );
			if ( ! part ) {
				refused = true;
				break;
			}
			for ( const n of part ) {
				claimed.add( n );
			}
			if ( part.size >= SLICE_MIN ) {
				slices++;
			}
		}
		if ( ! refused && slices >= 2 ) {
			hubs.add( id );
		}
	}
	const { col, row } = layoutBands( ids, succ, pred, hubs );
	const wiresTo = ( nb, c ) => nb.filter( ( n ) => col[ n ] === c ).length;
	const opened = new Set();
	for ( const id of ids ) {
		const c = col[ id ];
		if ( wiresTo( pred[ id ], c - 1 ) >= GAP_MIN_WIRES ) {
			opened.add( c );
		}
		if ( wiresTo( succ[ id ], c + 1 ) >= GAP_MIN_WIRES ) {
			opened.add( c + 1 );
		}
	}
	const gaps = [ ...opened ];
	const xOf = ( c ) =>
		X_PAD + ( c + gaps.filter( ( g ) => g <= c ).length / 2 ) * X_STEP;

	const positioned = nodes.map( ( n ) => ( {
		...n,
		position: {
			x: xOf( col[ n.id ] ?? 0 ),
			y: Y_PAD + ( row[ n.id ] ?? 0 ) * Y_STEP,
		},
	} ) );

	return { nodes: positioned, edges };
}
