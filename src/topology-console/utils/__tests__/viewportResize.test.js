import {
	resizeViewportTrackingAutofit,
	maxInsetBeforeLOD,
} from '../viewportResize';

describe( 'maxInsetBeforeLOD', () => {
	// autofit scale (height-bound) = fill × (canvasH − inset) / bboxH; the floor
	// is the inset where that scale === detailScale, i.e. the graph is right at LOD.
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

// The displayed scale of a viewport at a given canvas px (preserveAspectRatio
// "meet") is min( px.w / vp.w, px.h / vp.h ). These tests assert the reconciled
// viewport's scale/center against that.
describe( 'resizeViewportTrackingAutofit', () => {
	// A fit viewport at 1000x500: displayed scale 1 (both fits equal 1).
	const vp = { x: 0, y: 0, w: 1000, h: 500 }; // center (500, 250)

	it( 'preserves the viewport center', () => {
		const out = resizeViewportTrackingAutofit( {
			viewport: vp,
			oldPx: { w: 1000, h: 500 },
			newPx: { w: 800, h: 600 },
			fitOld: 1,
			fitNew: 1,
		} );
		expect( out.x + out.w / 2 ).toBeCloseTo( 500 );
		expect( out.y + out.h / 2 ).toBeCloseTo( 250 );
	} );

	it( 'gives the reconciled viewport the new canvas aspect (no letterbox)', () => {
		const out = resizeViewportTrackingAutofit( {
			viewport: vp,
			oldPx: { w: 1000, h: 500 },
			newPx: { w: 1600, h: 800 },
			fitOld: 1,
			fitNew: 2,
		} );
		expect( out.w / out.h ).toBeCloseTo( 1600 / 800 );
	} );

	it( 'at autofit (ratio 1) tracks the new autofit scale exactly', () => {
		// oldScale = 1 = fitOld → ratio 1; fitNew 2 → displayed scale should be 2.
		const out = resizeViewportTrackingAutofit( {
			viewport: vp,
			oldPx: { w: 1000, h: 500 },
			newPx: { w: 1600, h: 800 },
			fitOld: 1,
			fitNew: 2,
		} );
		expect( 1600 / out.w ).toBeCloseTo( 2 );
	} );

	it( 'preserves a manual zoom ratio across the resize', () => {
		// oldScale 1 but fitOld 0.5 → zoomed 2x past fit; fitNew 0.5 (no px change).
		const out = resizeViewportTrackingAutofit( {
			viewport: vp,
			oldPx: { w: 1000, h: 500 },
			newPx: { w: 1000, h: 500 },
			fitOld: 0.5,
			fitNew: 0.5,
		} );
		const newScale = 1000 / out.w;
		expect( newScale / 0.5 ).toBeCloseTo( 2 ); // ratio preserved
	} );

	it( 'scales down when the new autofit scale is smaller', () => {
		const out = resizeViewportTrackingAutofit( {
			viewport: vp,
			oldPx: { w: 1000, h: 500 },
			newPx: { w: 600, h: 300 },
			fitOld: 1,
			fitNew: 0.6,
		} );
		expect( 600 / out.w ).toBeCloseTo( 0.6 ); // tracks the smaller autofit
	} );

	it( 'does NOT scale down when autofit is unchanged (width-only shrink, height-bound)', () => {
		// Current meet-fit would letterbox to 0.7; tracking autofit keeps scale 1.
		const out = resizeViewportTrackingAutofit( {
			viewport: vp,
			oldPx: { w: 1000, h: 500 },
			newPx: { w: 700, h: 500 },
			fitOld: 1,
			fitNew: 1,
		} );
		expect( 700 / out.w ).toBeCloseTo( 1 );
	} );

	it( 'reflows to follow the autofit center when it shifts (transcript opens)', () => {
		// vp centered on the old autofit center; band center moves down 150.
		const out = resizeViewportTrackingAutofit( {
			viewport: vp, // center (500,250)
			oldPx: { w: 1000, h: 500 },
			newPx: { w: 1000, h: 500 },
			fitOld: 1,
			fitNew: 1,
			oldCenter: { x: 500, y: 250 },
			newCenter: { x: 500, y: 400 },
		} );
		expect( out.x + out.w / 2 ).toBeCloseTo( 500 );
		expect( out.y + out.h / 2 ).toBeCloseTo( 400 ); // followed the band
	} );

	it( 'preserves the pan offset relative to the autofit center', () => {
		// User panned 50 below the old autofit center; band center then moves to 400.
		const out = resizeViewportTrackingAutofit( {
			viewport: { x: 0, y: 50, w: 1000, h: 500 }, // center (500,300)
			oldPx: { w: 1000, h: 500 },
			newPx: { w: 1000, h: 500 },
			fitOld: 1,
			fitNew: 1,
			oldCenter: { x: 500, y: 250 },
			newCenter: { x: 500, y: 400 },
		} );
		expect( out.y + out.h / 2 ).toBeCloseTo( 450 ); // 400 + preserved offset 50
	} );

	it( 'returns the viewport unchanged on invalid inputs', () => {
		expect(
			resizeViewportTrackingAutofit( {
				viewport: null,
				oldPx: { w: 1, h: 1 },
				newPx: { w: 1, h: 1 },
				fitOld: 1,
				fitNew: 1,
			} )
		).toBeNull();
		expect(
			resizeViewportTrackingAutofit( {
				viewport: vp,
				oldPx: { w: 0, h: 0 },
				newPx: { w: 1, h: 1 },
				fitOld: 1,
				fitNew: 1,
			} )
		).toBe( vp );
		expect(
			resizeViewportTrackingAutofit( {
				viewport: vp,
				oldPx: { w: 1, h: 1 },
				newPx: { w: 1, h: 1 },
				fitOld: 0,
				fitNew: 1,
			} )
		).toBe( vp );
	} );
} );
