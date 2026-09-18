import { hullAt, hullGeometry } from '../hullPath';

describe( 'hullGeometry', () => {
	it( 'returns an empty path and no area for no rects', () => {
		expect( hullGeometry( [] ) ).toEqual( { d: '', area: 0, poly: [] } );
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

describe( 'hullAt', () => {
	const square = ( x0, y0, x1, y1 ) => [
		[ x0, y0 ],
		[ x1, y0 ],
		[ x1, y1 ],
		[ x0, y1 ],
	];
	// Paint order, bottom first: base under mid under top.
	const stack = [
		{ include: 'base-414', poly: square( 0, 0, 300, 300 ) },
		{ include: 'mid-515', poly: square( 50, 50, 250, 250 ) },
		{ include: 'top-616', poly: square( 100, 100, 200, 200 ) },
	];
	const at = ( x, y ) => ( { x, y } );

	it( 'takes the topmost hull containing the point when none is selected', () => {
		expect( hullAt( stack, at( 150, 150 ), null ) ).toBe( 'top-616' );
		expect( hullAt( stack, at( 60, 60 ), null ) ).toBe( 'mid-515' );
	} );

	it( 'passes a press inside the selected hull to the next one below', () => {
		expect( hullAt( stack, at( 150, 150 ), 'top-616' ) ).toBe( 'mid-515' );
	} );

	it( 'makes the hulls above a buried selection transparent within it', () => {
		expect( hullAt( stack, at( 150, 150 ), 'mid-515' ) ).toBe( 'base-414' );
	} );

	it( 'wraps to the topmost hull when nothing lies below the selection', () => {
		expect( hullAt( stack, at( 150, 150 ), 'base-414' ) ).toBe( 'top-616' );
	} );

	it( 'leaves hulls outside the selection alone', () => {
		const apart = [
			...stack,
			{ include: 'side-717', poly: square( 400, 0, 500, 100 ) },
		];
		expect( hullAt( apart, at( 450, 50 ), 'top-616' ) ).toBe( 'side-717' );
		expect( hullAt( apart, at( 20, 20 ), 'top-616' ) ).toBe( 'base-414' );
	} );

	it( 'returns null where no hull reaches', () => {
		expect( hullAt( stack, at( 900, 900 ), null ) ).toBeNull();
	} );
} );
