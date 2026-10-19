/* global PopStateEvent */
/**
 * useQueryParamState tests — dashboard state mirrored into one `?param=`.
 *
 * The bar must name the view: seeded from it on mount, rewritten on every
 * change with replaceState, a default or an unusable value left out, and
 * re-asserted when Back/Forward restores an entry written before the change.
 * A choice whose list arrives late trusts the link's value until the list
 * lands, then drops it if the list lacks it.
 */

import {
	useQueryParamState,
	useQueryParamChoice,
	useQueryParamFlag,
	useQueryParamList,
} from '../useQueryParamState';
import { renderHook, act } from '@testing-library/react';

const METRICS = [ 'volume', 'avg', 'cumulative', 'memory' ];

function setLocation( href ) {
	window.history.replaceState( null, '', href );
}

const param = ( name ) =>
	new URLSearchParams( window.location.search ).get( name );

const params = ( name ) =>
	new URLSearchParams( window.location.search ).getAll( name );

describe( 'useQueryParamChoice', () => {
	let pushSpy;

	beforeEach( () => {
		setLocation( 'http://localhost/wp-admin/admin.php?page=perf' );
		pushSpy = jest.spyOn( window.history, 'pushState' );
	} );

	afterEach( () => {
		pushSpy.mockRestore();
	} );

	it( 'seeds from a value the list offers', () => {
		setLocation( '/wp-admin/admin.php?page=perf&metric=memory' );
		const { result, unmount } = renderHook( () =>
			useQueryParamChoice( 'metric', METRICS, 'volume' )
		);
		expect( result.current[ 0 ] ).toBe( 'memory' );
		expect( param( 'metric' ) ).toBe( 'memory' );
		unmount();
	} );

	it( 'ignores a value the list does not offer, and drops it from the bar', () => {
		setLocation( '/wp-admin/admin.php?page=perf&metric=%3Cscript%3E' );
		const { result, unmount } = renderHook( () =>
			useQueryParamChoice( 'metric', METRICS, 'volume' )
		);
		expect( result.current[ 0 ] ).toBe( 'volume' );
		expect( param( 'metric' ) ).toBeNull();
		unmount();
	} );

	it( 'writes a change with replaceState, keeping every other param', () => {
		setLocation( '/wp-admin/admin.php?page=perf&url=abc&request=r1' );
		const { result, unmount } = renderHook( () =>
			useQueryParamChoice( 'metric', METRICS, 'volume' )
		);
		act( () => result.current[ 1 ]( 'cumulative' ) );

		expect( result.current[ 0 ] ).toBe( 'cumulative' );
		expect( param( 'metric' ) ).toBe( 'cumulative' );
		expect( param( 'url' ) ).toBe( 'abc' );
		expect( param( 'request' ) ).toBe( 'r1' );
		expect( param( 'page' ) ).toBe( 'perf' );
		expect( pushSpy ).not.toHaveBeenCalled();
		unmount();
	} );

	it( 'removes the param when the choice returns to its default', () => {
		setLocation( '/wp-admin/admin.php?page=perf&metric=avg' );
		const { result, unmount } = renderHook( () =>
			useQueryParamChoice( 'metric', METRICS, 'volume' )
		);
		act( () => result.current[ 1 ]( 'volume' ) );

		expect( param( 'metric' ) ).toBeNull();
		expect( window.location.search ).toBe( '?page=perf' );
		unmount();
	} );

	it( 'leaves a bare link bare', () => {
		const { unmount } = renderHook( () =>
			useQueryParamChoice( 'metric', METRICS, 'volume' )
		);
		expect( window.location.search ).toBe( '?page=perf' );
		unmount();
	} );

	it( 'puts the live value back over an entry Back restored', () => {
		const { result, unmount } = renderHook( () =>
			useQueryParamChoice( 'metric', METRICS, 'volume' )
		);
		act( () => result.current[ 1 ]( 'memory' ) );

		// The restored entry predates the change, and names another metric.
		setLocation( '/wp-admin/admin.php?page=perf&metric=avg&url=abc' );
		act( () => {
			window.dispatchEvent( new PopStateEvent( 'popstate' ) );
		} );

		expect( result.current[ 0 ] ).toBe( 'memory' );
		expect( param( 'metric' ) ).toBe( 'memory' );
		expect( param( 'url' ) ).toBe( 'abc' );
		unmount();
	} );

	it( 'stops answering popstate once unmounted', () => {
		const { result, unmount } = renderHook( () =>
			useQueryParamChoice( 'metric', METRICS, 'volume' )
		);
		act( () => result.current[ 1 ]( 'memory' ) );
		unmount();

		setLocation( '/wp-admin/admin.php?page=perf&metric=avg' );
		window.dispatchEvent( new PopStateEvent( 'popstate' ) );

		expect( param( 'metric' ) ).toBe( 'avg' );
	} );
} );

