/**
 * useClassCatalog — lazy single fetch of the substrate class catalog for the
 * console palette, minted from its own `classes:list` Request node.
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

	// A failure used to be memoised forever, so even an explicit retry got the
	// same rejected promise back.
	it( 'does not cache a failure permanently', async () => {
		replyFor.mockImplementationOnce( () => new Error( 'refused-8823' ) );

		const { result } = renderHook( () =>
			useClassCatalog( { enabled: true } )
		);
		await waitFor( () => expect( result.current.error ).toBeTruthy() );

		await act( async () => {
			await result.current.load().catch( () => {} );
		} );

		expect( result.current.classes ).toEqual( [ 'Echo', 'Tee' ] );
	} );

	it( 'returns the empty initial shape when disabled', () => {
		const { result } = renderHook( () => useClassCatalog() );
		expect( result.current ).toEqual( {
			classes: [],
			formatters: [],
			loading: false,
			error: null,
			load: expect.any( Function ),
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
		await expect( result.current.load() ).resolves.toEqual( CATALOG );
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
		expect( result.current.error.message ).toBe( 'network down' );
		expect( result.current.loading ).toBe( false );
	} );

	it( 'rejects a malformed payload instead of treating every class as regular', async () => {
		replyFor.mockImplementation( () => null );
		const { result } = renderHook( () =>
			useClassCatalog( { enabled: true } )
		);
		await waitFor( () => expect( result.current.error ).not.toBeNull() );
		expect( result.current.error.message ).toBe(
			'Invalid classes.list response.'
		);
		expect( result.current.classes ).toEqual( [] );
		expect( result.current.formatters ).toEqual( [] );
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
