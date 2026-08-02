/**
 * useTopologyList / useTopology — the saved-topology list and an on-demand get.
 *
 * Each hook mints from its OWN Request node (`topologies:list`,
 * `topologies:get`), and the reply routes back to whichever minted it — which
 * is why a list and a get can overlap without an op-id between them.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useTopologyList, useTopology } from '../useTopologyList';

// Distinct from every default so a wrong-field read fails rather than coincides.
const LISTED = {
	topologies: [ { name: 'demo', source: 'user' } ],
	user_dir: '/wp/uploads/topologies',
};
const FETCHED = { name: 'demo', source: 'user', tsl: 'make_node Echo e' };

let replyFor;

const verbs = () => replyFor.mock.calls.map( ( [ m ] ) => m[ VALUE ].name );

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	replyFor = jest.fn( ( m ) =>
		'get' === m[ VALUE ].name ? FETCHED : LISTED
	);
	installFakeCommandWire( ( m ) => replyFor( m ) );
} );

describe( 'useTopologyList', () => {
	it( 'returns empty initial state when disabled', () => {
		const { result } = renderHook( () => useTopologyList() );
		expect( result.current.topologies ).toEqual( [] );
		expect( result.current.userDir ).toBe( '' );
		expect( result.current.loading ).toBe( false );
		expect( result.current.error ).toBeNull();
		expect( typeof result.current.reload ).toBe( 'function' );
		expect( replyFor ).not.toHaveBeenCalled();
	} );

	it( 'fetches topologies.list when enabled flips true', async () => {
		const { result, rerender } = renderHook(
			( { enabled } ) => useTopologyList( { enabled } ),
			{ initialProps: { enabled: false } }
		);
		rerender( { enabled: true } );

		await waitFor( () =>
			expect( result.current.topologies ).toEqual( LISTED.topologies )
		);
		expect( verbs() ).toEqual( [ 'list' ] );
		expect( result.current.userDir ).toBe( '/wp/uploads/topologies' );
		expect( result.current.loading ).toBe( false );
	} );

	it( 'reload() triggers a refetch', async () => {
		const { result } = renderHook( () =>
			useTopologyList( { enabled: true } )
		);
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 1 ) );
		await act( async () => {
			result.current.reload();
		} );
		await waitFor( () => expect( replyFor ).toHaveBeenCalledTimes( 2 ) );
	} );

	it( 'captures verb errors into state.error', async () => {
		replyFor.mockImplementation( () => new Error( 'boom-4471' ) );
		const { result } = renderHook( () =>
			useTopologyList( { enabled: true } )
		);
		await waitFor( () => expect( result.current.error ).not.toBeNull() );
		expect( result.current.error.message ).toBe( 'boom-4471' );
		expect( result.current.loading ).toBe( false );
	} );

	it( 'defaults topologies/userDir when payload is empty', async () => {
		replyFor.mockImplementation( () => null );
		const { result } = renderHook( () =>
			useTopologyList( { enabled: true } )
		);
		await waitFor( () => expect( result.current.loading ).toBe( false ) );
		expect( result.current.topologies ).toEqual( [] );
		expect( result.current.userDir ).toBe( '' );
	} );
} );

describe( 'useTopology', () => {
	it( 'dispatches topologies.get with the supplied name', async () => {
		const { result } = renderHook( () => useTopology() );
		let payload;
		await act( async () => {
			payload = await result.current( 'demo' );
		} );

		expect( verbs() ).toEqual( [ 'get' ] );
		expect( replyFor.mock.calls[ 0 ][ 0 ][ VALUE ].arguments ).toEqual( [
			'demo',
		] );
		expect( payload ).toEqual( FETCHED );
	} );

	it( 'is stable across renders', () => {
		const { result, rerender } = renderHook( () => useTopology() );
		const first = result.current;
		rerender();
		expect( result.current ).toBe( first );
	} );
} );
