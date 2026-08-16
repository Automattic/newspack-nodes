/**
 * useTopologyList / useTopology — the saved-topology list and an on-demand get,
 * both batched-poll slices.
 *
 * Each owns its own Fetcher and view node, and the reply routes back to
 * whichever minted it — which is why a list and a get can overlap without an
 * op-id between them.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { useTopologyList, useTopology } from '../useCatalogs';

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

	// A save used to owe the catalog a `reload()`. The tick carries the new
	// entry on its own, so what the dialog shows converges without being told.
	it( 'picks up a new entry without being reloaded', async () => {
		const { result } = renderHook( () =>
			useTopologyList( { enabled: true } )
		);
		await waitFor( () =>
			expect( result.current.topologies ).toEqual( LISTED.topologies )
		);

		replyFor.mockImplementation( () => ( {
			topologies: [ { name: 'wombat-8823', source: 'user' } ],
			user_dir: '/wp/uploads/topologies',
		} ) );
		await waitFor(
			() =>
				expect( result.current.topologies ).toEqual( [
					{ name: 'wombat-8823', source: 'user' },
				] ),
			{ timeout: 4000 }
		);
	} );

	// And it hands out nothing to trigger it with: the `reload()` a save used to
	// call forwarded to nothing, which is one more thing for a caller to read.
	it( 'hands out no reload — the tick is the only refresh', async () => {
		const { result } = renderHook( () =>
			useTopologyList( { enabled: true } )
		);
		await waitFor( () =>
			expect( result.current.topologies ).toEqual( LISTED.topologies )
		);
		expect( result.current.reload ).toBeUndefined();
	} );

	it( 'captures verb errors into state.error', async () => {
		replyFor.mockImplementation( () => new Error( 'boom-4471' ) );
		const { result } = renderHook( () =>
			useTopologyList( { enabled: true } )
		);
		await waitFor( () => expect( result.current.error ).not.toBeNull() );
		// A slice publishes the reply's text, not an Error object.
		expect( result.current.error ).toContain( 'boom-4471' );
		expect( result.current.loading ).toBe( false );
	} );

	// An empty body is not an empty catalog: the poll keeps whatever it has
	// rather than blanking the dialog for one bad tick.
	it( 'keeps the last good list when a reply arrives malformed', async () => {
		const { result } = renderHook( () =>
			useTopologyList( { enabled: true } )
		);
		await waitFor( () =>
			expect( result.current.topologies ).toEqual( LISTED.topologies )
		);

		replyFor.mockImplementation( () => null );
		await new Promise( ( r ) => setTimeout( r, 1200 ) );

		expect( result.current.topologies ).toEqual( LISTED.topologies );
		expect( result.current.userDir ).toBe( '/wp/uploads/topologies' );
	} );
} );

describe( 'useTopology', () => {
	it( 'asks for the named topology and publishes the answer', async () => {
		const { result } = renderHook( () => useTopology( { scope: 'test' } ) );
		expect( replyFor ).not.toHaveBeenCalled();

		act( () => {
			result.current.open( 'demo' );
		} );

		await waitFor(
			() =>
				expect( result.current.topology ).toMatchObject( {
					name: 'demo',
					tsl: 'make_node Echo e',
				} ),
			{ timeout: 4000 }
		);
		expect( verbs() ).toEqual( [ 'get' ] );
		expect( replyFor.mock.calls[ 0 ][ 0 ][ VALUE ].arguments ).toEqual( [
			'demo',
		] );
	} );

	// Half a loaded page is the failure this replaces: the old awaited fetch
	// was sent once, and an ask that never came back left the editor open on
	// nothing at all. This one asks again until an answer lands.
	it( 'keeps asking until the answer actually lands', async () => {
		replyFor.mockImplementationOnce( () => undefined );
		const { result } = renderHook( () => useTopology( { scope: 'test' } ) );
		act( () => {
			result.current.open( 'demo' );
		} );

		await waitFor(
			() => expect( result.current.topology?.name ).toBe( 'demo' ),
			{ timeout: 6000 }
		);
	}, 15000 );

	// Once it lands, the slice stops — a topology the operator is editing must
	// not be re-fetched under them every second.
	it( 'stops asking once the answer is in hand', async () => {
		const { result } = renderHook( () => useTopology( { scope: 'test' } ) );
		act( () => {
			result.current.open( 'demo' );
		} );
		await waitFor( () => expect( result.current.topology ).not.toBeNull(), {
			timeout: 4000,
		} );

		const settledCalls = replyFor.mock.calls.length;
		await new Promise( ( r ) => setTimeout( r, 2200 ) );
		expect( replyFor ).toHaveBeenCalledTimes( settledCalls );
	}, 15000 );

	// The answer to the LAST open() is what a caller reads as its own; the
	// previous topology's body sitting in the view node is not that.
	it( 'reports no topology while a newly-opened one is outstanding', async () => {
		const { result } = renderHook( () => useTopology( { scope: 'test' } ) );
		act( () => {
			result.current.open( 'demo' );
		} );
		await waitFor( () => expect( result.current.topology ).not.toBeNull(), {
			timeout: 4000,
		} );

		replyFor.mockImplementation( () => undefined );
		await act( async () => {
			result.current.open( 'other' );
		} );
		expect( result.current.topology ).toBeNull();
	} );
} );
