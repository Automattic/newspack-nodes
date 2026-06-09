import withViewTransition from '../withViewTransition';

describe( 'withViewTransition', () => {
	const original = document.startViewTransition;

	afterEach( () => {
		document.startViewTransition = original;
	} );

	it( 'runs the update through startViewTransition when the API exists', () => {
		const ran = [];
		document.startViewTransition = jest.fn( ( cb ) => {
			ran.push( 'transition' );
			cb();
			return { finished: Promise.resolve() };
		} );

		withViewTransition( () => ran.push( 'update' ) );

		expect( document.startViewTransition ).toHaveBeenCalledTimes( 1 );
		expect( ran ).toEqual( [ 'transition', 'update' ] );
	} );

	it( 'falls back to calling the update directly when the API is absent', () => {
		delete document.startViewTransition;
		const update = jest.fn();

		withViewTransition( update );

		expect( update ).toHaveBeenCalledTimes( 1 );
	} );
} );
