/**
 * replCeilingFromAppHeight — derives the REPL transcript's max height from the
 * measured `.topology-app` grid height. The console grid is `0 1fr 38px` (a
 * collapsed header row / canvas / repl-bar): the console's header moved up to
 * the shared hub header above the tabs, so the canvas frame no longer reserves
 * a header row. The transcript fills the canvas row, so the ceiling is
 * appHeight − repl-bar (38) − resize-handle overhang (4). Subtracting a 64px
 * header here (when the row is 0) was the bug that stranded the transcript 64px
 * below the tab bar.
 */

import { replCeilingFromAppHeight } from '../TopologyConsole';

describe( 'replCeilingFromAppHeight', () => {
	it( 'returns null before layout (height 0) so ReplFooter keeps its fallback', () => {
		expect( replCeilingFromAppHeight( 0 ) ).toBeNull();
		expect( replCeilingFromAppHeight( undefined ) ).toBeNull();
		expect( replCeilingFromAppHeight( -5 ) ).toBeNull();
	} );

	it( 'subtracts the repl bar (38) and a small resize-handle overhang from the app height (NOT the old 64px header row)', () => {
		// The exact handle reserve is a small tuning knob (currently 0 — the
		// console measures its frame exactly); assert the shape — bar + 0..a few px
		// of handle reserve — not the magic number, and crucially NOT the stale
		// −64 header that stranded the transcript.
		const c = replCeilingFromAppHeight( 916 );
		expect( c ).toBeLessThanOrEqual( 916 - 38 );
		expect( c ).toBeGreaterThan( 916 - 38 - 12 );
	} );

	it( 'floors at 80px so the transcript never collapses on a tiny console', () => {
		expect( replCeilingFromAppHeight( 100 ) ).toBe( 80 );
	} );
} );
