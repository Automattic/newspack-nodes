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
			'io-overview',
			'inspector',
		] );
		expect( overlayTabs.map( ( t ) => t.label ) ).toEqual( [
			'Overview',
			'Inspector',
		] );
	} );

	it( 'does NOT collide with the hub Overview tab id in the shared registry', () => {
		// Both bundles load on the hub page; the registry is keyed by id and
		// shadows across hosts, so the overlay Overview must NOT reuse the hub
		// Overview's `overview` id (that would clobber one of them).
		require( '../../event-dashboards/tabs' ); // hub Overview, id 'overview'
		require( '../tabs/index.js' ); // overlay tabs
		const hubOverview = getDevtoolsTabs( 'hub' ).find(
			( t ) => t.id === 'overview'
		);
		expect( hubOverview ).toBeDefined();
		expect( hubOverview.host ).toBe( 'hub' );
		expect(
			getDevtoolsTabs( 'overlay' ).find( ( t ) => t.label === 'Overview' )
		).toBeDefined();
	} );

	it( 'gives Overview its own full-bleed chrome (fixed header + scrolling body)', () => {
		require( '../tabs/index.js' );
		const overview = getDevtoolsTabs( 'overlay' ).find(
			( t ) => t.id === 'io-overview'
		);
		expect( overview ).toBeDefined();
		expect( overview.fullBleed ).toBe( true );
	} );
} );
