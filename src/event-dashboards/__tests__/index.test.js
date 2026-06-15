/**
 * event-dashboards/index — registers the hub DevTools tabs (side-effect import
 * of `./tabs`) and mounts no standalone React tree. Raw Logs is now a hub tab,
 * so the former `#newspack-nodes-rawlogs` standalone mount is gone. Assert the
 * entry never calls createRoot regardless of stray DOM nodes.
 */

describe( 'event-dashboards/index', () => {
	let createRootMock;

	beforeEach( () => {
		jest.resetModules();
		createRootMock = jest.fn().mockReturnValue( { render: jest.fn() } );
		jest.doMock( '@wordpress/element', () => {
			const actual = jest.requireActual( '@wordpress/element' );
			return { ...actual, createRoot: createRootMock };
		} );
		while ( document.body.firstChild ) {
			document.body.firstChild.remove();
		}
	} );

	it( 'does not mount anything on the removed #newspack-nodes-rawlogs container', () => {
		const mount = document.createElement( 'div' );
		mount.id = 'newspack-nodes-rawlogs';
		document.body.appendChild( mount );
		require( '../index' );
		expect( createRootMock ).not.toHaveBeenCalled();
	} );

	it( 'does not mount anything on the removed #newspack-nodes-workers container', () => {
		const mount = document.createElement( 'div' );
		mount.id = 'newspack-nodes-workers';
		document.body.appendChild( mount );
		require( '../index' );
		expect( createRootMock ).not.toHaveBeenCalled();
	} );

	it( 'registers the raw-logs hub tab as a side effect of importing', () => {
		require( '../index' );
		const {
			getDevtoolsTabs,
		} = require( '../../shared/devtools/tabRegistry' );
		const tab = getDevtoolsTabs( 'hub' ).find(
			( t ) => t.id === 'raw-logs'
		);
		expect( tab ).toBeTruthy();
	} );
} );
