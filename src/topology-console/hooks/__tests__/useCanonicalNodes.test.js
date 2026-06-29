import { renderHook, waitFor } from '@testing-library/react';

jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../utils/unwrapCommandResponse', () => jest.fn() );
// Spy on parseTsl (delegating to the real parser) so the post-unmount test can
// assert the `!live` guard short-circuits BEFORE parsing — the other tests still
// get real parsing.
jest.mock( '../../utils/parseTsl', () => {
	const actual = jest.requireActual( '../../utils/parseTsl' );
	return { parseTsl: jest.fn( actual.parseTsl ) };
} );

const { getCommandClient } = require( '../../utils/commandClient' );
const unwrapCommandResponse = require( '../../utils/unwrapCommandResponse' );
const { parseTsl } = require( '../../utils/parseTsl' );

import { useCanonicalNodes, driftNodeIds } from '../useCanonicalNodes';

describe( 'driftNodeIds', () => {
	it( 'returns live nodes absent from the canonical set, excluding reserved _ infra', () => {
		const canonical = new Set( [ 'alpha', 'beta' ] );
		const nodes = [
			{ id: 'alpha' },
			{ id: 'beta' },
			{ id: 'gamma' }, // runtime-added → drift
			{ id: '_repl' }, // reserved console infra → never drift
		];
		expect( [ ...driftNodeIds( nodes, canonical ) ] ).toEqual( [
			'gamma',
		] );
	} );

	it( 'returns null when there is no canonical info (empty set)', () => {
		expect( driftNodeIds( [ { id: 'x' } ], new Set() ) ).toBeNull();
		expect( driftNodeIds( [ { id: 'x' } ], null ) ).toBeNull();
	} );
} );

describe( 'useCanonicalNodes', () => {
	let send;
	beforeEach( () => {
		send = jest.fn();
		getCommandClient.mockReturnValue( { send } );
		unwrapCommandResponse.mockImplementation( ( m ) => m );
	} );

	it( 'fetches the topology .tsl and returns its declared node names', async () => {
		send.mockResolvedValue( {
			tsl: 'make_node Echo alpha\nmake_node Tee beta\n',
		} );
		const { result } = renderHook( () => useCanonicalNodes( 'combined' ) );
		await waitFor( () => expect( result.current.size ).toBe( 2 ) );
		expect( result.current.has( 'alpha' ) ).toBe( true );
		expect( result.current.has( 'beta' ) ).toBe( true );
	} );

	it( 'returns an empty set (and does not fetch) when there is no topology', () => {
		const { result } = renderHook( () => useCanonicalNodes( '' ) );
		expect( result.current.size ).toBe( 0 );
		expect( send ).not.toHaveBeenCalled();
	} );

	it( 'ignores a fetch that resolves after the hook unmounts', async () => {
		parseTsl.mockClear();
		let resolveFetch;
		send.mockReturnValue(
			new Promise( ( res ) => {
				resolveFetch = res;
			} )
		);
		const { unmount } = renderHook( () => useCanonicalNodes( 'combined' ) );
		unmount();
		resolveFetch( { tsl: 'make_node Echo alpha\n' } );
		// Flush the resolve handler.
		await Promise.resolve();
		await Promise.resolve();
		// The `!live` guard returns BEFORE parsing/setState. Deleting it would let the
		// late resolve parse the tsl and setState on the unmounted hook — so parseTsl
		// running here is the regression signal.
		expect( parseTsl ).not.toHaveBeenCalled();
	} );

	it( 'resets to an empty set when the topology fetch rejects', async () => {
		send.mockResolvedValueOnce( { tsl: 'make_node Echo alpha\n' } );
		const { result, rerender } = renderHook(
			( { t } ) => useCanonicalNodes( t ),
			{ initialProps: { t: 'combined' } }
		);
		await waitFor( () => expect( result.current.size ).toBe( 1 ) );

		send.mockRejectedValueOnce( new Error( 'nope' ) );
		rerender( { t: 'other' } );
		await waitFor( () => expect( result.current.size ).toBe( 0 ) );
	} );
} );