describe( 'useQueryParamChoice with a list that arrives late', () => {
	const mount = () =>
		renderHook(
			( { values } ) => useQueryParamChoice( 'server', values, '' ),
			{ initialProps: { values: null } }
		);

	beforeEach( () => {
		setLocation( '/wp-admin/admin.php?page=perf&server=edge-02&url=h1' );
	} );

	it( 'answers the linked value until the list can judge it', () => {
		const { result } = mount();
		expect( result.current[ 0 ] ).toBe( 'edge-02' );
		expect( param( 'server' ) ).toBe( 'edge-02' );
	} );

	it( 'answers the linked value once the list holds it', () => {
		const { result, rerender } = mount();
		rerender( { values: [ 'edge-01', 'edge-02' ] } );
		expect( result.current[ 0 ] ).toBe( 'edge-02' );
		expect( param( 'server' ) ).toBe( 'edge-02' );
	} );

	it( 'drops a linked value the landed list lacks, bar and all', () => {
		const { result, rerender } = mount();
		rerender( { values: [ 'edge-01', 'edge-03' ] } );
		expect( result.current[ 0 ] ).toBe( '' );
		expect( window.location.search ).toBe( '?page=perf&url=h1' );
	} );

	it( 'trusts the link while the landed list is empty', () => {
		const { result, rerender } = mount();
		rerender( { values: [] } );
		expect( result.current[ 0 ] ).toBe( 'edge-02' );
		expect( param( 'server' ) ).toBe( 'edge-02' );
	} );

	it( 'keeps the unjudged link over an entry Back restored', () => {
		mount();
		setLocation( '/wp-admin/admin.php?page=perf&server=edge-01' );
		act( () => {
			window.dispatchEvent( new PopStateEvent( 'popstate' ) );
		} );
		expect( param( 'server' ) ).toBe( 'edge-02' );
	} );

	it( 'writes a pick made once the list has landed', () => {
		const { result, rerender } = mount();
		rerender( { values: [ 'edge-01', 'edge-02' ] } );
		act( () => result.current[ 1 ]( 'edge-01' ) );
		expect( result.current[ 0 ] ).toBe( 'edge-01' );
		expect( param( 'server' ) ).toBe( 'edge-01' );
	} );
} );

describe( 'useQueryParamFlag', () => {
	beforeEach( () => {
		setLocation( '/wp-admin/admin.php?page=perf' );
	} );

	it( 'seeds on from 1', () => {
		setLocation( '/wp-admin/admin.php?page=perf&errors=1' );
		const { result, unmount } = renderHook( () =>
			useQueryParamFlag( 'errors' )
		);
		expect( result.current[ 0 ] ).toBe( true );
		unmount();
	} );

	it( 'ignores any other value', () => {
		setLocation( '/wp-admin/admin.php?page=perf&errors=yes' );
		const { result, unmount } = renderHook( () =>
			useQueryParamFlag( 'errors' )
		);
		expect( result.current[ 0 ] ).toBe( false );
		expect( param( 'errors' ) ).toBeNull();
		unmount();
	} );

	it( 'writes on as 1 and drops the param when off', () => {
		const { result, unmount } = renderHook( () =>
			useQueryParamFlag( 'workers' )
		);
		act( () => result.current[ 1 ]( true ) );
		expect( param( 'workers' ) ).toBe( '1' );

		act( () => result.current[ 1 ]( false ) );
		expect( param( 'workers' ) ).toBeNull();
		unmount();
	} );
} );

