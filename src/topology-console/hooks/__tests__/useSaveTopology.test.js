/**
 * Tests for useSaveTopology — dispatches `topologies.save` via the
 * topology-console CommandClient and returns the unwrapped payload.
 */

import { renderHook, act } from '@testing-library/react';
import { useSaveTopology } from '../useSaveTopology';

jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../utils/unwrapCommandResponse', () => jest.fn() );

const { getCommandClient } = require( '../../utils/commandClient' );
const unwrapCommandResponse = require( '../../utils/unwrapCommandResponse' );

describe( 'useSaveTopology', () => {
	let send;
	beforeEach( () => {
		send = jest.fn().mockResolvedValue( [ 'fake', 'message' ] );
		getCommandClient.mockReturnValue( { send } );
		unwrapCommandResponse.mockReturnValue( {
			name: 'demo',
			path: '/p',
			shadows_stock: false,
			restarted_fleets: [],
		} );
	} );

	it( 'returns a stable callback across renders', () => {
		const { result, rerender } = renderHook( () => useSaveTopology() );
		const first = result.current;
		rerender();
		expect( result.current ).toBe( first );
	} );

	it( 'dispatches topologies.save with the supplied name + tsl', async () => {
		const { result } = renderHook( () => useSaveTopology() );
		await act( async () => {
			await result.current( { name: 'demo', tsl: 'make_node Echo e' } );
		} );
		expect( send ).toHaveBeenCalledWith( {
			to: 'topologies',
			verb: 'save',
			payload: { name: 'demo', tsl: 'make_node Echo e' },
		} );
	} );

	it( 'returns the unwrapped server payload', async () => {
		const { result } = renderHook( () => useSaveTopology() );
		let out;
		await act( async () => {
			out = await result.current( { name: 'demo', tsl: 'x' } );
		} );
		expect( out ).toEqual( {
			name: 'demo',
			path: '/p',
			shadows_stock: false,
			restarted_fleets: [],
		} );
	} );

	it( 'propagates verb errors from unwrapCommandResponse', async () => {
		unwrapCommandResponse.mockImplementation( () => {
			throw new Error( 'validation failed at line 3' );
		} );
		const { result } = renderHook( () => useSaveTopology() );
		await act( async () => {
			await expect(
				result.current( { name: 'bad', tsl: '' } )
			).rejects.toThrow( 'validation failed at line 3' );
		} );
	} );
} );
