import { viewportCull, isEdgeVisible, clipSegmentExit } from '../viewportCull';

describe( 'clipSegmentExit', () => {
	const region = { x: 0, y: 0, w: 100, h: 100 };

	it( 'exits at the right boundary for a rightward segment', () => {
		expect( clipSegmentExit( 50, 50, 200, 50, region ) ).toEqual( {
			x: 100,
			y: 50,
		} );
	} );

	it( 'exits at the bottom boundary for a downward segment', () => {
		expect( clipSegmentExit( 50, 50, 50, 300, region ) ).toEqual( {
			x: 50,
			y: 100,
		} );
	} );

	it( 'exits diagonally (whichever boundary it reaches first)', () => {
		// Toward the bottom-right corner: dx=dy, so it exits at (100,100).
		expect( clipSegmentExit( 50, 50, 1050, 1050, region ) ).toEqual( {
			x: 100,
			y: 100,
		} );
	} );

	it( 'returns the target unchanged when it is already inside', () => {
		expect( clipSegmentExit( 50, 50, 60, 60, region ) ).toEqual( {
			x: 60,
			y: 60,
		} );
	} );
} );

describe( 'viewportCull region (for edge clipping)', () => {
	it( 'returns the on-screen region rect', () => {
		const { region } = viewportCull(
			[],
			{ x: 0, y: 0, w: 1000, h: 1000 },
			{ w: 1000, h: 1000 }
		);
		expect( region ).toEqual( { x: 0, y: 0, w: 1000, h: 1000 } );
	} );
} );

describe( 'isEdgeVisible', () => {
	const vis = new Set( [ 'a', 'b' ] ); // a, b on-screen; c, d off-screen

	it( 'renders an edge between two visible nodes', () => {
		expect( isEdgeVisible( 'a', 'b', vis ) ).toBe( true );
	} );

	it( 'culls an edge only when BOTH endpoints are off-screen', () => {
		expect( isEdgeVisible( 'c', 'd', vis ) ).toBe( false );
	} );

	it( 'renders an edge whose source is on-screen (target off)', () => {
		expect( isEdgeVisible( 'a', 'c', vis ) ).toBe( true );
	} );

	it( 'renders an edge whose target is on-screen (source off)', () => {
		// Bug: an edge to an in-view node was culled when its source left.
		expect( isEdgeVisible( 'c', 'a', vis ) ).toBe( true );
	} );

	it( 'renders an edge to a visible high-degree hub (no degree LOD)', () => {
		// One visible endpoint is enough regardless of how many edges it has.
		const visHub = new Set( [ 'hub' ] );
		expect( isEdgeVisible( 'hub', 'c', visHub ) ).toBe( true );
	} );
} );

