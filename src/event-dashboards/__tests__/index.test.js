/**
 * event-dashboards/index — mounts WorkerStatusPage / RawLogsPage at
 * their respective DOM nodes. Test the side-effecting mount behavior
 * by stubbing createRoot before importing index.
 */

jest.mock( '../WorkerStatusPage', () => () => null );
jest.mock( '../RawLogsPage', () => () => null );

describe( 'event-dashboards/index', () => {
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

	it( 'mounts WorkerStatusPage on #newspack-nodes-workers when present', () => {
		const mount = document.createElement( 'div' );
		mount.id = 'newspack-nodes-workers';
		document.body.appendChild( mount );
		require( '../index' );
		expect( createRootMock ).toHaveBeenCalledWith( mount );
		expect( renderMock ).toHaveBeenCalled();
	} );

	it( 'mounts RawLogsPage on #newspack-nodes-rawlogs when present', () => {
		const mount = document.createElement( 'div' );
		mount.id = 'newspack-nodes-rawlogs';
		document.body.appendChild( mount );
		require( '../index' );
		expect( createRootMock ).toHaveBeenCalledWith( mount );
		expect( renderMock ).toHaveBeenCalled();
	} );

	it( 'skips mount when neither container exists', () => {
		require( '../index' );
		expect( createRootMock ).not.toHaveBeenCalled();
	} );
} );
