/**
 * event-aggregator/index — registers the Aggregator hub DevTools tab
 * (side-effect import of `./tabs`) and mounts no standalone React tree. The
 * former ELN createRoot status-page mount is gone — Aggregator is a hub tab
 * now, so the entry must never call createRoot regardless of stray DOM nodes.
 * Mirrors vault/__tests__/index.test.js.
 */

describe( 'event-aggregator/index', () => {
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

	it( 'does not mount anything on a stray #event-aggregator-status container', () => {
		const mount = document.createElement( 'div' );
		mount.id = 'event-aggregator-status';
		document.body.appendChild( mount );
		require( '../index' );
		expect( createRootMock ).not.toHaveBeenCalled();
	} );

	it( 'registers the aggregator hub tab as a side effect of importing', () => {
		require( '../index' );
		const {
			getDevtoolsTabs,
		} = require( '../../shared/devtools/tabRegistry' );
		const tab = getDevtoolsTabs( 'hub' ).find(
			( t ) => t.id === 'aggregator'
		);
		expect( tab ).toBeTruthy();
	} );
} );
