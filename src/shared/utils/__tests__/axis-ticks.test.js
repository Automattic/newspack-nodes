/**
 * Tests for axis-ticks' duration formatter.
 *
 * A tick label is not a readout. `formatUtils.formatDuration` ladders per
 * value, which a detail panel wants; an axis must not, or it prints `200ms`
 * and `1.0s` on one scale and the reader converts in their head to see which
 * tick is larger. The unit is chosen once, from the domain — and it has to be
 * chosen, because pinned to milliseconds a slow site's ticks run to five
 * digits and collide with the axis title beside them.
 */

import * as d3 from 'd3';
import { axisDuration } from '../axis-ticks';

/**
 * The labels an axis built as `drawAxes` builds one would print.
 *
 * @param {number} peak The largest value the axis shows, in ms.
 * @return {string[]} Every tick label.
 */
const tickLabels = ( peak ) => {
	const format = axisDuration( peak );
	const scale = d3.scaleLinear().domain( [ 0, peak ] );
	const ticks = format.tickValues
		? format.tickValues( scale, 5 )
		: scale.ticks( 5 );
	return ticks.map( format );
};

describe( 'axisDuration', () => {
	it( 'keeps a sub-second axis in milliseconds', () => {
		const format = axisDuration( 800 );
		expect( format( 0 ) ).toBe( '0ms' );
		expect( format( 200 ) ).toBe( '200ms' );
		expect( format( 800 ) ).toBe( '800ms' );
	} );

	it( 'reads a few-second axis in seconds, with a decimal to tell ticks apart', () => {
		const format = axisDuration( 4200 );
		expect( format( 4200 ) ).toBe( '4.2s' );
		expect( format( 1000 ) ).toBe( '1s' );
	} );

	it( 'drops the decimal once the second count carries the magnitude', () => {
		// The case that started this: `140000ms` is wider than the axis title.
		const format = axisDuration( 140000 );
		expect( format( 140000 ) ).toBe( '140s' );
		expect( format( 20000 ) ).toBe( '20s' );
	} );

	it( 'climbs to kiloseconds rather than run to six digits', () => {
		const format = axisDuration( 1500000 );
		expect( format( 1500000 ) ).toBe( '1.5Ks' );
	} );

	it( 'holds ONE unit across the whole axis, mixed magnitudes included', () => {
		// The flaw a per-value ladder has: every tick on this axis reads in
		// seconds, including the one that would have fitted in milliseconds.
		const format = axisDuration( 140000 );
		expect( format( 250 ) ).toBe( '0s' );
		expect( format( 0 ) ).toBe( '0s' );
	} );

	it( 'carries the integer tick ladder, so ticks land on whole values', () => {
		expect( typeof axisDuration( 1000 ).tickValues ).toBe( 'function' );
	} );

	it( 'reads a sub-millisecond axis in microseconds, every tick its own label', () => {
		const labels = tickLabels( 0.42 );
		expect( labels ).toEqual( [
			'0us',
			'100us',
			'200us',
			'300us',
			'400us',
		] );
		expect( new Set( labels ).size ).toBe( labels.length );
	} );

	it( 'ticks a few-microsecond axis on whole microseconds, never repeating a label', () => {
		const labels = tickLabels( 0.0025 );
		expect( labels ).toEqual( [ '0us', '1us', '2us' ] );
		expect( new Set( labels ).size ).toBe( labels.length );
	} );

	it( 'reads a 1.4 s peak in one unit', () => {
		for ( const label of tickLabels( 1400 ) ) {
			expect( label ).toMatch( /^\d+(\.\d)?s$/ );
		}
	} );

	it( 'keeps an axis peaking at a millisecond or more in whole milliseconds', () => {
		expect( tickLabels( 7 ) ).toEqual( [
			'0ms',
			'1ms',
			'2ms',
			'3ms',
			'4ms',
			'5ms',
			'6ms',
			'7ms',
		] );
	} );
} );
