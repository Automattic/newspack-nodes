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

	it( 'registers Overview as the default (first) overlay tab, then Console, Logs, Runtime', () => {
		require( '../tabs/index.js' );
		const overlayTabs = getDevtoolsTabs( 'overlay' );
		expect( overlayTabs.map( ( t ) => t.id ) ).toEqual( [
			'io-overview',
			'console',
			'logs',
			'runtime',
		] );
		expect( overlayTabs.map( ( t ) => t.label ) ).toEqual( [
			'Overview',
			'Console',
			'Logs',
			'Runtime',
		] );
	} );

	it( 'registers Runtime as a host:both tab (order 45) — last in both the overlay and the hub', () => {
		require( '../tabs/index.js' );
		require( '../../event-dashboards/tabs' ); // hub tabs, so we can check hub ordering
		const overlay = getDevtoolsTabs( 'overlay' );
		const hub = getDevtoolsTabs( 'hub' );
		const runtime = overlay.find( ( t ) => t.id === 'runtime' );
		expect( runtime ).toBeDefined();
		expect( runtime.host ).toBe( 'both' );
		expect( runtime.order ).toBe( 45 );
		// The one order value lands it last in the overlay AND the hub list.
		expect( overlay[ overlay.length - 1 ].id ).toBe( 'runtime' );
		expect( hub[ hub.length - 1 ].id ).toBe( 'runtime' );
	} );

	it( 'registers Logs after Console (order 3) as a full-bleed tab', () => {
		require( '../tabs/index.js' );
		const logs = getDevtoolsTabs( 'overlay' ).find(
			( t ) => t.id === 'logs'
		);
		expect( logs ).toBeDefined();
		expect( logs.order ).toBe( 3 );
		expect( logs.fullBleed ).toBe( true );
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
