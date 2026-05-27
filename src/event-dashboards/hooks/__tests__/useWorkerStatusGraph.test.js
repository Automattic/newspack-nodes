/**
 * useWorkerStatusGraph tests — the Worker Status dashboard graph clipped onto the
 * exospine (`mountExospine`: _command_interpreter → _router). The three graph
 * nodes (`workerstatus:poll`, `workerstatus:transform`, `workerstatus:view`) are
 * REAL (their factories register them in Core); only the poll node's command
 * client is injected so the hook never touches the network. EVERY node sinks into
 * the CI and steers via `target`; an end-to-end poll reply routes
 * poll → transform → view through the real router. The hook owns the poll
 * interval (page-visible only) and the control callbacks. Mirrors
 * useRawLogsGraph's tests (real graph, faked I/O boundary).
 *
 * usePageVisibility is mocked to `true` so the interval runs under jsdom (matches
 * the WorkerStatus component test).
 */

import { renderHook, act } from '@testing-library/react';
import { newMessage, VALUE } from '../../../runtime/message';
import { Core } from '../../../runtime/core';

jest.mock( '../../../shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => true,
} ) );

import { useWorkerStatusGraph } from '../useWorkerStatusGraph';

const REFRESH_KEY = 'newspack-nodes-worker-refresh';
const CI = '_command_interpreter';

beforeEach( () => {
	Core.reset();
	window.localStorage.clear();
} );

// A fake command client: records each send() and resolves a { name, payload }
// Message so the real unwrapCommandResponse extracts the payload.
function makeFakeClient( payload = { workers: [], logs: [] } ) {
	return {
		calls: [],
		send( req ) {
			this.calls.push( req );
			const m = newMessage();
			m[ VALUE ] = { name: req.verb, payload };
			return Promise.resolve( m );
		},
	};
}

const verbsOf = ( client ) => client.calls.map( ( c ) => c.verb );

describe( 'useWorkerStatusGraph — exospine wiring', () => {
	test( 'mounts the backbone + three nodes, each sinking into the CI', async () => {
		const client = makeFakeClient();
		renderHook( () => useWorkerStatusGraph( { commandClient: client } ) );
		await act( async () => {} );

		const ci = Core.node( CI );
		expect( ci ).toBeTruthy();
		expect( Core.node( '_router' ) ).toBeTruthy();
		for ( const n of [
			'workerstatus:poll',
			'workerstatus:transform',
			'workerstatus:view',
		] ) {
			expect( Core.node( n ) ).toBeTruthy();
			expect( Core.node( n ).sink ).toBe( ci );
		}
	} );

	test( 'steers flow with targets, not bespoke sinks', async () => {
		const client = makeFakeClient();
		renderHook( () => useWorkerStatusGraph( { commandClient: client } ) );
		await act( async () => {} );
		expect( Core.node( 'workerstatus:poll' ).target ).toBe(
			'workerstatus:transform'
		);
		expect( Core.node( 'workerstatus:transform' ).target ).toBe(
			'workerstatus:view'
		);
	} );

	test( 'fires one immediate poll on mount (the view ends up with a model)', async () => {
		const client = makeFakeClient( { workers: [], logs: [] } );
		renderHook( () => useWorkerStatusGraph( { commandClient: client } ) );
		await act( async () => {} );
		expect( verbsOf( client ) ).toContain( 'dump_metadata' );
		// The metadata routed poll→transform→view through the router and published.
		expect(
			Core.node( 'workerstatus:view' ).setStateCache.view.loading
		).toBe( false );
	} );
} );

describe( 'useWorkerStatusGraph — end-to-end routing through the exospine', () => {
	test( 'an immediate poll reply routes poll → transform → view and lands in the view model', async () => {
		const meta = {
			workers: [
				{
					type: 'firehose-workers',
					handler: 'firehose-workers',
					partition: 0,
				},
			],
			logs: [ { name: 'firehose.log', partitions: [] } ],
		};
		const client = makeFakeClient( meta );
		renderHook( () => useWorkerStatusGraph( { commandClient: client } ) );
		await act( async () => {} );

		// The metadata actually routed all the way to the view via the real router:
		// the published model carries the snapshot's workers + logs.
		const view = Core.node( 'workerstatus:view' );
		expect( view.setStateCache.view.workers ).toEqual( meta.workers );
		expect( view.setStateCache.view.logs ).toEqual( meta.logs );
		expect( view.setStateCache.view.error ).toBeNull();
	} );
} );

