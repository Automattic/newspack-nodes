/**
 * Tests for useTopologyList and useTopology — lazy list + on-demand
 * get of saved topologies via the topology-console CommandClient.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { useTopologyList, useTopology } from '../useTopologyList';

jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../utils/unwrapCommandResponse', () => jest.fn() );

const { getCommandClient } = require( '../../utils/commandClient' );
const unwrapCommandResponse = require( '../../utils/unwrapCommandResponse' );

describe( 'useTopologyList', () => {
	let send;
	beforeEach( () => {
		send = jest.fn().mockResolvedValue( [] );
		getCommandClient.mockReturnValue( { send } );
	} );

	it( 'returns empty initial state when disabled', () => {
		const { result } = renderHook( () => useTopologyList() );
		expect( result.current.topologies ).toEqual( [] );
		expect( result.current.userDir ).toBe( '' );
		expect( result.current.loading ).toBe( false );
		expect( result.current.error ).toBeNull();
		expect( typeof result.current.reload ).toBe( 'function' );
		expect( send ).not.toHaveBeenCalled();
	} );

	it( 'fetches topologies.list when enabled flips true', async () => {
		unwrapCommandResponse.mockReturnValue( {
			topologies: [ { name: 'demo', source: 'user' } ],
			user_dir: '/wp/uploads/topologies',
		} );
		const { result, rerender } = renderHook(
			( { enabled } ) => useTopologyList( { enabled } ),
			{ initialProps: { enabled: false } }
		);
		rerender( { enabled: true } );
		await waitFor( () => expect( result.current.loading ).toBe( false ) );
		expect( send ).toHaveBeenCalledWith( {
			to: 'topologies',
			verb: 'list',
		} );
		expect( result.current.topologies ).toEqual( [
			{ name: 'demo', source: 'user' },
		] );
		expect( result.current.userDir ).toBe( '/wp/uploads/topologies' );
	} );

	it( 'reload() triggers a refetch', async () => {
		unwrapCommandResponse.mockReturnValue( {
			topologies: [],
			user_dir: '/d',
		} );
		const { result } = renderHook( () =>
			useTopologyList( { enabled: true } )
		);
		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 1 ) );
		await act( async () => {
			result.current.reload();
		} );
		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 2 ) );
	} );

	it( 'captures send errors into state.error', async () => {
		send.mockRejectedValue( new Error( 'boom' ) );
		const { result } = renderHook( () =>
			useTopologyList( { enabled: true } )
		);
		await waitFor( () => expect( result.current.error ).not.toBeNull() );
		expect( result.current.error.message ).toBe( 'boom' );
		expect( result.current.loading ).toBe( false );
	} );

	it( 'defaults topologies/userDir when payload is empty', async () => {
		unwrapCommandResponse.mockReturnValue( null );
		const { result } = renderHook( () =>
			useTopologyList( { enabled: true } )
		);
		await waitFor( () => expect( result.current.loading ).toBe( false ) );
		expect( result.current.topologies ).toEqual( [] );
		expect( result.current.userDir ).toBe( '' );
	} );
} );

describe( 'useTopology', () => {
	let send;
	beforeEach( () => {
		send = jest.fn().mockResolvedValue( [] );
		getCommandClient.mockReturnValue( { send } );
	} );

	it( 'dispatches topologies.get with the supplied name', async () => {
		unwrapCommandResponse.mockReturnValue( {
			name: 'demo',
			source: 'user',
			tsl: 'make_node Echo e',
		} );
		const { result } = renderHook( () => useTopology() );
		let payload;
		await act( async () => {
			payload = await result.current( 'demo' );
		} );
		expect( send ).toHaveBeenCalledWith( {
			to: 'topologies',
			verb: 'get',
			payload: { name: 'demo' },
		} );
		expect( payload ).toEqual( {
			name: 'demo',
			source: 'user',
			tsl: 'make_node Echo e',
		} );
	} );

	it( 'is stable across renders', () => {
		const { result, rerender } = renderHook( () => useTopology() );
		const first = result.current;
		rerender();
		expect( result.current ).toBe( first );
	} );
} );
