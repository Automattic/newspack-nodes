/**
 * replCeilingFromAppHeight — derives the REPL transcript's max height from the
 * measured `.topology-app` grid height. The console grid is `64px 1fr 38px`
 * (header / canvas / repl-bar), so the transcript may fill the canvas row only:
 * appHeight − header − bar. This is what keeps the transcript from overshooting
 * the canvas now that the console lives inside the DevtoolsTabHost tab bar (the
 * old window-based ceiling didn't subtract that bar).
 */

import { replCeilingFromAppHeight } from '../TopologyConsole';

describe( 'replCeilingFromAppHeight', () => {
	it( 'returns null before layout (height 0) so ReplFooter keeps its fallback', () => {
		expect( replCeilingFromAppHeight( 0 ) ).toBeNull();
		expect( replCeilingFromAppHeight( undefined ) ).toBeNull();
		expect( replCeilingFromAppHeight( -5 ) ).toBeNull();
	} );

	it( 'subtracts the header (64) and repl bar (38) rows from the app height', () => {
		// 916px app → 814px canvas row (matches the measured live console).
		expect( replCeilingFromAppHeight( 916 ) ).toBe( 814 );
	} );

	it( 'floors at 80px so the transcript never collapses on a tiny console', () => {
		expect( replCeilingFromAppHeight( 100 ) ).toBe( 80 );
	} );
} );
