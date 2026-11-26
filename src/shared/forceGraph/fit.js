/**
 * The view that shows a whole force graph.
 */

import { max, min, zoomIdentity } from 'd3';
import { effectiveInset, maxInsetBeforeLOD } from '../utils/viewportResize';

/** The least and the greatest scale of the view. */
export const ZOOM_RANGE = [ 0.01, 10 ];

/** Room around the graph in a fitted view, in the graph's own units. */
const FIT_PADDING = 50;

/** Share of the canvas a fitted graph and its padding take. */
const FIT_SHARE = 0.9;

/** The least scale a view draws its names at. */
export const TEXT_ZOOM = 0.25;

/** The least scale a fit takes, a hair above TEXT_ZOOM so rounding cannot hide the names. */
const FIT_FLOOR_SCALE = TEXT_ZOOM * 1.2;

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
 * The view that shows a whole graph above the foot a host covers.
 *
 * @param {import('./model').Leaf[]}        leaves At least one leaf.
 * @param {{width: number, height: number}} size   Canvas size.
 * @param {number}                          inset  Pixels the host covers at the canvas's foot.
 * @return {import('d3').ZoomTransform} The view.
 */
export const fitOf = ( leaves, { width, height }, inset ) => {
	const [ left, right ] = spread( leaves, 'x', 'halfW' );
	const [ top, bottom ] = spread( leaves, 'y', 'halfH' );
	const clear = Math.min(
		effectiveInset( height, inset ),
		maxInsetBeforeLOD( {
			canvasH: height,
			bboxH: bottom - top,
			detailScale: FIT_FLOOR_SCALE,
			fill: FIT_SHARE,
		} )
	);
	const shown = height - clear;
	const [ least, greatest ] = ZOOM_RANGE;
	const scale = Math.min(
		width / ( right - left ),
		shown / ( bottom - top )
	);
	const k = Math.min( greatest, Math.max( least, scale * FIT_SHARE ) );

	return zoomIdentity
		.translate( width / 2, shown / 2 )
		.scale( k )
		.translate( -( left + right ) / 2, -( top + bottom ) / 2 );
};
