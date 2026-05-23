/**
 * Tests for useDeleteTopology — dispatches `topologies.delete` via the
 * topology-console CommandClient and returns the unwrapped payload.
 */

import { renderHook, act } from '@testing-library/react';
import { useDeleteTopology } from '../useDeleteTopology';

jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../utils/unwrapCommandResponse', () => jest.fn() );

const { getCommandClient } = require( '../../utils/commandClient' );
const unwrapCommandResponse = require( '../../utils/unwrapCommandResponse' );

describe( 'useDeleteTopology', () => {
	let send;
	beforeEach( () => {
		send = jest.fn().mockResolvedValue( [] );
		getCommandClient.mockReturnValue( { send } );
		unwrapCommandResponse.mockReturnValue( {
			name: 'demo',
			deleted: true,
			stock_fallback: false,
		} );
	} );

	it( 'returns a stable callback across renders', () => {
		const { result, rerender } = renderHook( () => useDeleteTopology() );
		const first = result.current;
		rerender();
		expect( result.current ).toBe( first );
	} );

	it( 'dispatches topologies.delete with the supplied name', async () => {
		const { result } = renderHook( () => useDeleteTopology() );
		await act( async () => {
			await result.current( { name: 'demo' } );
		} );
		expect( send ).toHaveBeenCalledWith( {
			to: 'topologies',
			verb: 'delete',
			args: 'demo',
		} );
	} );

	it( 'returns the unwrapped server payload verbatim', async () => {
		const { result } = renderHook( () => useDeleteTopology() );
		let out;
		await act( async () => {
			out = await result.current( { name: 'demo' } );
		} );
		expect( out ).toEqual( {
			name: 'demo',
			deleted: true,
			stock_fallback: false,
		} );
	} );

	it( 'propagates verb errors from unwrapCommandResponse', async () => {
		unwrapCommandResponse.mockImplementation( () => {
			throw new Error( 'no user-saved topology named: missing' );
		} );
		const { result } = renderHook( () => useDeleteTopology() );
		await act( async () => {
			await expect(
				result.current( { name: 'missing' } )
			).rejects.toThrow( 'no user-saved topology named: missing' );
		} );
	} );
} );
