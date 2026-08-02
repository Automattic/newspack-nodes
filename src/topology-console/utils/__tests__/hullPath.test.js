import { hullGeometry } from '../hullPath';

describe( 'hullGeometry', () => {
	it( 'returns an empty path and no area for no rects', () => {
		expect( hullGeometry( [] ) ).toEqual( { d: '', area: 0 } );
	} );

	it( 'wraps two rects in one closed path that contains both, padded', () => {
		const { d, area } = hullGeometry(
			[
				{ x: 0, y: 0, w: 100, h: 50 },
				{ x: 300, y: 200, w: 100, h: 50 },
			],
			20
		);
		expect( d ).toMatch( /^M / );
		expect( d.trim().endsWith( 'Z' ) ).toBe( true );
		// Padded extremes: left edge at -20, right edge at 420.
		const xs = [ ...d.matchAll( /-?\d+(?:\.\d+)?/g ) ].map( Number );
		expect( Math.min( ...xs ) ).toBeLessThanOrEqual( -20 );
		expect( Math.max( ...xs ) ).toBeGreaterThanOrEqual( 420 );
		// True hull area, not the 440x310 bbox the two rects span.
		expect( area ).toBeGreaterThan( 0 );
		expect( area ).toBeLessThan( 440 * 310 );
	} );
} );
