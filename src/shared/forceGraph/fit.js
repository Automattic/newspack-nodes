/**
 * The view that shows a whole force graph.
 */

import { max, min, zoomIdentity } from 'd3';

/** The least and the greatest scale of the view. */
export const ZOOM_RANGE = [ 0.01, 10 ];

/** Room around the graph in a fitted view, in the graph's own units. */
const FIT_PADDING = 50;

/** Share of the canvas a fitted graph and its padding take. */
const FIT_SHARE = 0.9;

/**
 * Where a graph's labels begin and end along an axis, with the fit's padding.
 *
 * @param {import('./model').Leaf[]} leaves At least one leaf.
 * @param {'x'|'y'}                  axis   The axis.
 * @param {'halfW'|'halfH'}          half   The leaf's half extent along it.
 * @return {[number, number]} The start and the end.
 */
const spread = ( leaves, axis, half ) => [
	min( leaves, ( leaf ) => leaf[ axis ] - leaf[ half ] ) - FIT_PADDING,
	max( leaves, ( leaf ) => leaf[ axis ] + leaf[ half ] ) + FIT_PADDING,
];

/**
 * The view that shows a whole graph.
 *
 * @param {import('./model').Leaf[]}        leaves At least one leaf.
 * @param {{width: number, height: number}} size   Canvas size.
 * @return {import('d3').ZoomTransform} The view.
 */
export const fitOf = ( leaves, { width, height } ) => {
	const [ left, right ] = spread( leaves, 'x', 'halfW' );
	const [ top, bottom ] = spread( leaves, 'y', 'halfH' );
	const [ least, greatest ] = ZOOM_RANGE;
	const scale = Math.min(
		width / ( right - left ),
		height / ( bottom - top )
	);
	const k = Math.min( greatest, Math.max( least, scale * FIT_SHARE ) );

	return zoomIdentity
		.translate( width / 2, height / 2 )
		.scale( k )
		.translate( -( left + right ) / 2, -( top + bottom ) / 2 );
};
