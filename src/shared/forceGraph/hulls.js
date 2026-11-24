/**
 * The hull a branch draws: the convex hull of its leaves' rects, pushed out
 * by a padding.
 */

import { polygonCentroid, polygonHull } from 'd3';

/** Pixels a hull stands clear of its leaves. */
export const HULL_PADDING = 50;

/**
 * Convex hull of the leaves' rects, with padding. A hull needs a leaf: the
 * model draws a branch only for a group with a node beneath it.
 *
 * @param {import('./model').Leaf[]} leaves  At least one leaf the hull holds.
 * @param {number}                   padding Pixels to push each point out.
 * @return {[number, number][]} Hull points, pushed out from the centroid.
 */
export const hullPoints = ( leaves, padding = HULL_PADDING ) => {
	const hull = polygonHull(
		leaves.flatMap( ( { x, y, halfW, halfH } ) => [
			[ x - halfW, y - halfH ],
			[ x + halfW, y - halfH ],
			[ x - halfW, y + halfH ],
			[ x + halfW, y + halfH ],
		] )
	);
	const [ cx, cy ] = polygonCentroid( hull );

	return hull.map( ( [ px, py ] ) => {
		const dx = px - cx;
		const dy = py - cy;
		const len = Math.sqrt( dx * dx + dy * dy ) || 1;
		return [ px + ( dx / len ) * padding, py + ( dy / len ) * padding ];
	} );
};
