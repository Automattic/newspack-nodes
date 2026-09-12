describe( 'station entrypoint', () => {
	afterEach( () => {
		document.body.innerHTML = '';
		jest.resetModules();
		jest.dontMock( '@wordpress/element' );
		jest.dontMock( '../Station' );
	} );

	it( 'mounts Station when the station root exists', () => {
		const render = jest.fn();
		const createRoot = jest.fn( () => ( { render } ) );
		document.body.innerHTML = '<div id="newspack-nodes-station"></div>';

		jest.doMock( '@wordpress/element', () => ( {
			...jest.requireActual( '@wordpress/element' ),
			createRoot,
		} ) );
		jest.doMock( '../Station', () => ( {
			__esModule: true,
			default: function MockStation() {
				return null;
			},
		} ) );

		jest.isolateModules( () => {
			require( '../index' );
		} );

		expect( createRoot ).toHaveBeenCalledWith(
			document.getElementById( 'newspack-nodes-station' )
		);
		expect( render ).toHaveBeenCalledTimes( 1 );
	} );
} );
