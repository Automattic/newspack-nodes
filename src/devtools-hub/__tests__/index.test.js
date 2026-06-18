describe( 'devtools-hub entrypoint', () => {
	afterEach( () => {
		document.body.innerHTML = '';
		jest.resetModules();
		jest.dontMock( '@wordpress/element' );
		jest.dontMock( '../DevToolsHub' );
	} );

	it( 'mounts DevToolsHub when the hub root exists', () => {
		const render = jest.fn();
		const createRoot = jest.fn( () => ( { render } ) );
		document.body.innerHTML = '<div id="newspack-nodes-hub"></div>';

		jest.doMock( '@wordpress/element', () => ( {
			...jest.requireActual( '@wordpress/element' ),
			createRoot,
		} ) );
		jest.doMock( '../DevToolsHub', () => ( {
			__esModule: true,
			default: function MockDevToolsHub() {
				return null;
			},
		} ) );

		jest.isolateModules( () => {
			require( '../index' );
		} );

		expect( createRoot ).toHaveBeenCalledWith(
			document.getElementById( 'newspack-nodes-hub' )
		);
		expect( render ).toHaveBeenCalledTimes( 1 );
	} );
} );