describe( 'useQueryParamState', () => {
	const restoreText = ( raw ) => raw ?? '';

	beforeEach( () => {
		setLocation( '/wp-admin/admin.php?page=perf' );
	} );

	it( 'hands restore the raw value, and null when the param is absent', () => {
		const restore = jest.fn( restoreText );
		setLocation( '/wp-admin/admin.php?page=perf&q=wp-cron.php' );
		const { result, unmount } = renderHook( () =>
			useQueryParamState( 'q', restore, String )
		);
		expect( result.current[ 0 ] ).toBe( 'wp-cron.php' );
		expect( restore ).toHaveBeenCalledWith( 'wp-cron.php' );
		unmount();

		setLocation( '/wp-admin/admin.php?page=perf' );
		const absent = renderHook( () =>
			useQueryParamState( 'q', restore, String )
		);
		expect( restore ).toHaveBeenLastCalledWith( null );
		absent.unmount();
	} );

	it( 'writes each change, and an empty value removes the param', () => {
		const replaceSpy = jest.spyOn( window.history, 'replaceState' );
		const { result, unmount } = renderHook( () =>
			useQueryParamState( 'q', restoreText, String )
		);
		replaceSpy.mockClear();

		act( () => result.current[ 1 ]( 'feed' ) );
		expect( param( 'q' ) ).toBe( 'feed' );

		// A re-render that changes nothing writes nothing.
		const writes = replaceSpy.mock.calls.length;
		act( () => result.current[ 1 ]( 'feed' ) );
		expect( replaceSpy.mock.calls.length ).toBe( writes );

		act( () => result.current[ 1 ]( '' ) );
		expect( param( 'q' ) ).toBeNull();
		replaceSpy.mockRestore();
		unmount();
	} );
} );

