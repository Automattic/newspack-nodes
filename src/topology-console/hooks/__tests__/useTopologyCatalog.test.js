/**
 * Tests for useTopologyCatalog — the LIVE source of the Path menu's topology
 * partition counts + active set. Seeds from the page-load NewspackNodesData
 * snapshot, then refreshes from `topologies.list` on mount + an interval
 * (external changes) and on demand via reload() (in-console save/delete).
 */

import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
jest.mock( '../../utils/unwrapCommandResponse', () => jest.fn() );
// Controllable visibility: default visible; flip via mockReturnValue per test.
jest.mock( '../../../shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: jest.fn( () => true ),
} ) );

const { getCommandClient } = require( '../../utils/commandClient' );
const unwrapCommandResponse = require( '../../utils/unwrapCommandResponse' );
const usePageVisibility =
	require( '../../../shared/hooks/usePageVisibility' ).default;

import { useTopologyCatalog } from '../useTopologyCatalog';

const listBody = ( topologies ) => ( { topologies } );

describe( 'useTopologyCatalog', () => {
	let send;
	beforeEach( () => {
		send = jest.fn().mockResolvedValue( [] );
		getCommandClient.mockReturnValue( { send } );
		usePageVisibility.mockReturnValue( true );
		window.NewspackNodesData = {
			restUrl: '/wp-json/',
			nonce: 'NONCE',
			topologyWorkers: { demo: 2 },
			activeTopologies: [ 'demo' ],
			configNumPartitions: 1,
		};
		// A list reply that hasn't been overridden resolves to no change.
		unwrapCommandResponse.mockReturnValue(
			listBody( [ { name: 'demo', active: true, num_partitions: 2 } ] )
		);
	} );

	it( 'seeds partitions + active from NewspackNodesData before any fetch resolves', () => {
		const { result } = renderHook( () => useTopologyCatalog() );
		expect( result.current.partitions ).toEqual( { demo: 2 } );
		expect( result.current.active ).toEqual( [ 'demo' ] );
		expect( typeof result.current.reload ).toBe( 'function' );
	} );

	it( 'fetches topologies.list on mount and maps active + num_partitions', async () => {
		unwrapCommandResponse.mockReturnValue(
			listBody( [
				{ name: 'demo', active: true, num_partitions: 3 },
				{ name: 'idle', active: false, num_partitions: 1 },
			] )
		);
		const { result } = renderHook( () => useTopologyCatalog() );
		await waitFor( () =>
			expect( result.current.partitions ).toEqual( { demo: 3, idle: 1 } )
		);
		expect( send ).toHaveBeenCalledWith( {
			to: 'topologies',
			verb: 'list',
		} );
		// Only the active topology appears in the active set.
		expect( result.current.active ).toEqual( [ 'demo' ] );
	} );

	it( 'falls back to configNumPartitions when an entry omits num_partitions', async () => {
		window.NewspackNodesData.configNumPartitions = 4;
		unwrapCommandResponse.mockReturnValue(
			listBody( [ { name: 'demo', active: true } ] )
		);
		const { result } = renderHook( () => useTopologyCatalog() );
		await waitFor( () =>
			expect( result.current.partitions ).toEqual( { demo: 4 } )
		);
	} );

	it( 'reload() triggers a refetch', async () => {
		const { result } = renderHook( () => useTopologyCatalog() );
		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 1 ) );
		await act( async () => {
			result.current.reload();
		} );
		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 2 ) );
	} );

	it( 'polls topologies.list on the interval', async () => {
		jest.useFakeTimers();
		try {
			renderHook( () => useTopologyCatalog( { pollMs: 5000 } ) );
			await act( async () => {} ); // flush the mount fetch
			expect( send ).toHaveBeenCalledTimes( 1 );
			await act( async () => {
				jest.advanceTimersByTime( 5000 );
			} );
			expect( send ).toHaveBeenCalledTimes( 2 );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'does not fetch while the page is hidden, then fetches when it becomes visible', async () => {
		usePageVisibility.mockReturnValue( false );
		const { rerender } = renderHook( () => useTopologyCatalog() );
		await act( async () => {} );
		expect( send ).not.toHaveBeenCalled();
		usePageVisibility.mockReturnValue( true );
		rerender();
		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 1 ) );
	} );

	it( 'keeps the last-good catalog when a refetch rejects', async () => {
		send.mockRejectedValue( new Error( 'boom' ) );
		const { result } = renderHook( () => useTopologyCatalog() );
		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 1 ) );
		// Seed survives the failed fetch — the menu must not blank out.
		expect( result.current.partitions ).toEqual( { demo: 2 } );
		expect( result.current.active ).toEqual( [ 'demo' ] );
	} );

	it( 'keeps the last-good catalog when a successful refetch returns a malformed payload', async () => {
		const { result } = renderHook( () => useTopologyCatalog() );
		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 1 ) );
		// A 200 reply that isn't shaped like a list (no `topologies` array) must
		// NOT overwrite the good catalog — only a thrown error blanked it before.
		unwrapCommandResponse.mockReturnValue( { user_dir: '/d' } );
		await act( async () => {
			result.current.reload();
		} );
		await waitFor( () => expect( send ).toHaveBeenCalledTimes( 2 ) );
		expect( result.current.partitions ).toEqual( { demo: 2 } );
		expect( result.current.active ).toEqual( [ 'demo' ] );
	} );

	it( 'applies a genuinely empty topology list (collapses the menu)', async () => {
		unwrapCommandResponse.mockReturnValue( listBody( [] ) );
		const { result } = renderHook( () => useTopologyCatalog() );
		await waitFor( () => expect( result.current.active ).toEqual( [] ) );
		expect( result.current.partitions ).toEqual( {} );
	} );

	it( 'keeps a stable reference when an interval poll returns identical data', async () => {
		jest.useFakeTimers();
		try {
			const { result } = renderHook( () =>
				useTopologyCatalog( { pollMs: 5000 } )
			);
			await act( async () => {} ); // mount fetch
			const afterFirst = result.current.partitions;
			await act( async () => {
				jest.advanceTimersByTime( 5000 );
			} );
			// Identical poll result must not churn the reference (no consumer re-render).
			expect( result.current.partitions ).toBe( afterFirst );
		} finally {
			jest.useRealTimers();
		}
	} );
} );
