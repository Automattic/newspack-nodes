import { effectiveInset, maxInsetBeforeLOD } from '../viewportResize';

describe( 'maxInsetBeforeLOD', () => {
	// The floor is the inset where the autofit scale hits detailScale (LOD).
	it( 'is the inset that leaves the graph exactly at the LOD scale', () => {
		// canvasH 1000, bboxH 500, detail 0.35, fill 0.9 → minUsableH 194.4
		const inset = maxInsetBeforeLOD( {
			canvasH: 1000,
			bboxH: 500,
			detailScale: 0.35,
			fill: 0.9,
		} );
		expect( inset ).toBeCloseTo( 1000 - ( 0.35 * 500 ) / 0.9, 1 );
		// at that inset, the height-bound autofit scale is exactly detailScale
		const usableH = 1000 - inset;
		expect( ( 0.9 * usableH ) / 500 ).toBeCloseTo( 0.35 );
	} );

	it( 'never returns negative (tall graph that already needs the whole canvas)', () => {
		const inset = maxInsetBeforeLOD( {
			canvasH: 300,
			bboxH: 5000,
			detailScale: 0.35,
			fill: 0.9,
		} );
		expect( inset ).toBe( 0 );
	} );

	it( 'returns Infinity (no clamp) when the bbox is unknown', () => {
		expect(
			maxInsetBeforeLOD( {
				canvasH: 1000,
				bboxH: 0,
				detailScale: 0.35,
				fill: 0.9,
			} )
		).toBe( Infinity );
	} );
} );

describe( 'effectiveInset', () => {
	it( 'leaves clear what the host covers', () => {
		expect( effectiveInset( 1000, 373 ) ).toBe( 373 );
	} );

	it( 'counts a cover of nine tenths of the canvas or more as none', () => {
		expect( effectiveInset( 1000, 899 ) ).toBe( 899 );
		expect( effectiveInset( 1000, 900 ) ).toBe( 0 );
	} );

	it( 'never leaves less than nothing clear', () => {
		expect( effectiveInset( 1000, -40 ) ).toBe( 0 );
	} );
} );
