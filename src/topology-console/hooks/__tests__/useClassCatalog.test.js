/**
 * useClassCatalog — the substrate class catalog behind the console palette,
 * polled as a batched-poll slice and read as published state.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { Core, renewSession, VALUE } from '@newspack-nodes/runtime';
import {
	installFakeCommandWire,
	makeFakeCommandWire,
} from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useClassCatalog } from '../useClassCatalog';

// Distinct from every default so a wrong-field read fails rather than coincides.
const CATALOG = { classes: [ 'Echo', 'Tee' ], formatters: [ 'Plain' ] };

let replyFor;

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( () => CATALOG );
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

describe( 'useClassCatalog', () => {
	// The overnight-tab bug: the catalog loaded once, the session died an hour
	// later, and nothing ever asked again. A refused load must re-establish
	// itself when the auth generation moves — without a remount.
	it( 're-establishes the catalog after an auth invalidation', async () => {
		replyFor.mockImplementationOnce( () => new Error( 'refused-4471' ) );

		const { result } = renderHook( () =>
			useClassCatalog( { enabled: true } )
		);
		await waitFor( () => expect( result.current.error ).toBeTruthy() );
		expect( result.current.classes ).toEqual( [] );

		act( () => {
			renewSession();
		} );

		// The generation change is noticed on the reconcile tick (1s), then
		// the round trip runs — past waitFor's 1s default.
		await waitFor(
			() => expect( result.current.classes ).toEqual( [ 'Echo', 'Tee' ] ),
			{ timeout: 4000 }
		);
	} );

	// The overnight tab that loaded SUCCESSFULLY is the case the docblock is
	// written for: the cache outlived the session, and load() was read on the
	// same synchronous tick that invalidated it, before any effect could clear.
	it( 're-fetches a successfully-loaded catalog after an auth invalidation', async () => {
		const { result } = renderHook( () =>
			useClassCatalog( { enabled: true } )
		);
		await waitFor( () =>
			expect( result.current.classes ).toEqual( [ 'Echo', 'Tee' ] )
		);
		expect( replyFor ).toHaveBeenCalledTimes( 1 );

		replyFor.mockImplementation( () => ( {
			classes: [ 'Grep', 'Tail' ],
			formatters: [ 'Bytes' ],
		} ) );

		act( () => {
			renewSession();
		} );

		await waitFor(
			() =>
				expect( result.current.classes ).toEqual( [ 'Grep', 'Tail' ] ),
			{ timeout: 4000 }
		);
		expect( result.current.formatters ).toEqual( [ 'Bytes' ] );
	} );

	// A failure used to be memoised forever, so even an explicit retry got the
	// same rejected promise back. The poll has no promise to memoise: the next
	// tick asks again, with nothing to reset and nobody to ask.
	it( 'recovers from a failure on the next tick', async () => {
		replyFor.mockImplementationOnce( () => new Error( 'refused-8823' ) );

		const { result } = renderHook( () =>
			useClassCatalog( { enabled: true } )
		);
		await waitFor( () => expect( result.current.error ).toBeTruthy() );

		await waitFor(
			() => expect( result.current.classes ).toEqual( [ 'Echo', 'Tee' ] ),
			{ timeout: 4000 }
		);
	} );

	it( 'returns the empty initial shape when disabled', () => {
		const { result } = renderHook( () => useClassCatalog() );
		expect( result.current ).toEqual( {
			classes: [],
			formatters: [],
			loading: false,
			error: null,
		} );
		expect( replyFor ).not.toHaveBeenCalled();
	} );

	it( 'fetches classes.list when enabled flips true', async () => {
		const { result, rerender } = renderHook(
			( { enabled } ) => useClassCatalog( { enabled } ),
			{ initialProps: { enabled: false } }
		);
		expect( replyFor ).not.toHaveBeenCalled();
		rerender( { enabled: true } );

		await waitFor( () => expect( result.current.loading ).toBe( false ) );
		expect( replyFor.mock.calls[ 0 ][ 0 ][ VALUE ].name ).toBe( 'list' );
		expect( result.current.classes ).toEqual( [ 'Echo', 'Tee' ] );
		expect( result.current.formatters ).toEqual( [ 'Plain' ] );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'only fetches once even if enabled flips off and back on', async () => {
		const { result, rerender } = renderHook(
			( { enabled } ) => useClassCatalog( { enabled } ),
			{ initialProps: { enabled: true } }
		);
		await waitFor( () => expect( result.current.loading ).toBe( false ) );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
		rerender( { enabled: false } );
		rerender( { enabled: true } );
		expect( replyFor ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'captures verb errors into state.error', async () => {
		replyFor.mockImplementation( () => new Error( 'network down' ) );
		const { result } = renderHook( () =>
			useClassCatalog( { enabled: true } )
		);
		await waitFor( () => expect( result.current.error ).not.toBeNull() );
		// A slice publishes the reply's text, not an Error object.
		expect( result.current.error ).toContain( 'network down' );
		expect( result.current.loading ).toBe( false );
	} );

	// A body missing either list is what a half-built palette comes from. The
	// poll keeps the last good catalog rather than blanking on one bad tick —
	// there is always another tick, and an empty palette is the worse answer.
	it( 'keeps the last good catalog when a reply arrives malformed', async () => {
		const { result } = renderHook( () =>
			useClassCatalog( { enabled: true } )
		);
		await waitFor( () =>
			expect( result.current.classes ).toEqual( [ 'Echo', 'Tee' ] )
		);

		replyFor.mockImplementation( () => null );
		await new Promise( ( r ) => setTimeout( r, 1200 ) );

		expect( result.current.classes ).toEqual( [ 'Echo', 'Tee' ] );
		expect( result.current.formatters ).toEqual( [ 'Plain' ] );
	} );

	it( 'sets loading true during the in-flight fetch', async () => {
		// Hold the wire open, then let the real reply through on release.
		const wire = makeFakeCommandWire( ( m ) => replyFor( m ) );
		let release;
		global.fetch = jest.fn(
			( ...args ) =>
				new Promise( ( resolve ) => {
					release = () => resolve( wire( ...args ) );
				} )
		);
		const { result } = renderHook( () =>
			useClassCatalog( { enabled: true } )
		);
		await waitFor( () => expect( result.current.loading ).toBe( true ) );
		await act( async () => {
			release();
		} );
		await waitFor( () => expect( result.current.loading ).toBe( false ) );
	} );
} );
