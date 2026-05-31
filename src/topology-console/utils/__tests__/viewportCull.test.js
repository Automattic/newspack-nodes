import { viewportCull } from '../viewportCull';

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

	it( 'keeps a node just past the edge within the cull margin', () => {
		// A node one node-width past the right edge still anchors its edges.
		const nodes = [ { id: 'edge', position: { x: 1100, y: 0 } } ];
		const vb = { x: 0, y: 0, w: 1000, h: 1000 };
		const { visibleIds } = viewportCull( nodes, vb, { w: 1000, h: 1000 } );
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
