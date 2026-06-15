/**
 * topology-console/index — the standalone console page was removed in 5b; the
 * Console is a hub tab now. The bundle entry's only job is to register that tab
 * when it loads (no standalone createRoot mount, no DOMContentLoaded wiring).
 */

jest.mock( '../TopologyConsole', () => () => null );

describe( 'topology-console/index', () => {
	let createRootMock;

	beforeEach( () => {
		jest.resetModules();
		createRootMock = jest.fn();
		jest.doMock( '@wordpress/element', () => {
			const actual = jest.requireActual( '@wordpress/element' );
			return { ...actual, createRoot: createRootMock };
		} );
		while ( document.body.firstChild ) {
			document.body.firstChild.remove();
		}
	} );

	it( 'registers the console hub tab on import (so the bundle self-registers)', () => {
		const {
			getDevtoolsTabs,
			resetDevtoolsTabs,
		} = require( '../../shared/devtools/tabRegistry' );
		resetDevtoolsTabs();
		require( '../index' );
		const tab = getDevtoolsTabs( 'hub' ).find(
			( t ) => t.id === 'topology-console'
		);
		expect( tab ).toBeTruthy();
		expect( tab.host ).toBe( 'hub' );
	} );

	it( 'does not mount a standalone root (the console is a hub tab now)', () => {
		const root = document.createElement( 'div' );
		root.id = 'newspack-nodes-topology-console';
		document.body.appendChild( root );
		require( '../index' );
		document.dispatchEvent( new Event( 'DOMContentLoaded' ) );
		expect( createRootMock ).not.toHaveBeenCalled();
	} );
} );
