/**
 * Tests for useExpandedIncludes — the composed baseline for the draft's
 * include set (one `topologies expand` round trip per include-set change).
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import {
	expansionMatchesIncludes,
	fetchExpandedIncludes,
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
	it( 'serves a second caller from the cache, with no second round trip', async () => {
		send.mockReturnValue( {
			nodes: [ { name: 'cached-node' } ],
			edges: [],
			tree: { 'cache-source': {} },
		} );
		const { result } = renderHook( () =>
			useExpandedIncludes( [ 'cache-source' ] )
		);
		await waitFor( () => expect( result.current.loading ).toBe( false ), {
			timeout: 4000,
		} );
		expect( send ).toHaveBeenCalledTimes( 1 );

		await expect(
			fetchExpandedIncludes( [ 'cache-source' ] )
		).resolves.toBe( result.current.expansion );
		expect( send ).toHaveBeenCalledTimes( 1 );
	}, 15000 );

	// An upload's .tsl declares includes but ships no expansion, so the load
	// path asks for one mid-flow. It mints nothing: the mounted hook asks on
	// the tick, and the parked promise settles when the answer lands.
	it( 'answers a key parked by fetchExpandedIncludes', async () => {
		send.mockReturnValue( {
			nodes: [ { name: 'parked-tee' } ],
			edges: [],
			tree: { 'parked-source': {} },
		} );
		renderHook( () => useExpandedIncludes( [] ) );
		expect( send ).not.toHaveBeenCalled();

		// Parking wakes the hook, which asks — a state update, so: act.
		let answer;
		act( () => {
			answer = fetchExpandedIncludes( [ 'parked-source' ] );
		} );
		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );
		await expect( answer ).resolves.toMatchObject( {
			nodes: [ { name: 'parked-tee' } ],
		} );
		expect( args() ).toEqual( [ [ 'parked-source' ] ] );
	}, 15000 );

	// A refused expansion is an answer: the waiter is told, rather than left
	// hanging on a promise that never settles.
	// Opening a topology queues the draft's own key AND parks a second for
	// `applyLoadedBaseline`. Draining one and stopping left the second promise
	// unsettled, so the load hung with no error to show for it.
	it( 'works through the queue rather than stopping after one key', async () => {
		send.mockImplementation( ( m ) => ( {
			nodes: [ { name: `n-${ m[ VALUE ].arguments[ 0 ] }` } ],
			edges: [],
			tree: {},
		} ) );
		const { result } = renderHook( () =>
			useExpandedIncludes( [ 'first-source' ] )
		);

		let parked;
		act( () => {
			parked = fetchExpandedIncludes( [ 'second-source' ] );
		} );

		await waitFor(
			() =>
				expect( result.current.expansion.nodes ).toEqual( [
					{ name: 'n-first-source' },
				] ),
			{ timeout: 6000 }
		);
		// The second key settles a tick later; waitFor absorbs that render.
		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 2 ), {
			timeout: 6000,
		} );
		await expect( parked ).resolves.toMatchObject( {
			nodes: [ { name: 'n-second-source' } ],
		} );
	}, 20000 );

	it( 'rejects a parked key the server refuses', async () => {
		send.mockReturnValue( new Error( 'unknown topology: nope-4471' ) );
		renderHook( () => useExpandedIncludes( [] ) );

		// Catch on the spot: the refusal arrives before any later assertion
		// could attach a handler, and an unhandled rejection fails the run.
		let refusal;
		act( () => {
			refusal = fetchExpandedIncludes( [ 'nope-4471' ] ).catch(
				( e ) => e
			);
		} );
		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 1 ), {
			timeout: 4000,
		} );
		expect( ( await refusal ).message ).toMatch( /nope-4471/ );
	}, 15000 );

	// Nobody is left to ask once the hook unmounts, so a still-parked key
	// would never settle — and its caller (`applyLoadedBaseline`, mid-load)
	// awaits it forever rather than unwinding.
	it( 'rejects a still-parked key when the hook unmounts', async () => {
		send.mockReturnValue( new Promise( () => {} ) );
		const { unmount } = renderHook( () => useExpandedIncludes( [] ) );

		let outcome;
		act( () => {
			outcome = fetchExpandedIncludes( [ 'orphan-8813' ] ).catch(
				( e ) => e
			);
		} );
		act( () => unmount() );
		expect( ( await outcome ).message ).toMatch( /torn down/ );
	}, 15000 );
} );

describe( 'invalidateExpandedIncludes', () => {
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