describe( 'useQueryParamList', () => {
	const UA = 'ua=Mozilla/5.0 (X11, Linux) a&b+c, d=e';
	const keepKnown = ( raw ) => raw.filter( ( v ) => v.includes( '=' ) );
	const asIs = ( list ) => list;

	beforeEach( () => {
		setLocation( '/wp-admin/admin.php?page=perf' );
	} );

	it( 'hands restore every value of the repeated param', () => {
		const restore = jest.fn( keepKnown );
		setLocation(
			'/wp-admin/admin.php?page=perf&chip=status_class%3D5xx&chip=bogus&chip=' +
				encodeURIComponent( UA )
		);
		const { result, unmount } = renderHook( () =>
			useQueryParamList( 'chip', restore, asIs )
		);
		expect( restore ).toHaveBeenCalledWith( [
			'status_class=5xx',
			'bogus',
			UA,
		] );
		expect( result.current[ 0 ] ).toEqual( [ 'status_class=5xx', UA ] );
		// The value restore refused leaves the bar too.
		expect( params( 'chip' ) ).toEqual( [ 'status_class=5xx', UA ] );
		unmount();
	} );

	it( 'round-trips a list holding a comma through the bar', () => {
		const first = renderHook( () =>
			useQueryParamList( 'chip', keepKnown, asIs )
		);
		act( () => first.result.current[ 1 ]( [ 'status_class=5xx', UA ] ) );
		expect( params( 'chip' ) ).toEqual( [ 'status_class=5xx', UA ] );
		first.unmount();

		const second = renderHook( () =>
			useQueryParamList( 'chip', keepKnown, asIs )
		);
		expect( second.result.current[ 0 ] ).toEqual( [
			'status_class=5xx',
			UA,
		] );
		second.unmount();
	} );

	it( 'drops the param for an empty list', () => {
		setLocation( '/wp-admin/admin.php?page=perf&chip=server%3Dedge-02' );
		const { result, unmount } = renderHook( () =>
			useQueryParamList( 'chip', keepKnown, asIs )
		);
		act( () => result.current[ 1 ]( [] ) );
		expect( window.location.search ).toBe( '?page=perf' );
		unmount();
	} );

	it( 'writes on a changed list, never on a fresh array of the same', () => {
		const replaceSpy = jest.spyOn( window.history, 'replaceState' );
		const { result, unmount } = renderHook( () =>
			useQueryParamList( 'chip', keepKnown, asIs )
		);
		act( () => result.current[ 1 ]( [ 'server=edge-02' ] ) );
		const writes = replaceSpy.mock.calls.length;
		act( () => result.current[ 1 ]( [ 'server=edge-02' ] ) );
		expect( replaceSpy.mock.calls.length ).toBe( writes );
		replaceSpy.mockRestore();
		unmount();
	} );

	it( 'puts the live list back over an entry Back restored', () => {
		const { result, unmount } = renderHook( () =>
			useQueryParamList( 'chip', keepKnown, asIs )
		);
		act( () => result.current[ 1 ]( [ UA ] ) );

		setLocation( '/wp-admin/admin.php?page=perf&chip=worker%3D3&url=abc' );
		act( () => {
			window.dispatchEvent( new PopStateEvent( 'popstate' ) );
		} );

		expect( result.current[ 0 ] ).toEqual( [ UA ] );
		expect( params( 'chip' ) ).toEqual( [ UA ] );
		expect( param( 'url' ) ).toBe( 'abc' );
		unmount();
	} );
} );

