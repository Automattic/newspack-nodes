/**
 * hullGeometry — a soft closed region hugging a set of node rects.
 *
 * Convex hull (Andrew's monotone chain) of every rect's padded corners, drawn
 * with quadratic-rounded joins so the region reads as a blob, not a polygon.
 * Hulls overlap freely — a node shared by two includes sits in the intersection.
 */

const ROUND = 18;

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

const lerp = ( a, b, t ) => [
	a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t,
	a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t,
];

// Shoelace area of a convex polygon (absolute).
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
 * Hull geometry for one rect set: the rounded SVG path plus the convex
 * polygon's TRUE area (a bbox over-counts badly when members are spread
 * wide) — the sibling-overlap paint-order tiebreak.
 *
 * @param {Array}  rects `{x,y,w,h}` member rects.
 * @param {number} pad   Hull padding around each rect.
 * @return {{d: string, area: number}} Geometry, `d: ''` when degenerate.
 */
export function hullGeometry( rects, pad = 24 ) {
	if ( ! rects || ! rects.length ) {
		return { d: '', area: 0 };
	}
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
