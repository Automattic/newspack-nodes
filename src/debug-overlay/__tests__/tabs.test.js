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

	it( 'registers Overview as the default (first) overlay tab, then Inspector', () => {
		require( '../tabs/index.js' );
		const overlayTabs = getDevtoolsTabs( 'overlay' );
		expect( overlayTabs.map( ( t ) => t.id ) ).toEqual( [
			'overview',
			'inspector',
		] );
		expect( overlayTabs.map( ( t ) => t.label ) ).toEqual( [
			'Overview',
			'Inspector',
		] );
	} );

	it( 'gives Overview its own full-bleed chrome (fixed header + scrolling body)', () => {
		require( '../tabs/index.js' );
		const overview = getDevtoolsTabs( 'overlay' ).find(
			( t ) => t.id === 'overview'
		);
		expect( overview ).toBeDefined();
		expect( overview.fullBleed ).toBe( true );
	} );
} );
