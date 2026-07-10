import {
	getDevtoolsTabs,
	resetDevtoolsTabs,
} from '@newspack-nodes/shared/devtools/tabRegistry';

describe( 'debug-overlay tab registration', () => {
	beforeEach( () => {
		resetDevtoolsTabs();
		jest.resetModules();
	} );

	it( 'registers the Console tab as full-bleed so the host gives it is-full-bleed, not the scroll wrapper', () => {
		// Import for its side effect (registerDevtoolsTab at import time).
		require( '../tabs/index.js' );
		const overlayTabs = getDevtoolsTabs( 'overlay' );
		const console = overlayTabs.find( ( t ) => t.id === 'console' );
		expect( console ).toBeDefined();
		// Console is a self-managed full-height canvas; it opts out of scroll.
		expect( console.fullBleed ).toBe( true );
	} );

	it( 'registers Overview as the default (first) overlay tab, then Console', () => {
		require( '../tabs/index.js' );
		const overlayTabs = getDevtoolsTabs( 'overlay' );
		expect( overlayTabs.map( ( t ) => t.id ) ).toEqual( [
			'io-overview',
			'console',
		] );
		expect( overlayTabs.map( ( t ) => t.label ) ).toEqual( [
			'Overview',
			'Console',
		] );
	} );

	it( 'does NOT collide with the hub Overview tab id in the shared registry', () => {
		// Registry is keyed by id; overlay Overview must not reuse 'overview'.
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