describe( 'viewportCull', () => {
	it( 'keeps a node inside the viewBox', () => {
		const nodes = [ { id: 'a', position: { x: 100, y: 100 } } ];
		const vb = { x: 0, y: 0, w: 1000, h: 1000 };
		const { visibleIds } = viewportCull( nodes, vb, { w: 1000, h: 1000 } );
		expect( visibleIds.has( 'a' ) ).toBe( true );
	} );

	it( 'culls a node far outside the viewBox', () => {
		const nodes = [ { id: 'far', position: { x: 50000, y: 50000 } } ];
		const vb = { x: 0, y: 0, w: 1000, h: 1000 };
		const { visibleIds } = viewportCull( nodes, vb, { w: 1000, h: 1000 } );
		expect( visibleIds.has( 'far' ) ).toBe( false );
	} );

	it( 'culls a node fully outside the viewport (no margin by default)', () => {
		// Aggressive cull: only nodes intersecting the viewBox render.
		const nodes = [ { id: 'out', position: { x: 1100, y: 0 } } ];
		const vb = { x: 0, y: 0, w: 1000, h: 1000 };
		const { visibleIds } = viewportCull( nodes, vb, { w: 1000, h: 1000 } );
		expect( visibleIds.has( 'out' ) ).toBe( false );
	} );

	it( 'keeps a node straddling the viewport edge', () => {
		// Partially-visible node (its left edge is inside) still renders.
		const nodes = [ { id: 'straddle', position: { x: 950, y: 0 } } ];
		const vb = { x: 0, y: 0, w: 1000, h: 1000 };
		const { visibleIds } = viewportCull( nodes, vb, { w: 1000, h: 1000 } );
		expect( visibleIds.has( 'straddle' ) ).toBe( true );
	} );

	it( 'honors an explicit cull margin', () => {
		const nodes = [ { id: 'edge', position: { x: 1100, y: 0 } } ];
		const vb = { x: 0, y: 0, w: 1000, h: 1000 };
		const { visibleIds } = viewportCull(
			nodes,
			vb,
			{ w: 1000, h: 1000 },
			{ margin: 200 }
		);
		expect( visibleIds.has( 'edge' ) ).toBe( true );
	} );

	it( 'keeps a node within the overscan band (fraction of the viewBox)', () => {
		// overscan 0.5 of a 1000-wide viewBox = 500 units margin per side.
		const nodes = [ { id: 'near', position: { x: 1300, y: 0 } } ];
		const vb = { x: 0, y: 0, w: 1000, h: 1000 };
		const { visibleIds } = viewportCull(
			nodes,
			vb,
			{ w: 1000, h: 1000 },
			{ overscan: 0.5 }
		);
		expect( visibleIds.has( 'near' ) ).toBe( true );
	} );

	it( 'still culls a node beyond the overscan band', () => {
		const nodes = [ { id: 'far', position: { x: 1600, y: 0 } } ];
		const vb = { x: 0, y: 0, w: 1000, h: 1000 };
		const { visibleIds } = viewportCull(
			nodes,
			vb,
			{ w: 1000, h: 1000 },
			{ overscan: 0.5 }
		);
		expect( visibleIds.has( 'far' ) ).toBe( false );
	} );

	it( 'overscans per-axis (a tall-narrow viewBox gets a small X / large Y band)', () => {
		// viewBox 400x4000; overscan 0.5 -> 200 X-margin, 2000 Y-margin.
		const vb = { x: 0, y: 0, w: 400, h: 4000 };
		const within = viewportCull(
			[ { id: 'y', position: { x: 0, y: 5500 } } ], // 1500 < 2000 Y-band
			vb,
			{ w: 400, h: 4000 },
			{ overscan: 0.5 }
		);
		const beyond = viewportCull(
			[ { id: 'x', position: { x: 700, y: 0 } } ], // 300 > 200 X-band
			vb,
			{ w: 400, h: 4000 },
			{ overscan: 0.5 }
		);
		expect( within.visibleIds.has( 'y' ) ).toBe( true );
		expect( beyond.visibleIds.has( 'x' ) ).toBe( false );
	} );

	it( 'culls against the meet-expanded (letterbox) region, not the raw viewBox', () => {
		// Letterbox (meet) widens the on-screen world, so a side node stays.
		const vb = { x: 0, y: 0, w: 400, h: 4000 };
		const nodes = [ { id: 'side', position: { x: 1400, y: 0 } } ];
		const { visibleIds } = viewportCull( nodes, vb, { w: 2000, h: 1000 } );
		expect( visibleIds.has( 'side' ) ).toBe( true );
	} );

	it( 'drops detail when the scale is too small to read (zoomed out)', () => {
		// 1000 canvas px across a 50000-unit viewBox → 0.02 px/unit.
		const vb = { x: 0, y: 0, w: 50000, h: 50000 };
		const { showDetail } = viewportCull( [], vb, { w: 1000, h: 1000 } );
		expect( showDetail ).toBe( false );
	} );

	it( 'drops detail for a tall-narrow graph constrained by HEIGHT', () => {
		// Tall-narrow: meet uses the tiny height scale, not the wide width.
		const vb = { x: 0, y: 0, w: 400, h: 50000 };
		const { showDetail } = viewportCull( [], vb, { w: 1300, h: 1900 } );
		expect( showDetail ).toBe( false );
	} );

	it( 'keeps detail at a readable scale', () => {
		const vb = { x: 0, y: 0, w: 1000, h: 1000 };
		const { showDetail } = viewportCull( [], vb, { w: 1000, h: 1000 } );
		expect( showDetail ).toBe( true );
	} );

	it( 'keeps detail when the canvas size is unmeasured (0)', () => {
		// First render / jsdom: clientWidth is 0 — show detail, not hide.
		const vb = { x: 0, y: 0, w: 50000, h: 50000 };
		const { showDetail } = viewportCull( [], vb, { w: 0, h: 0 } );
		expect( showDetail ).toBe( true );
	} );
} );

describe( 'viewportCull visibleRegion (bloom filter region)', () => {
	// The bloom filter pins its region to the strict viewport rect.
	it( 'returns the strict on-screen rect, excluding the overscan margin', () => {
		const { region, visibleRegion } = viewportCull(
			[],
			{ x: 0, y: 0, w: 1000, h: 1000 },
			{ w: 1000, h: 1000 },
			{ overscan: 0.5 }
		);
		expect( visibleRegion ).toEqual( { x: 0, y: 0, w: 1000, h: 1000 } );
		// region carries the 500-unit overscan margin; visibleRegion doesn't.
		expect( region.w ).toBeGreaterThan( visibleRegion.w );
	} );

	it( 'expands visibleRegion to the meet-letterbox in a wide canvas', () => {
		// Tall-narrow in a wide canvas: meet 0.25 → world width 8000.
		const { visibleRegion } = viewportCull(
			[],
			{ x: 0, y: 0, w: 400, h: 4000 },
			{ w: 2000, h: 1000 }
		);
		expect( visibleRegion.w ).toBeCloseTo( 8000, 3 );
		expect( visibleRegion.h ).toBeCloseTo( 4000, 3 );
	} );
} );
