import { getQueryParam, setQueryParam } from '../queryParams';

describe( 'queryParams', () => {
	beforeEach( () => {
		window.history.replaceState( {}, '', '/' );
	} );

	describe( 'getQueryParam', () => {
		it( 'returns the value of a present param', () => {
			window.history.replaceState( {}, '', '/?tab=console' );
			expect( getQueryParam( 'tab' ) ).toBe( 'console' );
		} );

		it( 'returns null for an absent param', () => {
			window.history.replaceState( {}, '', '/?tab=console' );
			expect( getQueryParam( 'log' ) ).toBeNull();
		} );

		it( 'returns null when there is no query string', () => {
			expect( getQueryParam( 'tab' ) ).toBeNull();
		} );

		it( 'reads the right value among several params', () => {
			window.history.replaceState(
				{},
				'',
				'/?page=hub&tab=raw-logs&log=firehose'
			);
			expect( getQueryParam( 'log' ) ).toBe( 'firehose' );
		} );
	} );

	describe( 'setQueryParam', () => {
		it( 'sets a new param without touching the rest', () => {
			window.history.replaceState( {}, '', '/?page=hub' );
			setQueryParam( 'tab', 'console' );
			expect( getQueryParam( 'page' ) ).toBe( 'hub' );
			expect( getQueryParam( 'tab' ) ).toBe( 'console' );
		} );

		it( 'updates an existing param in place', () => {
			window.history.replaceState( {}, '', '/?tab=console&log=x' );
			setQueryParam( 'tab', 'topologies' );
			expect( getQueryParam( 'tab' ) ).toBe( 'topologies' );
			expect( getQueryParam( 'log' ) ).toBe( 'x' );
		} );

		it( 'removes the param when the value is null', () => {
			window.history.replaceState( {}, '', '/?tab=console&log=x' );
			setQueryParam( 'log', null );
			expect( getQueryParam( 'log' ) ).toBeNull();
			expect( getQueryParam( 'tab' ) ).toBe( 'console' );
		} );

		it( 'removes the param when the value is the empty string', () => {
			window.history.replaceState( {}, '', '/?tab=console&log=x' );
			setQueryParam( 'log', '' );
			expect( getQueryParam( 'log' ) ).toBeNull();
		} );

		it( 'uses history.replaceState (not pushState)', () => {
			const replaceSpy = jest.spyOn( window.history, 'replaceState' );
			const pushSpy = jest.spyOn( window.history, 'pushState' );
			window.history.replaceState( {}, '', '/?page=hub' );
			replaceSpy.mockClear();
			setQueryParam( 'tab', 'console' );
			expect( replaceSpy ).toHaveBeenCalled();
			expect( pushSpy ).not.toHaveBeenCalled();
			replaceSpy.mockRestore();
			pushSpy.mockRestore();
		} );
	} );
} );
