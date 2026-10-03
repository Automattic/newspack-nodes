/**
 * Ticks and units for a value axis, so every label reads round and in one unit.
 *
 * d3 picks tick values that are round in base 10, and a formatter that divides
 * by anything else then prints every one of them as a fraction: a byte axis
 * ticked at 1,000,000 reads "977 KB". A formatter carries the ladder its unit
 * is round in as a `tickValues` property, and `drawAxes` ticks the axis with
 * it — see `formatters.js` for the byte ladders and `drawAxes` for the call.
 * Each ladder takes the axis scale, so the base-10 one can defer to d3's own
 * `scale.ticks()` without this module importing d3.
 *
 * `axisDuration` is the other half of a readable axis: it picks the unit the
 * whole axis reads in, which a per-value formatter cannot do.
 */

/**
 * Milliseconds in a microsecond, the rung below a millisecond. Its suffix is
 * the `us` `formatUtils.formatDuration` prints, so an axis and a readout agree.
 */
const MS_PER_MICROSECOND = 0.001;

/** Milliseconds in a second, the first rung `durationUnit` climbs to. */
const MS_PER_SECOND = 1000;

/**
 * Milliseconds in a kilosecond, the ladder's top rung.
 *
 * A thousand seconds rather than minutes or hours, because those divide by 60
 * and would print d3's round tick values as fractions — the same defect
 * `binaryTicks` exists to spare a byte axis.
 */
const MS_PER_KILOSECOND = 1000 * MS_PER_SECOND;

/**
 * The unit a duration axis should read in, chosen ONCE from its domain.
 *
 * Per-value laddering is right for a readout and wrong for an axis: it prints
 * `200ms` and `1.0s` on the same scale, and the reader has to convert in their
 * head to see which tick is larger. An axis picks one unit and holds it.
 *
 * The unit follows the data rather than being pinned to milliseconds, because
 * a slow site's ticks then run to five digits — `140000ms` — which is wider
 * than the axis title beside it, and the two collide.
 *
 * @param {number} maxMs Largest value the axis has to show, in milliseconds.
 * @return {{divisor: number, suffix: string, decimals: number}} The unit.
 */
const durationUnit = ( maxMs ) => {
	if ( maxMs >= MS_PER_KILOSECOND ) {
		return { divisor: MS_PER_KILOSECOND, suffix: 'Ks', decimals: 1 };
	}
	if ( maxMs >= 10 * MS_PER_SECOND ) {
		return { divisor: MS_PER_SECOND, suffix: 's', decimals: 0 };
	}
	if ( maxMs >= MS_PER_SECOND ) {
		return { divisor: MS_PER_SECOND, suffix: 's', decimals: 1 };
	}
	if ( maxMs >= 1 ) {
		return { divisor: 1, suffix: 'ms', decimals: 0 };
	}
	return { divisor: MS_PER_MICROSECOND, suffix: 'us', decimals: 0 };
};

/**
 * A duration formatter for a value AXIS, in one unit for the whole axis.
 *
 * `formatUtils.formatDuration` is the READOUT version and ladders per value,
 * which a detail panel wants and an axis must not have. Build this once from
 * the domain and hand it to every tick.
 *
 * The formatter carries a tick ladder of whole steps of what its unit prints
 * — a microsecond, a millisecond, a tenth of a second — because a narrow
 * axis would otherwise tick between them and round two neighbouring ticks to
 * the same label: a 5 µs axis ticked at half a microsecond reads `1us` twice.
 *
 * @param {number} maxMs Largest value the axis has to show, in milliseconds.
 * @return {AxisFormatter} Formatter, e.g. `0us`/`400us`, `0ms`/`250ms` or `0s`/`140s`.
 */
export const axisDuration = ( maxMs ) => {
	const { divisor, suffix, decimals } = durationUnit( maxMs );
	/**
	 * Render one tick in the unit this axis settled on.
	 *
	 * @param {number} ms A value on the axis, in milliseconds.
	 * @return {string} The tick label, e.g. `4.2s`.
	 */
	const format = ( ms ) => {
		const value = ms / divisor;
		// Trailing `.0` is noise on a tick.
		const shown =
			0 === decimals ? Math.round( value ) : value.toFixed( decimals );
		return `${ Number( shown ) }${ suffix }`;
	};
	format.tickValues = wholeTicks( divisor / 10 ** decimals );
	return format;
};

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
 * A tick ladder keeping d3's own tick values that land on a whole number of
 * `step`, within float error — for a formatter that prints whole steps and
 * would otherwise repeat a label.
 *
 * @param {number} step The smallest value the formatter tells apart.
 * @return {( scale: *, count: number ) => number[]} The ladder.
 */
const wholeTicks = ( step ) => ( scale, count ) =>
	scale
		.ticks( count )
		.filter(
			( t ) => Math.abs( t / step - Math.round( t / step ) ) < 1e-9
		);

/**
 * d3's own tick values, less the fractional ones — for a formatter that prints
 * whole units (requests, milliseconds) and would otherwise repeat a label.
 *
 * @type {( scale: *, count: number ) => number[]}
 */
export const integerTicks = wholeTicks( 1 );
