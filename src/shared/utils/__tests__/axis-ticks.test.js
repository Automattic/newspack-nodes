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

import { axisDuration } from '../axis-ticks';

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
} );
