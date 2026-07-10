import { deltaFromAutofit, viewportFromDelta } from '../autofitDelta';

const A = { x: 100, y: 50, w: 800, h: 450 };

describe( 'deltaFromAutofit', () => {
	it( 'a viewport EQUAL to autofit is the zero delta {0,0,1}', () => {
		expect( deltaFromAutofit( A, A ) ).toEqual( {
			dcx: 0,
			dcy: 0,
			zoom: 1,
		} );
	} );

	it( 'captures the center offset (world units) and the zoom ratio', () => {
		// Centered +40,+20 at half width → {dcx:40, dcy:20, zoom:2}.
		const V = { x: 340, y: 182.5, w: 400, h: 225 };
		const d = deltaFromAutofit( V, A );
		expect( d.dcx ).toBeCloseTo( 40 );
		expect( d.dcy ).toBeCloseTo( 20 );
		expect( d.zoom ).toBeCloseTo( 2 );
	} );

	it( 'returns null for unusable inputs', () => {
		expect( deltaFromAutofit( null, A ) ).toBeNull();
		expect( deltaFromAutofit( { x: 0, y: 0, w: 0, h: 10 }, A ) ).toBeNull();
		expect( deltaFromAutofit( A, { x: 0, y: 0, w: 0, h: 0 } ) ).toBeNull();
	} );
} );

describe( 'viewportFromDelta', () => {
	it( 'the zero delta re-derives EXACTLY the autofit (stays autofit)', () => {
		expect( viewportFromDelta( { dcx: 0, dcy: 0, zoom: 1 }, A ) ).toEqual(
			A
		);
	} );

	it( 'zero delta against a DIFFERENT autofit yields that autofit (resize stays fit)', () => {
		const A2 = { x: -10, y: -10, w: 1200, h: 900 };
		expect( viewportFromDelta( { dcx: 0, dcy: 0, zoom: 1 }, A2 ) ).toEqual(
			A2
		);
	} );

	it( 'round-trips: viewportFromDelta(deltaFromAutofit(V, A), A) === V', () => {
		const V = { x: 220, y: 140, w: 400, h: 225 };
		const d = deltaFromAutofit( V, A );
		const back = viewportFromDelta( d, A );
		expect( back.x ).toBeCloseTo( V.x );
		expect( back.y ).toBeCloseTo( V.y );
		expect( back.w ).toBeCloseTo( V.w );
		expect( back.h ).toBeCloseTo( V.h );
	} );

	it( 'returns null for unusable inputs', () => {
		expect( viewportFromDelta( null, A ) ).toBeNull();
		expect(
			viewportFromDelta( { dcx: 0, dcy: 0, zoom: 0 }, A )
		).toBeNull();
		expect(
			viewportFromDelta( { dcx: 0, dcy: 0, zoom: 1 }, { w: 0, h: 0 } )
		).toBeNull();
	} );
} );
