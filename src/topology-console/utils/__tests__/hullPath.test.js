import { hullPath } from '../hullPath';

describe( 'hullPath', () => {
	it( 'returns an empty string for no rects', () => {
		expect( hullPath( [] ) ).toBe( '' );
	} );

	it( 'wraps two rects in one closed path that contains both, padded', () => {
		const d = hullPath(
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
	} );
} );
