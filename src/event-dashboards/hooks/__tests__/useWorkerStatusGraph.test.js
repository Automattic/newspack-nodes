/**
 * useWorkerStatusGraph tests — the Worker Status dashboard graph. The three
 * nodes (`workerstatus/poll`, `workerstatus/transform`, `workerstatus/view`) are
 * REAL (their factories register them in Core); only the poll node's command
 * client is injected so the hook never touches the network. The hook owns the
 * poll interval (page-visible only) and the control callbacks. Mirrors
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

describe( 'useWorkerStatusGraph — mount + wiring', () => {
	test( 'mounts the three nodes wired poll→transform→view', async () => {
		const client = makeFakeClient();
		renderHook( () => useWorkerStatusGraph( { commandClient: client } ) );
		await act( async () => {} );
		expect( Core.node( 'workerstatus/poll' ) ).toBeTruthy();
		expect( Core.node( 'workerstatus/transform' ) ).toBeTruthy();
		expect( Core.node( 'workerstatus/view' ) ).toBeTruthy();
		expect( Core.node( 'workerstatus/poll' ).sink ).toBe(
			Core.node( 'workerstatus/transform' )
		);
		expect( Core.node( 'workerstatus/transform' ).sink ).toBe(
			Core.node( 'workerstatus/view' )
		);
	} );

	test( 'fires one immediate poll on mount (the view ends up with a model)', async () => {
		const client = makeFakeClient( { workers: [], logs: [] } );
		renderHook( () => useWorkerStatusGraph( { commandClient: client } ) );
		await act( async () => {} );
		expect( verbsOf( client ) ).toContain( 'dump_metadata' );
		// The metadata flowed poll→transform→view and published a model.
		expect(
			Core.node( 'workerstatus/view' ).setStateCache.view.loading
		).toBe( false );
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
	test( 'unmount unregisters all three nodes', async () => {
		const client = makeFakeClient();
		const { unmount } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		unmount();
		expect( Core.node( 'workerstatus/poll' ) ).toBeNull();
		expect( Core.node( 'workerstatus/transform' ) ).toBeNull();
		expect( Core.node( 'workerstatus/view' ) ).toBeNull();
	} );

	test( 'unmount closes the poll and view nodes before unregistering', async () => {
		const client = makeFakeClient();
		const { unmount } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		const pollClose = jest.spyOn(
			Core.node( 'workerstatus/poll' ),
			'close'
		);
		const viewClose = jest.spyOn(
			Core.node( 'workerstatus/view' ),
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
		const view = Core.node( 'workerstatus/view' );
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
