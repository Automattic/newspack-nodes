/**
 * Tick ladders for value axes whose formatter does not count in base 10.
 *
 * d3 picks tick values that are round in base 10, and a formatter that divides
 * by anything else then prints every one of them as a fraction: a byte axis
 * ticked at 1,000,000 reads "977 KB". A formatter carries the ladder its unit
 * is round in as a `tickValues` property, and `drawAxes` ticks the axis with
 * it — see `formatters.js` for the byte ladders and `drawAxes` for the call.
 *
 * Each takes the axis scale, so the base-10 ladder can defer to d3's own
 * `scale.ticks()` without this module importing d3.
 */

/**
 * A value formatter that may carry the tick ladder its unit is round in.
 *
 * @typedef {( ( value: * ) => string ) & { tickValues?: ( scale: *, count: number ) => number[] }} AxisFormatter
 */

/**
 * Tick values at multiples of a power of two, so a base-1024 formatter prints
 * every one of them whole: 0 B, 1 MB, 2 MB, 3 MB.
 *
 * The exponent is the one whose step lands nearest the span d3 would have
 * given each tick, so the count stays close to `count`.
 *
 * @param {Object} scale D3 linear scale.
 * @param {number} count Target tick count.
 * @return {number[]} Tick values inside the scale's domain.
 */
export const binaryTicks = ( scale, count ) => {
	const [ lo, hi ] = scale.domain();
	const step = 2 ** Math.round( Math.log2( ( hi - lo ) / count ) );
	const ticks = [];
	// Index arithmetic, not accumulation: exact, and no endless loop.
	for ( let i = Math.ceil( lo / step ); i <= Math.floor( hi / step ); i++ ) {
		ticks.push( i * step );
	}
	return ticks;
};

/**
 * d3's own tick values, less the fractional ones — for a formatter that prints
 * whole units (requests, milliseconds) and would otherwise repeat a label.
 *
 * @param {Object} scale D3 linear scale.
 * @param {number} count Target tick count.
 * @return {number[]} Whole-numbered tick values.
 */
export const integerTicks = ( scale, count ) =>
	scale.ticks( count ).filter( Number.isInteger );
