/**
 * Tests for useLayout — dispatches `layouts.get` / `.save` via the
 * topology-console CommandClient and returns unwrapped payloads.
 */

import { renderHook, act } from '@testing-library/react';
import { useLayout } from '../useLayout';

jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../utils/unwrapCommandResponse', () => jest.fn() );

const { getCommandClient } = require( '../../utils/commandClient' );
const unwrapCommandResponse = require( '../../utils/unwrapCommandResponse' );

describe( 'useLayout', () => {
	let send;
	beforeEach( () => {
		send = jest.fn().mockResolvedValue( [] );
		getCommandClient.mockReturnValue( { send } );
	} );

	describe( 'fetchLayout', () => {
		it( 'dispatches layouts.get with the supplied name', async () => {
			unwrapCommandResponse.mockReturnValue( {
				name: 'demo',
				positions: { a: [ 0, 0 ] },
			} );
			const { result } = renderHook( () => useLayout() );
			await act( async () => {
				await result.current.fetchLayout( 'demo' );
			} );
			expect( send ).toHaveBeenCalledWith( {
				to: 'layouts',
				verb: 'get',
				args: [ 'demo' ],
			} );
		} );

		it( 'returns the unwrapped payload', async () => {
			unwrapCommandResponse.mockReturnValue( {
				name: 'demo',
				positions: null,
			} );
			const { result } = renderHook( () => useLayout() );
			let out;
			await act( async () => {
				out = await result.current.fetchLayout( 'demo' );
			} );
			expect( out ).toEqual( { name: 'demo', positions: null } );
		} );
	} );

	describe( 'saveLayout', () => {
		it( 'dispatches layouts.save with name + positions', async () => {
			unwrapCommandResponse.mockReturnValue( {
				name: 'demo',
				path: '/p',
				positions: { a: [ 5, 7 ] },
			} );
			const { result } = renderHook( () => useLayout() );
			await act( async () => {
				await result.current.saveLayout( {
					name: 'demo',
					positions: { a: [ 5, 7 ] },
				} );
			} );
			expect( send ).toHaveBeenCalledWith( {
				to: 'layouts',
				verb: 'save',
				args: [ 'demo', JSON.stringify( { a: [ 5, 7 ] } ) ],
			} );
		} );
	} );

	it( 'returns stable callbacks across renders', () => {
		unwrapCommandResponse.mockReturnValue( null );
		const { result, rerender } = renderHook( () => useLayout() );
		const first = result.current;
		rerender();
		expect( result.current.fetchLayout ).toBe( first.fetchLayout );
		expect( result.current.saveLayout ).toBe( first.saveLayout );
	} );
} );
