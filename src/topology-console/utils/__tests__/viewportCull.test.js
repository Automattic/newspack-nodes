import { viewportCull, isEdgeVisible } from '../viewportCull';

describe( 'isEdgeVisible', () => {
	const vis = new Set( [ 'a', 'b' ] ); // a, b on-screen; c, hub off-screen
	const degree = { a: 2, b: 2, hub: 500 };

	it( 'renders an edge between two visible nodes', () => {
		expect( isEdgeVisible( 'a', 'b', vis, degree ) ).toBe( true );
	} );

	it( 'culls an edge with both endpoints off-screen', () => {
		expect( isEdgeVisible( 'c', 'hub', vis, degree ) ).toBe( false );
	} );

	it( 'renders an off-screen edge from a low-degree visible node', () => {
		// a (visible, degree 2) → c (off-screen): a chain connector still draws.
		expect( isEdgeVisible( 'a', 'c', vis, degree ) ).toBe( true );
	} );

	it( 'culls an off-screen edge from a high-degree hub', () => {
		// hub is off-screen with degree 500; an edge hub → a (visible) would,
		// from a's side, be one of a's 2 edges (rendered). But an edge a → hub
		// where the VISIBLE node is the hub floods, so a visible hub culls them.
		const visHub = new Set( [ 'hub' ] );
		expect( isEdgeVisible( 'hub', 'c', visHub, degree ) ).toBe( false );
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

	it( 'drops detail when the scale is too small to read (zoomed out)', () => {
		// 1000 canvas px across a 50000-unit viewBox → 0.02 px/unit.
		const vb = { x: 0, y: 0, w: 50000, h: 50000 };
		const { showDetail } = viewportCull( [], vb, { w: 1000, h: 1000 } );
		expect( showDetail ).toBe( false );
	} );

	it( 'drops detail for a tall-narrow graph constrained by HEIGHT', () => {
		// 400 wide × 50000 tall in a 1300×1900 canvas. Width-scale (1300/400 =
		// 3.25) looks zoomed-in, but preserveAspectRatio="meet" is height-bound:
		// 1900/50000 = 0.038 px/unit — unreadable. Must use the min (meet) scale.
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
		// First render / jsdom: clientWidth is 0 — show detail rather than hide it.
		const vb = { x: 0, y: 0, w: 50000, h: 50000 };
		const { showDetail } = viewportCull( [], vb, { w: 0, h: 0 } );
		expect( showDetail ).toBe( true );
	} );
} );
