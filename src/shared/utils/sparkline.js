/**
 * The one sparkline geometry every surface draws on: the topology card's rate
 * line, the inspector's telemetry rows and the shared `Sparkline` component.
 *
 * A sparkline scales to its own tallest value, so a trickle and a flood draw
 * the same shape; a surface that must keep rows comparable labels the peak
 * beside it. A value at or below zero, such as a rate across a counter reset,
 * rests on the floor rather than plotting below the box.
 */

/** The peak an all-zero series scales against, so no point divides by zero. */
const PEAK_FLOOR = 1e-9;

/**
 * Each value as a point in a box, oldest at the left: the box's `slots`
 * spread across its width, the values in the last of them, so a window
 * longer than its history right-aligns it, and the tallest value at the top.
 *
 * @param {number[]} values      The values, oldest first.
 * @param {Object}   box         The box the points fill.
 * @param {number}   box.width   Its width.
 * @param {number}   box.height  Its height, and so a full-scale deflection.
 * @param {number}   [box.left]  Its left edge; 0 by default.
 * @param {number}   [box.top]   Its top edge; 0 by default.
 * @param {number}   [box.slots] The places across it; one per value by default.
 * @param {number}   [box.peak]  The value its top stands for; the tallest value by default.
 * @return {Array<[number, number]>} Each value's x and y, oldest first.
 */
export function sparklinePoints(
	values,
	{
		width,
		height,
		left = 0,
		top = 0,
		slots = values.length,
		peak: ceiling = Math.max( ...values ),
	}
) {
	const peak = Math.max( ceiling, PEAK_FLOOR );
	const step = 1 < slots ? width / ( slots - 1 ) : 0;
	const first = slots - values.length;
	return values.map( ( value, i ) => [
		left + ( first + i ) * step,
		top + height - ( Math.max( value, 0 ) / peak ) * height,
	] );
}

/**
 * Points joined as one SVG path, each coordinate to two places.
 *
 * @param {Array<[number, number]>} points The points, in drawing order.
 * @return {?string} The path's `d`, or null under two points, which make no line.
 */
export function linePath( points ) {
	if ( points.length < 2 ) {
		return null;
	}
	return points
		.map(
			( [ x, y ], i ) =>
				`${ 0 === i ? 'M' : 'L' } ${ x.toFixed( 2 ) },${ y.toFixed(
					2
				) }`
		)
		.join( ' ' );
}
