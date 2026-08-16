/**
 * Tests for useExpandedIncludes — the composed baseline for the draft's
 * include set (one `topologies expand` round trip per include-set change).
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import {
	expansionMatchesIncludes,
	primeExpandedIncludes,
	invalidateExpandedIncludes,
	useExpandedIncludes,
} from '../useExpandedIncludes';

let send;

const args = () => send.mock.calls.map( ( [ m ] ) => m[ VALUE ].arguments );

beforeEach( () => {
	Core.reset();
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	send = jest.fn();
	installFakeCommandWire( ( m ) => send( m ) );
	// The cache is module-level and survives `it` blocks in this file.
	invalidateExpandedIncludes();
} );

describe( 'useExpandedIncludes', () => {
	it( 'returns an empty expansion and never fetches when there are no includes', async () => {
		const { result } = renderHook( () => useExpandedIncludes( [] ) );
		expect( result.current.expansion ).toEqual( {
			nodes: [],
			edges: [],
			tree: {},
			hulls: {},
		} );
		expect( send ).not.toHaveBeenCalled();
	}, 15000 );

	it( 'fetches topologies expand for the include set', async () => {
		send.mockReturnValue( {
			nodes: [ { name: 'shared-tee' } ],
			edges: [],
			tree: {},
		} );
		const { result } = renderHook( () =>
			useExpandedIncludes( [ 'performance', 'job-router' ] )
		);
		await waitFor( () => expect( result.current.loading ).toBe( false ), {
			timeout: 4000,
		} );
		expect( args() ).toEqual( [ [ 'performance', 'job-router' ] ] );
		expect( result.current.expansion.nodes ).toEqual( [
			{ name: 'shared-tee' },
		] );
	}, 15000 );

	it( 'surfaces a cycle error and keeps the last-good expansion', async () => {
		send.mockReturnValue(
			new Error( 'topology include cycle: a -> b -> a' )
		);
		const { result } = renderHook( () =>
			useExpandedIncludes( [ 'cycle-a' ] )
		);
		await waitFor(
			() => expect( result.current.error ).toMatch( /include cycle/ ),
			{ timeout: 4000 }
		);
		expect( result.current.expansion ).toEqual( {
			nodes: [],
			edges: [],
			tree: {},
			hulls: {},
		} );
	}, 15000 );

	// The console mounts ONE expand hook — it owns graph nodes — so a second
	// caller is not a second hook: it is `fetchExpandedIncludes`, which parks
	// its key and takes the answer from the same cache.
	// The cache's real second entry point: `topologies get` ships the
	// expansion with the file, so an OPEN primes it and the reactive pass
	// costs no round trip at all. (Two simultaneous mounts are not a case —
	// this is the console's ONE expand hook, and a second would collide on
	// its node names.)
	it( 'costs no round trip for a set an open already primed', async () => {
		const primed = {
			nodes: [ { name: 'primed-node' } ],
			edges: [],
			tree: { 'cache-source': {} },
			hulls: {},
		};
		primeExpandedIncludes( [ 'cache-source' ], primed );

		const { result } = renderHook( () =>
			useExpandedIncludes( [ 'cache-source' ] )
		);
		expect( result.current.loading ).toBe( false );
		expect( result.current.expansion ).toEqual( primed );

		// Give a round trip every chance to happen before denying it.
		await act( async () => {
			await new Promise( ( r ) => setTimeout( r, 1500 ) );
		} );
		expect( send ).not.toHaveBeenCalled();
	}, 15000 );

	// @longform Opening a second document while the first is still expanding
	// must ask for the SECOND. A read supersedes rather than queueing, so the
	// abandoned ask is dropped instead of arriving later and painting the
	// document the operator already left.
	it( 'supersedes an outstanding ask when the include set changes', async () => {
		send.mockImplementation( ( m ) => ( {
			nodes: [ { name: `node-for-${ m[ VALUE ].arguments[ 0 ] }` } ],
			edges: [],
			tree: { [ m[ VALUE ].arguments[ 0 ] ]: {} },
		} ) );
		const { result, rerender } = renderHook(
			( { includes } ) => useExpandedIncludes( includes ),
			{ initialProps: { includes: [ 'first-source' ] } }
		);
		act( () => rerender( { includes: [ 'second-source' ] } ) );

		await waitFor( () => expect( result.current.loading ).toBe( false ), {
			timeout: 6000,
		} );
		expect( result.current.expansion.nodes ).toEqual( [
			{ name: 'node-for-second-source' },
		] );
		expect( args().map( ( a ) => a[ 0 ] ) ).not.toContain( 'first-source' );
	}, 20000 );

	it( 'drops the cache so a saved topology re-expands', async () => {
		// Editing performance.tsl and saving it CHANGES what `include
		// performance` expands to. Without invalidation, reopening combined.tsl
		// would paint the pre-save expansion — stale borrowed nodes, and a save
		// that writes deltas against a baseline the server no longer agrees with.
		send.mockReturnValue( {
			nodes: [ { name: 'stale-tee' } ],
			edges: [],
			tree: {},
		} );
		invalidateExpandedIncludes();

		const { result, rerender } = renderHook(
			( { includes } ) => useExpandedIncludes( includes ),
			{ initialProps: { includes: [ 'performance' ] } }
		);
		await waitFor( () => expect( result.current.loading ).toBe( false ), {
			timeout: 4000,
		} );
		expect( send ).toHaveBeenCalledTimes( 1 );

		// Still cached: leaving the set and coming back must NOT re-fetch.
		rerender( { includes: [] } );
		rerender( { includes: [ 'performance' ] } );
		expect( send ).toHaveBeenCalledTimes( 1 );

		invalidateExpandedIncludes();
		rerender( { includes: [] } );
		rerender( { includes: [ 'performance' ] } );

		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 2 ), {
			timeout: 4000,
		} );
	}, 15000 );
} );

describe( 'expansionMatchesIncludes', () => {
	it( 'rejects the previous document’s expansion', () => {
		// Opening a child while the parent's expansion lingers: the tree names
		// an include the child does not have, and re-seeding from it marks the
		// child's own nodes borrowed.
		expect( expansionMatchesIncludes( { tree: { test: {} } }, [] ) ).toBe(
			false
		);
	} );

	it( 'rejects an expansion still in flight', () => {
		expect( expansionMatchesIncludes( { tree: {} }, [ 'child' ] ) ).toBe(
			false
		);
	}, 15000 );

	it( 'accepts the expansion for exactly these includes', () => {
		expect(
			expansionMatchesIncludes( { tree: { a: {}, b: {} } }, [ 'b', 'a' ] )
		).toBe( true );
	}, 15000 );

	it( 'accepts nothing for a document with no includes', () => {
		expect( expansionMatchesIncludes( undefined, [] ) ).toBe( true );
	} );
} );
