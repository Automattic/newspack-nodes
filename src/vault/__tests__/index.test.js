/**
 * vault/index — registers the Vault hub DevTools tab (side-effect import of
 * `./tabs`) and mounts no standalone React tree. The former ELN createRoot
 * settings-page mount is gone — Vault is a hub tab now, so the entry must never
 * call createRoot regardless of stray DOM nodes.
 */

describe( 'vault/index', () => {
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

	it( 'does not mount anything on a stray #event-aggregator-servers container', () => {
		const mount = document.createElement( 'div' );
		mount.id = 'event-aggregator-servers';
		document.body.appendChild( mount );
		require( '../index' );
		expect( createRootMock ).not.toHaveBeenCalled();
	} );

	it( 'registers the vault hub tab as a side effect of importing', () => {
		require( '../index' );
		const {
			getDevtoolsTabs,
		} = require( '../../shared/devtools/tabRegistry' );
		const tab = getDevtoolsTabs( 'hub' ).find( ( t ) => t.id === 'vault' );
		expect( tab ).toBeTruthy();
	} );
} );
