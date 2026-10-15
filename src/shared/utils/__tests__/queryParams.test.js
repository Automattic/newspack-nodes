import {
	getQueryParam,
	getQueryParams,
	setQueryParam,
	setQueryParams,
} from '../queryParams';

// A user agent holding every character a query string gives meaning to.
const UA = 'ua=Mozilla/5.0 (X11, Linux) a&b+c, d=e';

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
				'/?page=station&tab=raw-logs&log=firehose'
			);
			expect( getQueryParam( 'log' ) ).toBe( 'firehose' );
		} );
	} );

	describe( 'setQueryParam', () => {
		it( 'sets a new param without touching the rest', () => {
			window.history.replaceState( {}, '', '/?page=station' );
			setQueryParam( 'tab', 'console' );
			expect( getQueryParam( 'page' ) ).toBe( 'station' );
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
			window.history.replaceState( {}, '', '/?page=station' );
			replaceSpy.mockClear();
			setQueryParam( 'tab', 'console' );
			expect( replaceSpy ).toHaveBeenCalled();
			expect( pushSpy ).not.toHaveBeenCalled();
			replaceSpy.mockRestore();
			pushSpy.mockRestore();
		} );

		it( 'writes nothing when the URL would not change', () => {
			window.history.replaceState( {}, '', '/?tab=console#graph' );
			const replaceSpy = jest.spyOn( window.history, 'replaceState' );
			setQueryParam( 'tab', 'console' );
			setQueryParam( 'log', null );
			expect( replaceSpy ).not.toHaveBeenCalled();
			replaceSpy.mockRestore();
		} );

		it( 'keeps the history entry state it replaces', () => {
			window.history.replaceState( { pane: 7 }, '', '/?page=station' );
			setQueryParam( 'tab', 'console' );
			expect( window.history.state ).toEqual( { pane: 7 } );
		} );
	} );

	describe( 'setQueryParams', () => {
		it( 'sets and removes several params in one write, keeping the rest', () => {
			window.history.replaceState(
				{},
				'',
				'/wp-admin/admin.php?page=perf&search=r9&q=feed#top'
			);
			const replaceSpy = jest.spyOn( window.history, 'replaceState' );
			setQueryParams( { search: null, url: 'h1', request: 'r9' } );
			expect( replaceSpy ).toHaveBeenCalledTimes( 1 );
			expect( window.location.pathname ).toBe( '/wp-admin/admin.php' );
			expect( window.location.search ).toBe(
				'?page=perf&q=feed&url=h1&request=r9'
			);
			expect( window.location.hash ).toBe( '#top' );
			replaceSpy.mockRestore();
		} );

		it( 'pushes a history entry when asked to', () => {
			window.history.replaceState( {}, '', '/?page=perf' );
			const pushSpy = jest.spyOn( window.history, 'pushState' );
			const replaceSpy = jest.spyOn( window.history, 'replaceState' );
			setQueryParams( { url: 'h1' }, { push: true } );
			expect( pushSpy ).toHaveBeenCalledTimes( 1 );
			expect( replaceSpy ).not.toHaveBeenCalled();
			expect( getQueryParam( 'url' ) ).toBe( 'h1' );
			pushSpy.mockRestore();
			replaceSpy.mockRestore();
		} );

		it( 'pushes nothing when the URL would not change', () => {
			window.history.replaceState( {}, '', '/?page=perf&url=h1' );
			const pushSpy = jest.spyOn( window.history, 'pushState' );
			setQueryParams( { url: 'h1', request: null }, { push: true } );
			expect( pushSpy ).not.toHaveBeenCalled();
			pushSpy.mockRestore();
		} );
	} );
	describe( 'getQueryParams', () => {
		it( 'returns every value of a repeated param, in order', () => {
			window.history.replaceState(
				{},
				'',
				`/?chip=status_class%3D5xx&page=perf&chip=${ encodeURIComponent(
					UA
				) }`
			);
			expect( getQueryParams( 'chip' ) ).toEqual( [
				'status_class=5xx',
				UA,
			] );
		} );

		it( 'returns an empty list for an absent param', () => {
			window.history.replaceState( {}, '', '/?page=perf' );
			expect( getQueryParams( 'chip' ) ).toEqual( [] );
		} );
	} );

	describe( 'setQueryParams with a list', () => {
		it( 'writes one repeated key per entry, a comma intact', () => {
			window.history.replaceState(
				{},
				'',
				'/?page=perf&chip=old%3D1&url=h1#top'
			);
			setQueryParams( {
				chip: [ 'status_class=5xx', UA ],
			} );
			expect( getQueryParams( 'chip' ) ).toEqual( [
				'status_class=5xx',
				UA,
			] );
			expect( getQueryParam( 'page' ) ).toBe( 'perf' );
			expect( getQueryParam( 'url' ) ).toBe( 'h1' );
			expect( window.location.hash ).toBe( '#top' );
		} );

		it( 'removes the param for an empty list', () => {
			window.history.replaceState(
				{},
				'',
				'/?page=perf&chip=a%3D1&chip=b%3D2'
			);
			setQueryParams( { chip: [] } );
			expect( window.location.search ).toBe( '?page=perf' );
		} );

		it( 'skips an empty entry, as an empty scalar removes the param', () => {
			window.history.replaceState( {}, '', '/?page=perf&url=h1' );
			setQueryParams( { chip: [ 'method=PURGE', '', 'worker=3' ] } );
			expect( getQueryParams( 'chip' ) ).toEqual( [
				'method=PURGE',
				'worker=3',
			] );

			setQueryParams( { chip: [ '' ] } );
			expect( window.location.search ).toBe( '?page=perf&url=h1' );
		} );

		it( 'writes nothing when the list is already there', () => {
			window.history.replaceState(
				{},
				'',
				'/?chip=a%3D1&page=perf&chip=b%3D2'
			);
			const replaceSpy = jest.spyOn( window.history, 'replaceState' );
			setQueryParams( { chip: [ 'a=1', 'b=2' ] } );
			expect( replaceSpy ).not.toHaveBeenCalled();
			replaceSpy.mockRestore();
		} );
	} );
} );
