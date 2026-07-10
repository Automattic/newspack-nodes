/**
 * replCeilingFromAppHeight — derives the REPL transcript's max height from the
 * measured `.topology-app` grid height. The console grid is `1fr 38px` (canvas
 * / repl-bar): the console's header moved up to the shared hub header above the
 * tabs, so the grid no longer reserves a header row (the old collapsed 0-height
 * `header` track has been removed). The transcript fills the canvas row, so the
 * ceiling is appHeight − repl-bar (38) − resize-handle overhang (4). Subtracting
 * a 64px header here was the bug that stranded the transcript 64px below the tab
 * bar.
 */

import fs from 'fs';
import path from 'path';
import { replCeilingFromAppHeight } from '../TopologyConsole';

describe( 'replCeilingFromAppHeight', () => {
	it( 'returns null before layout (height 0) so ReplFooter keeps its fallback', () => {
		expect( replCeilingFromAppHeight( 0 ) ).toBeNull();
		expect( replCeilingFromAppHeight( undefined ) ).toBeNull();
		expect( replCeilingFromAppHeight( -5 ) ).toBeNull();
	} );

	it( 'subtracts the repl bar (38) and a small resize-handle overhang from the app height (NOT the old 64px header row)', () => {
		// Assert the shape (bar + a few px reserve), not the magic number.
		const c = replCeilingFromAppHeight( 916 );
		expect( c ).toBeLessThanOrEqual( 916 - 38 );
		expect( c ).toBeGreaterThan( 916 - 38 - 12 );
	} );

	it( 'floors at 80px so the transcript never collapses on a tiny console', () => {
		expect( replCeilingFromAppHeight( 100 ) ).toBe( 80 );
	} );
} );

describe( 'console grid (graph-view.scss)', () => {
	const scss = fs.readFileSync(
		path.join( __dirname, '..', 'styles', 'graph-view.scss' ),
		'utf8'
	);

	it( 'reserves no dead 0-height header row (the header moved to the hub)', () => {
		// No grid-template-rows leads with a collapsed `0` header track,
		expect( scss ).not.toMatch( /grid-template-rows:\s*0\s/ );
		// no `header` grid-area survives in any grid-template-areas (2/3-col),
		expect( scss ).not.toMatch( /"header\s+header/ );
		// and nothing claims the dead area.
		expect( scss ).not.toMatch( /grid-area:\s*header\s*;/ );
	} );
} );