describe( 'useWorkerStatusGraph — poll interval', () => {
	test( 'polls again on each interval tick while page-visible', async () => {
		jest.useFakeTimers();
		try {
			const client = makeFakeClient();
			renderHook( () =>
				useWorkerStatusGraph( {
					commandClient: client,
					refreshMs: 2000,
				} )
			);
			// Immediate mount poll.
			await act( async () => {} );
			const afterMount = client.calls.length;
			expect( afterMount ).toBeGreaterThanOrEqual( 1 );
			// One interval tick → one more dump_metadata.
			await act( async () => {
				jest.advanceTimersByTime( 2000 );
			} );
			expect( client.calls.length ).toBe( afterMount + 1 );
		} finally {
			jest.useRealTimers();
		}
	} );
} );

describe( 'useWorkerStatusGraph — control callbacks', () => {
	test( 'restart(type) sends a restart command for that type', async () => {
		const client = makeFakeClient();
		const { result } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		client.calls.length = 0;
		await act( async () => {
			await result.current.restart( 'firehose-workers' );
		} );
		expect( client.calls ).toContainEqual( {
			to: 'workers',
			verb: 'restart',
			payload: { types: [ 'firehose-workers' ], partition: -1 },
		} );
	} );

	test( 'setRefreshInterval persists the choice to localStorage', async () => {
		const client = makeFakeClient();
		const { result } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		act( () => result.current.setRefreshInterval( '5000' ) );
		expect( window.localStorage.getItem( REFRESH_KEY ) ).toBe( '5000' );
	} );

	test( 'refreshMs reflects the persisted/selected interval', async () => {
		const client = makeFakeClient();
		const { result } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		act( () => result.current.setRefreshInterval( '10000' ) );
		expect( result.current.refreshMs ).toBe( '10000' );
	} );

	test( 'restores the persisted refresh interval on mount', async () => {
		window.localStorage.setItem( REFRESH_KEY, '10000' );
		const client = makeFakeClient();
		const { result } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		expect( result.current.refreshMs ).toBe( '10000' );
	} );
} );

describe( 'useWorkerStatusGraph — teardown', () => {
	test( 'unmount unregisters the graph + the backbone', async () => {
		const client = makeFakeClient();
		const { unmount } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		unmount();
		for ( const n of [
			'workerstatus:poll',
			'workerstatus:transform',
			'workerstatus:view',
			'_command_interpreter',
			'_router',
		] ) {
			expect( Core.node( n ) ).toBeNull();
		}
	} );

	test( 'unmount closes the poll and view nodes before unregistering', async () => {
		const client = makeFakeClient();
		const { unmount } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		const pollClose = jest.spyOn(
			Core.node( 'workerstatus:poll' ),
			'close'
		);
		const viewClose = jest.spyOn(
			Core.node( 'workerstatus:view' ),
			'close'
		);
		unmount();
		expect( pollClose ).toHaveBeenCalledTimes( 1 );
		expect( viewClose ).toHaveBeenCalledTimes( 1 );
	} );

	test( 'no emit after unmount when an in-flight poll resolves late', async () => {
		// Deferred client: the mount poll stays in flight until we resolve it,
		// letting us unmount mid-poll and confirm nothing lands in the view.
		let resolveSend;
		const client = {
			calls: [],
			send( req ) {
				this.calls.push( req );
				return new Promise( ( resolve ) => {
					resolveSend = () => {
						const m = newMessage();
						m[ VALUE ] = {
							name: req.verb,
							payload: { workers: [] },
						};
						resolve( m );
					};
				} );
			},
		};
		const { unmount } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		const view = Core.node( 'workerstatus:view' );
		const setStateSpy = jest.spyOn( view, 'setState' );
		// Unmount with the mount poll still pending, then let it resolve.
		unmount();
		await act( async () => {
			resolveSend();
		} );
		expect( setStateSpy ).not.toHaveBeenCalled();
	} );

	test( 'no further polls after unmount (interval cleared)', async () => {
		jest.useFakeTimers();
		try {
			const client = makeFakeClient();
			const { unmount } = renderHook( () =>
				useWorkerStatusGraph( {
					commandClient: client,
					refreshMs: 2000,
				} )
			);
			await act( async () => {} );
			unmount();
			const after = client.calls.length;
			await act( async () => {
				jest.advanceTimersByTime( 10000 );
			} );
			expect( client.calls.length ).toBe( after );
		} finally {
			jest.useRealTimers();
		}
	} );
} );
