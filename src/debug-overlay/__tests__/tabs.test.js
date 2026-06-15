import {
	getDevtoolsTabs,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';

describe( 'debug-overlay tab registration', () => {
	beforeEach( () => {
		resetDevtoolsTabs();
		jest.resetModules();
	} );

	it( 'registers the inspector as a full-bleed overlay tab so the host gives it is-full-bleed, not the scroll wrapper', () => {
		// Import for its side effect (registerDevtoolsTab at import time).
		require( '../tabs/index.js' );
		const overlayTabs = getDevtoolsTabs( 'overlay' );
		const inspector = overlayTabs.find( ( t ) => t.id === 'inspector' );
		expect( inspector ).toBeDefined();
		// The inspector is a self-managed full-height graph canvas — it must opt
		// out of the host's default scroll container.
		expect( inspector.fullBleed ).toBe( true );
	} );
} );
