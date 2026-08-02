/**
 * Tests for useExpandedIncludes — the composed baseline for the draft's
 * include set (one `topologies expand` round trip per include-set change).
 */

import { renderHook, waitFor } from '@testing-library/react';
import { Core, VALUE } from '@newspack-nodes/runtime';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import {
	useExpandedIncludes,
	invalidateExpandedIncludes,
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
	it( 'returns an empty baseline and never fetches when there are no includes', async () => {
		const { result } = renderHook( () => useExpandedIncludes( [] ) );
		expect( result.current.baseline ).toEqual( {
			nodes: [],
			edges: [],
			tree: {},
			hulls: {},
		} );
		expect( send ).not.toHaveBeenCalled();
	} );

	it( 'fetches topologies expand for the include set', async () => {
		send.mockReturnValue( {
			nodes: [ { name: 'shared-tee' } ],
			edges: [],
			tree: {},
		} );
		const { result } = renderHook( () =>
			useExpandedIncludes( [ 'performance', 'job-router' ] )
		);
		await waitFor( () => expect( result.current.loading ).toBe( false ) );
		expect( args() ).toEqual( [ [ 'performance', 'job-router' ] ] );
		expect( result.current.baseline.nodes ).toEqual( [
			{ name: 'shared-tee' },
		] );
	} );

	it( 'surfaces a cycle error and keeps the last-good baseline', async () => {
		send.mockReturnValue(
			new Error( 'topology include cycle: a -> b -> a' )
		);
		const { result } = renderHook( () =>
			useExpandedIncludes( [ 'cycle-a' ] )
		);
		await waitFor( () =>
			expect( result.current.error ).toMatch( /include cycle/ )
		);
		expect( result.current.baseline ).toEqual( {
			nodes: [],
			edges: [],
			tree: {},
			hulls: {},
		} );
	} );

	it( 'caches the expansion, so a second caller skips the round trip', async () => {
		send.mockReturnValue( {
			nodes: [ { name: 'cached-node' } ],
			edges: [],
			tree: { 'cache-source': {} },
		} );
		const first = renderHook( () =>
			useExpandedIncludes( [ 'cache-source' ] )
		);
		await waitFor( () =>
			expect( first.result.current.loading ).toBe( false )
		);
		expect( send ).toHaveBeenCalledTimes( 1 );

		const second = renderHook( () =>
			useExpandedIncludes( [ 'cache-source' ] )
		);

		await waitFor( () =>
			expect( second.result.current.baseline ).toBe(
				first.result.current.baseline
			)
		);
		expect( send ).toHaveBeenCalledTimes( 1 );
	} );
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

		const primed = renderHook( () =>
			useExpandedIncludes( [ 'performance' ] )
		);
		await waitFor( () =>
			expect( primed.result.current.loading ).toBe( false )
		);
		expect( send ).toHaveBeenCalledTimes( 1 );

		// Still cached: a re-open without a save must NOT re-fetch.
		const cached = renderHook( () =>
			useExpandedIncludes( [ 'performance' ] )
		);
		await waitFor( () =>
			expect( cached.result.current.loading ).toBe( false )
		);
		expect( send ).toHaveBeenCalledTimes( 1 );

		invalidateExpandedIncludes();
		renderHook( () => useExpandedIncludes( [ 'performance' ] ) );

		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 2 ) );
	} );
} );
