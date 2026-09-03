/**
 * Include boundaries for the topology console canvas: member rects in, one
 * soft closed region out.
 *
 * A TSL `include` contributes a set of nodes, and the canvas draws a region
 * around each set so composition is visible without rearranging the graph.
 * The region is the convex hull of every member rect's padded corners, joined
 * with quadratic curves so it reads as a blob rather than a polygon. Hulls
 * overlap freely: a node that two includes both provide sits in the
 * intersection instead of being assigned to one of them.
 *
 * Convex over-approximates, so a non-member card standing between two members
 * falls inside the outline. Nothing reads the geometry as a membership test —
 * `SchematicCanvas` hovers, selects and drags a hull by its `nodeIds` — and
 * the path doubles as the hit region, which is what the padding leaves
 * grabbable between cards.
 */

/**
 * A member node's box on the canvas, in layout units.
 *
 * @typedef {{x:number,y:number,w:number,h:number}} Rect
 */

/**
 * How far back along each edge `roundedPath` trims a corner, in canvas units.
 *
 * The trim is capped at half an edge, so two corners sharing a short edge meet
 * at its midpoint instead of overrunning each other into a crossing path.
 */
const ROUND = 18;

/**
 * Convex hull of a point set, by Andrew's monotone chain.
 *
 * Sorting by x then y and sweeping the sorted points twice yields the lower
 * and upper chains; each sweep drops its last point, so concatenating the two
 * repeats no vertex. Popping on a non-positive cross product also discards
 * collinear and duplicate points, which is what keeps `roundedPath` off a
 * zero-length edge.
 *
 * @param {Array<[number,number]>} points Candidate points, in any order.
 * @return {Array<[number,number]>} Hull vertices in winding order, the first
 *                                  not repeated at the end. Fewer than three
 *                                  points come back merely sorted, for the
 *                                  caller to reject as degenerate.
 */
function hull( points ) {
	const pts = [ ...points ].sort(
		( a, b ) => a[ 0 ] - b[ 0 ] || a[ 1 ] - b[ 1 ]
	);
	if ( pts.length < 3 ) {
		return pts;
	}
	const cross = ( o, a, b ) =>
		( a[ 0 ] - o[ 0 ] ) * ( b[ 1 ] - o[ 1 ] ) -
		( a[ 1 ] - o[ 1 ] ) * ( b[ 0 ] - o[ 0 ] );
	const build = ( source ) => {
		const out = [];
		for ( const p of source ) {
			while (
				out.length >= 2 &&
				cross( out[ out.length - 2 ], out[ out.length - 1 ], p ) <= 0
			) {
				out.pop();
			}
			out.push( p );
		}
		out.pop();
		return out;
	};
	return [ ...build( pts ), ...build( [ ...pts ].reverse() ) ];
}

/**
 * The point a fraction `t` of the way from `a` to `b`.
 *
 * @param {[number,number]} a Start point, returned at `t` of 0.
 * @param {[number,number]} b End point, returned at `t` of 1.
 * @param {number}          t Fraction along the segment.
 * @return {[number,number]} The interpolated point.
 */
const lerp = ( a, b, t ) => [
	a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t,
	a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t,
];

/**
 * Shoelace area of a polygon, as a magnitude.
 *
 * The sign carries only the winding direction, and the caller ranks hulls by
 * size alone.
 *
 * @param {Array<[number,number]>} poly Vertices in order, unclosed.
 * @return {number} The enclosed area, in square canvas units.
 */
function polygonArea( poly ) {
	let sum = 0;
	for ( let i = 0; i < poly.length; i++ ) {
		const [ x1, y1 ] = poly[ i ];
		const [ x2, y2 ] = poly[ ( i + 1 ) % poly.length ];
		sum += x1 * y2 - x2 * y1;
	}
	return Math.abs( sum ) / 2;
}

/**
 * Geometry for one include's members: the rounded path, and the area that
 * orders it against the siblings it overlaps.
 *
 * The area is the polygon's, not its bounding box's. Two members far apart
 * span a large box around a thin hull, so a box-based tiebreak would call that
 * hull the biggest and paint it first, burying it. Equal-depth siblings paint
 * biggest-first, which leaves the smaller region on top and clickable.
 *
 * @param {Rect[]} rects Member node boxes.
 * @param {number} pad   Padding added around each rect before hulling; the
 *                       canvas takes the default.
 * @return {{d:string,area:number}} The SVG path data and the hull's area.
 *                                  `d` is empty when fewer than three points
 *                                  survive, and the canvas drops those hulls.
 */
export function hullGeometry( rects, pad = 24 ) {
	if ( ! rects || ! rects.length ) {
		return { d: '', area: 0 };
	}
	/** @type {Array<[number,number]>} */
	const points = [];
	for ( const r of rects ) {
		points.push(
			[ r.x - pad, r.y - pad ],
			[ r.x + r.w + pad, r.y - pad ],
			[ r.x + r.w + pad, r.y + r.h + pad ],
			[ r.x - pad, r.y + r.h + pad ]
		);
	}
	const poly = hull( points );
	if ( poly.length < 3 ) {
		return { d: '', area: 0 };
	}
	return { d: roundedPath( poly ), area: polygonArea( poly ) };
}

/**
 * The polygon as SVG path data, every corner rounded.
 *
 * A corner contributes a line to the trim point `ROUND` back along the
 * incoming edge, then a quadratic curve to the matching trim point on the
 * outgoing edge, with the corner itself as the control point. A quadratic
 * needs neither a radius nor sweep flags, and the curve follows however sharp
 * or shallow the join turns out to be.
 *
 * @param {Array<[number,number]>} poly Hull vertices in order, unclosed.
 * @return {string} Path data, closed with `Z`.
 */
function roundedPath( poly ) {
	const parts = [];
	for ( let i = 0; i < poly.length; i++ ) {
		const prev = poly[ ( i - 1 + poly.length ) % poly.length ];
		const cur = poly[ i ];
		const next = poly[ ( i + 1 ) % poly.length ];
		const dPrev = Math.hypot( cur[ 0 ] - prev[ 0 ], cur[ 1 ] - prev[ 1 ] );
		const dNext = Math.hypot( next[ 0 ] - cur[ 0 ], next[ 1 ] - cur[ 1 ] );
		const a = lerp(
			cur,
			prev,
			Math.min( 0.5, ROUND / Math.max( dPrev, 1 ) )
		);
		const b = lerp(
			cur,
			next,
			Math.min( 0.5, ROUND / Math.max( dNext, 1 ) )
		);
		parts.push(
			0 === i ? `M ${ a[ 0 ] },${ a[ 1 ] }` : `L ${ a[ 0 ] },${ a[ 1 ] }`
		);
		parts.push( `Q ${ cur[ 0 ] },${ cur[ 1 ] } ${ b[ 0 ] },${ b[ 1 ] }` );
	}
	parts.push( 'Z' );
	return parts.join( ' ' );
}
