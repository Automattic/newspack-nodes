/**
 * topology-console/index — mounts TopologyConsole on the admin page's
 * #event-logger-topology-console root once the DOM is ready.
 */

jest.mock( '../TopologyConsole', () => () => null );

describe( 'topology-console/index', () => {
	let createRootMock;
	let renderMock;

	beforeEach( () => {
		jest.resetModules();
		renderMock = jest.fn();
		createRootMock = jest.fn().mockReturnValue( { render: renderMock } );
		jest.doMock( '@wordpress/element', () => {
			const actual = jest.requireActual( '@wordpress/element' );
			return { ...actual, createRoot: createRootMock };
		} );
		while ( document.body.firstChild ) {
			document.body.firstChild.remove();
		}
	} );

	it( 'mounts TopologyConsole on #event-logger-topology-console when present', () => {
		Object.defineProperty( document, 'readyState', {
			configurable: true,
			get: () => 'complete',
		} );
		const root = document.createElement( 'div' );
		root.id = 'event-logger-topology-console';
		document.body.appendChild( root );
		require( '../index' );
		expect( createRootMock ).toHaveBeenCalledWith( root );
		expect( renderMock ).toHaveBeenCalled();
	} );

	it( 'is a no-op when the mount root is absent', () => {
		Object.defineProperty( document, 'readyState', {
			configurable: true,
			get: () => 'complete',
		} );
		require( '../index' );
		expect( createRootMock ).not.toHaveBeenCalled();
	} );

	it( 'attaches a DOMContentLoaded listener when document is still loading', () => {
		Object.defineProperty( document, 'readyState', {
			configurable: true,
			get: () => 'loading',
		} );
		const root = document.createElement( 'div' );
		root.id = 'event-logger-topology-console';
		document.body.appendChild( root );
		require( '../index' );
		// Nothing mounted yet; firing DOMContentLoaded triggers mount.
		expect( createRootMock ).not.toHaveBeenCalled();
		document.dispatchEvent( new Event( 'DOMContentLoaded' ) );
		expect( createRootMock ).toHaveBeenCalledWith( root );
	} );
} );
