/**
 * Tests for useClassCatalog — lazy single-fetch of the substrate class
 * catalog for the topology console palette.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { useClassCatalog } from '../useClassCatalog';

jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../utils/unwrapCommandResponse', () => jest.fn() );

const { getCommandClient } = require( '../../utils/commandClient' );
const unwrapCommandResponse = require( '../../utils/unwrapCommandResponse' );

describe( 'useClassCatalog', () => {
	let send;
	beforeEach( () => {
		send = jest.fn().mockResolvedValue( [ 'fake', 'message' ] );
		getCommandClient.mockReturnValue( { send } );
		unwrapCommandResponse.mockReturnValue( {
			classes: [ 'Echo', 'Tee' ],
			formatters: [ 'Plain' ],
		} );
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
		expect( send ).not.toHaveBeenCalled();
	} );

	it( 'fetches classes.list when enabled flips true', async () => {
		const { result, rerender } = renderHook(
			( { enabled } ) => useClassCatalog( { enabled } ),
			{ initialProps: { enabled: false } }
		);
		expect( send ).not.toHaveBeenCalled();
		rerender( { enabled: true } );
		await waitFor( () => expect( result.current.loading ).toBe( false ) );
		expect( send ).toHaveBeenCalledWith( { to: 'classes', verb: 'list' } );
		expect( result.current.classes ).toEqual( [ 'Echo', 'Tee' ] );
		expect( result.current.formatters ).toEqual( [ 'Plain' ] );
		await expect( result.current.load() ).resolves.toEqual( {
			classes: [ 'Echo', 'Tee' ],
			formatters: [ 'Plain' ],
		} );
		expect( send ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'only fetches once even if enabled flips off and back on', async () => {
		const { result, rerender } = renderHook(
			( { enabled } ) => useClassCatalog( { enabled } ),
			{ initialProps: { enabled: true } }
		);
		await waitFor( () => expect( result.current.loading ).toBe( false ) );
		expect( send ).toHaveBeenCalledTimes( 1 );
		rerender( { enabled: false } );
		rerender( { enabled: true } );
		expect( send ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'captures send-side errors into state.error', async () => {
		send.mockRejectedValue( new Error( 'network down' ) );
		const { result } = renderHook( () =>
			useClassCatalog( { enabled: true } )
		);
		await waitFor( () => expect( result.current.error ).not.toBeNull() );
		expect( result.current.error.message ).toBe( 'network down' );
		expect( result.current.loading ).toBe( false );
	} );

	it( 'rejects a malformed payload instead of treating every class as regular', async () => {
		unwrapCommandResponse.mockReturnValue( null );
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
		let resolveSend;
		send.mockImplementation(
			() =>
				new Promise( ( resolve ) => {
					resolveSend = resolve;
				} )
		);
		const { result } = renderHook( () =>
			useClassCatalog( { enabled: true } )
		);
		await waitFor( () => expect( result.current.loading ).toBe( true ) );
		await act( async () => {
			resolveSend( [] );
		} );
		await waitFor( () => expect( result.current.loading ).toBe( false ) );
	} );
} );
