/**
 * Tests for useExpandedIncludes — the composed baseline for the draft's
 * include set (one `topologies expand` round trip per include-set change).
 */

import { renderHook, waitFor } from '@testing-library/react';
import {
	useExpandedIncludes,
	getExpandedIncludesCache,
	setExpandedIncludesCache,
	invalidateExpandedIncludes,
	__resetExpandedIncludesCacheForTests,
} from '../useExpandedIncludes';

jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../utils/unwrapCommandResponse', () => jest.fn() );

const { getCommandClient } = require( '../../utils/commandClient' );
const unwrapCommandResponse = require( '../../utils/unwrapCommandResponse' );

// Payload the real unwrapCommandResponse would extract from a Message tuple.
const commandReply = ( payload ) => payload;

describe( 'useExpandedIncludes', () => {
	let send;
	beforeEach( () => {
		send = jest.fn();
		getCommandClient.mockReturnValue( { send } );
		unwrapCommandResponse.mockImplementation( ( message ) => message );
		__resetExpandedIncludesCacheForTests();
	} );

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
		send.mockResolvedValue(
			commandReply( {
				nodes: [ { name: 'shared-tee' } ],
				edges: [],
				tree: {},
			} )
		);
		const { result } = renderHook( () =>
			useExpandedIncludes( [ 'performance', 'job-router' ] )
		);
		await waitFor( () => expect( result.current.loading ).toBe( false ) );
		expect( send ).toHaveBeenCalledWith( {
			to: 'topologies',
			verb: 'expand',
			args: [ 'performance', 'job-router' ],
		} );
		expect( result.current.baseline.nodes ).toEqual( [
			{ name: 'shared-tee' },
		] );
	} );

	it( 'surfaces a cycle error and keeps the last-good baseline', async () => {
		send.mockRejectedValue(
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

	it( 'skips the network round trip when the include set is already cached (distinct from EMPTY)', async () => {
		const primed = {
			nodes: [ { name: 'cached-node' } ],
			edges: [],
			tree: { 'cache-source': {} },
		};
		setExpandedIncludesCache( 'cache-source', primed );

		const { result } = renderHook( () =>
			useExpandedIncludes( [ 'cache-source' ] )
		);

		await waitFor( () => expect( result.current.baseline ).toBe( primed ) );
		expect( send ).not.toHaveBeenCalled();
	} );

	it( 'populates the module cache on a successful fetch so a later caller can read it', async () => {
		send.mockResolvedValue(
			commandReply( {
				nodes: [ { name: 'newly-cached' } ],
				edges: [],
				tree: { 'fresh-source': {} },
			} )
		);
		renderHook( () => useExpandedIncludes( [ 'fresh-source' ] ) );

		await waitFor( () =>
			expect( getExpandedIncludesCache( 'fresh-source' ) ).toBeTruthy()
		);
		expect( getExpandedIncludesCache( 'fresh-source' ).nodes ).toEqual( [
			{ name: 'newly-cached' },
		] );
	} );
} );

describe( 'invalidateExpandedIncludes', () => {
	it( 'drops the cache so a saved topology re-expands', () => {
		// Editing performance.tsl and saving it CHANGES what `include
		// performance` expands to. Without invalidation, reopening combined.tsl
		// would paint the pre-save expansion — stale borrowed nodes, and a save
		// that writes deltas against a baseline the server no longer agrees with.
		setExpandedIncludesCache( 'performance', {
			nodes: [ { name: 'stale-tee' } ],
			edges: [],
			tree: {},
		} );
		expect( getExpandedIncludesCache( 'performance' ) ).toBeDefined();

		invalidateExpandedIncludes();

		expect( getExpandedIncludesCache( 'performance' ) ).toBeUndefined();
	} );
} );