describe( 'written', () => {
	beforeEach( () => {
		setLocation(
			'/wp-admin/admin.php?page=perf&url_metric=memory&url_bucket=2026-09-29-14-30&url_chip=method%3DPURGE&url_chip=country%3DSG&url_workers=1'
		);
	} );

	const mount = ( hook, written ) =>
		renderHook( ( props ) => hook( props ), {
			initialProps: { written },
		} );

	describe( 'useQueryParamChoice', () => {
		const useChoice = ( props ) =>
			useQueryParamChoice( 'url_metric', METRICS, 'volume', props );

		it( 'holds the linked choice but leaves it off the bar', () => {
			const { result, unmount } = mount( useChoice, false );
			expect( result.current[ 0 ] ).toBe( 'memory' );
			expect( param( 'url_metric' ) ).toBeNull();
			unmount();
		} );

		it( 'still validates the held choice', () => {
			setLocation( '/wp-admin/admin.php?page=perf&url_metric=bogus' );
			const { result, unmount } = mount( useChoice, false );
			expect( result.current[ 0 ] ).toBe( 'volume' );
			unmount();
		} );

		it( 'writes a pick once written, and drops it when unwritten', () => {
			const { result, rerender, unmount } = mount( useChoice, false );
			act( () => result.current[ 1 ]( 'cumulative' ) );
			expect( param( 'url_metric' ) ).toBeNull();

			rerender( { written: true } );
			expect( param( 'url_metric' ) ).toBe( 'cumulative' );

			rerender( { written: false } );
			expect( param( 'url_metric' ) ).toBeNull();
			expect( result.current[ 0 ] ).toBe( 'cumulative' );
			unmount();
		} );
	} );

	describe( 'useQueryParamState', () => {
		const useBucket = ( props ) =>
			useQueryParamState(
				'url_bucket',
				( raw ) => raw ?? '',
				String,
				props
			);

		it( 'holds the linked value but leaves it off the bar', () => {
			const { result, unmount } = mount( useBucket, false );
			expect( result.current[ 0 ] ).toBe( '2026-09-29-14-30' );
			expect( param( 'url_bucket' ) ).toBeNull();
			unmount();
		} );

		it( 'writes the value once written, and drops it when unwritten', () => {
			const { result, rerender, unmount } = mount( useBucket, false );
			act( () => result.current[ 1 ]( '2026-10-04-13-35' ) );
			expect( param( 'url_bucket' ) ).toBeNull();

			rerender( { written: true } );
			expect( param( 'url_bucket' ) ).toBe( '2026-10-04-13-35' );

			rerender( { written: false } );
			expect( param( 'url_bucket' ) ).toBeNull();
			expect( result.current[ 0 ] ).toBe( '2026-10-04-13-35' );
			unmount();
		} );
	} );

	describe( 'useQueryParamList', () => {
		const useChips = ( props ) =>
			useQueryParamList(
				'url_chip',
				( raw ) => raw,
				( l ) => l,
				props
			);

		it( 'holds the linked list but leaves it off the bar', () => {
			const { result, unmount } = mount( useChips, false );
			expect( result.current[ 0 ] ).toEqual( [
				'method=PURGE',
				'country=SG',
			] );
			expect( params( 'url_chip' ) ).toEqual( [] );
			unmount();
		} );

		it( 'writes the list once written, and drops it when unwritten', () => {
			const { result, rerender, unmount } = mount( useChips, false );
			act( () => result.current[ 1 ]( [ 'worker=3' ] ) );
			expect( params( 'url_chip' ) ).toEqual( [] );

			rerender( { written: true } );
			expect( params( 'url_chip' ) ).toEqual( [ 'worker=3' ] );

			rerender( { written: false } );
			expect( params( 'url_chip' ) ).toEqual( [] );
			expect( result.current[ 0 ] ).toEqual( [ 'worker=3' ] );
			unmount();
		} );
	} );

	describe( 'useQueryParamFlag', () => {
		it( 'holds the linked flag off the bar until written', () => {
			const { result, rerender, unmount } = mount(
				( props ) => useQueryParamFlag( 'url_workers', props ),
				false
			);
			expect( result.current[ 0 ] ).toBe( true );
			expect( param( 'url_workers' ) ).toBeNull();

			rerender( { written: true } );
			expect( param( 'url_workers' ) ).toBe( '1' );
			unmount();
		} );
	} );
} );

describe( 'a value naming nothing flipping written', () => {
	it.each( [
		[
			'an empty list',
			( props ) =>
				useQueryParamList(
					'url_chip',
					() => [],
					( l ) => l,
					props
				),
		],
		[
			'a list of empty entries',
			( props ) =>
				useQueryParamList(
					'url_chip',
					() => [ '' ],
					( l ) => l,
					props
				),
		],
		[
			'an empty string',
			( props ) =>
				useQueryParamState( 'url_bucket', () => '', String, props ),
		],
	] )( '%s writes nothing and keeps its popstate listener', ( _, hook ) => {
		setLocation( '/wp-admin/admin.php?page=perf&url=h7' );
		const { rerender, unmount } = renderHook( ( props ) => hook( props ), {
			initialProps: { written: true },
		} );
		const replaceSpy = jest.spyOn( window.history, 'replaceState' );
		const addSpy = jest.spyOn( window, 'addEventListener' );

		rerender( { written: false } );
		rerender( { written: true } );

		expect( replaceSpy ).not.toHaveBeenCalled();
		expect( addSpy ).not.toHaveBeenCalledWith(
			'popstate',
			expect.any( Function )
		);
		replaceSpy.mockRestore();
		addSpy.mockRestore();
		unmount();
	} );
} );

describe( 'a list holding missing entries', () => {
	it( 'writes only the entries it holds', () => {
		setLocation( '/wp-admin/admin.php?page=perf' );
		const { unmount } = renderHook( () =>
			useQueryParamList(
				'url_chip',
				() => [ 'worker=3', undefined, null ],
				( l ) => l
			)
		);
		expect( params( 'url_chip' ) ).toEqual( [ 'worker=3' ] );
		unmount();
	} );
} );
