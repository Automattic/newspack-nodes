/* eslint-disable no-bitwise -- TYPE field uses bitmask flags (Tachikoma convention). */
/**
 * useWorkerStatusGraph tests — the Worker Status dashboard graph clipped onto
 * the substrate's I/O boundary nodes (exospine + `_http`) plus the
 * `workerstatus:transform` and `workerstatus:view` chain. Migrated from the
 * bespoke `workerstatus:poll` Node to the substrate's HttpOut: the hook owns a
 * setInterval that fires a TM_COMMAND (FROM=`workerstatus:transform` for
 * fire-and-forget poll, FROM=`workerstatus:view` for awaited restart) through
 * the CI. _http.client is injected so the hook never touches the network.
 *
 * The view follows the canonical pending-Map pattern: `restart()` returns a
 * Promise the view resolves/rejects by matching `message[ID]` against
 * `pending`. Mirrors useAggregatorAdminGraph.
 */

import { renderHook, act } from '@testing-library/react';
import {
	newMessage,
	TIMESTAMP,
	ID,
	TO,
	FROM,
	VALUE,
	TYPE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';

jest.mock( '../../../shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => true,
} ) );

import { useWorkerStatusGraph } from '../useWorkerStatusGraph';

const REFRESH_KEY = 'newspack-nodes-worker-refresh';
const CI = '_command_interpreter';
const ROUTER = '_router';
const HTTP = '_http';
const TRANSFORM = 'workerstatus:transform';
const VIEW = 'workerstatus:view';
const ALL_GRAPH_NAMES = [ HTTP, TRANSFORM, VIEW ];

beforeEach( () => {
	Core.reset();
	window.localStorage.clear();
} );

// A fake CommandClient matching HttpOut's seam: postBatch returns reply
// Messages addressed back along FROM (the server's reply pivot). Reply
// payload is keyed by verb so dump_metadata yields the metadata snapshot and
// restart yields a no-op ack. opts.errorVerbs marks verbs whose replies carry
// TM_ERROR (caller is responsible for the pending-Map rejection path).
function makeFakeClient( payloadByVerb = {}, opts = {} ) {
	const client = {
		batches: [],
		buildMessage( { to, verb, args = '', payload = null } ) {
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ TO ] = to;
			m[ VALUE ] = { name: verb, arguments: args, payload };
			return m;
		},
		postBatch( messages ) {
			client.batches.push( messages );
			const replies = messages.map( ( m ) => {
				const reply = newMessage();
				reply[ TYPE ] =
					opts.errorVerbs &&
					opts.errorVerbs.includes( m[ VALUE ]?.name )
						? TM_COMMAND | TM_RESPONSE | TM_ERROR
						: TM_COMMAND | TM_RESPONSE;
				reply[ TO ] = m[ FROM ];
				reply[ ID ] = m[ ID ];
				reply[ VALUE ] = {
					name: m[ VALUE ]?.name,
					payload:
						payloadByVerb[ m[ VALUE ]?.name ] ??
						payloadByVerb._default ??
						null,
				};
				if ( opts.now ) {
					reply[ TIMESTAMP ] = opts.now;
				}
				return reply;
			} );
			return Promise.resolve( replies );
		},
	};
	return client;
}

// Iterate every batched message and pull out its verb name (each batch is one
// router-tick worth of TM_COMMANDs).
const verbsOf = ( client ) =>
	client.batches.flat().map( ( m ) => m[ VALUE ]?.name );

describe( 'useWorkerStatusGraph — exospine + I/O boundary wiring', () => {
	test( 'mounts the backbone + the I/O boundary node + transform + view, each sinking into the CI', async () => {
		const client = makeFakeClient();
		renderHook( () => useWorkerStatusGraph( { commandClient: client } ) );
		await act( async () => {} );

		const ci = Core.node( CI );
		expect( ci ).toBeTruthy();
		expect( Core.node( ROUTER ) ).toBeTruthy();
		for ( const name of ALL_GRAPH_NAMES ) {
			const node = Core.node( name );
			expect( node ).toBeTruthy();
			expect( node.sink ).toBe( ci );
		}
	} );

	test( '_http has the injected CommandClient as its client', async () => {
		const client = makeFakeClient();
		renderHook( () => useWorkerStatusGraph( { commandClient: client } ) );
		await act( async () => {} );
		expect( Core.node( HTTP ).client ).toBe( client );
	} );

	test( 'transform targets the view (so the model routes through _router)', async () => {
		const client = makeFakeClient();
		renderHook( () => useWorkerStatusGraph( { commandClient: client } ) );
		await act( async () => {} );
		expect( Core.node( TRANSFORM ).target ).toBe( VIEW );
	} );

	test( 'fires one immediate dump_metadata on mount addressed to _http/workers', async () => {
		const client = makeFakeClient( { dump_metadata: { workers: [] } } );
		renderHook( () => useWorkerStatusGraph( { commandClient: client } ) );
		await act( async () => {} );
		expect( client.batches.length ).toBeGreaterThanOrEqual( 1 );
		const msg = client.batches[ 0 ][ 0 ];
		// HttpOut strips `_http/` so it's `workers` at postBatch time.
		expect( msg[ TO ] ).toBe( 'workers' );
		expect( msg[ FROM ] ).toBe( TRANSFORM );
		expect( msg[ VALUE ].name ).toBe( 'dump_metadata' );
	} );
} );

describe( 'useWorkerStatusGraph — end-to-end routing through the exospine', () => {
	test( 'an immediate poll reply routes _http → transform → view and lands in the view model', async () => {
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
		const client = makeFakeClient( { dump_metadata: meta } );
		renderHook( () => useWorkerStatusGraph( { commandClient: client } ) );
		await act( async () => {} );

		const view = Core.node( VIEW );
		expect( view.setStateCache.view.workers ).toEqual( meta.workers );
		expect( view.setStateCache.view.logs ).toEqual( meta.logs );
		expect( view.setStateCache.view.error ).toBeNull();
		expect( view.setStateCache.view.loading ).toBe( false );
	} );
} );

describe( 'useWorkerStatusGraph — poll interval', () => {
	test( 'polls again on each interval tick while page-visible', async () => {
		jest.useFakeTimers();
		try {
			const client = makeFakeClient( { dump_metadata: { workers: [] } } );
			renderHook( () =>
				useWorkerStatusGraph( {
					commandClient: client,
					refreshMs: 2000,
				} )
			);
			await act( async () => {} );
			const afterMount = verbsOf( client ).filter(
				( v ) => 'dump_metadata' === v
			).length;
			expect( afterMount ).toBeGreaterThanOrEqual( 1 );
			await act( async () => {
				jest.advanceTimersByTime( 2000 );
			} );
			const afterTick = verbsOf( client ).filter(
				( v ) => 'dump_metadata' === v
			).length;
			expect( afterTick ).toBe( afterMount + 1 );
		} finally {
			jest.useRealTimers();
		}
	} );
} );

describe( 'useWorkerStatusGraph — control callbacks', () => {
	test( 'restart(type) sends a restart command (FROM=view) with the type and partition -1', async () => {
		const client = makeFakeClient( {
			dump_metadata: { workers: [] },
			restart: { ok: true },
		} );
		const { result } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		client.batches.length = 0;
		await act( async () => {
			await result.current.restart( 'firehose-workers' );
		} );
		const restartMsg = client.batches
			.flat()
			.find( ( m ) => 'restart' === m[ VALUE ]?.name );
		expect( restartMsg ).toBeTruthy();
		expect( restartMsg[ TO ] ).toBe( 'workers' );
		expect( restartMsg[ FROM ] ).toBe( VIEW );
		expect( restartMsg[ VALUE ].payload ).toEqual( {
			types: [ 'firehose-workers' ],
			partition: -1,
		} );
	} );

	test( 'restart(type) resolves the Promise via the view pending Map on success', async () => {
		const client = makeFakeClient( {
			dump_metadata: { workers: [] },
			restart: { restarted: 3 },
		} );
		const { result } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		let resolved;
		await act( async () => {
			resolved = await result.current.restart( 'firehose-workers' );
		} );
		expect( resolved ).toEqual( { restarted: 3 } );
	} );

	test( 'restart(type) rejects when the reply carries TM_ERROR', async () => {
		const client = makeFakeClient(
			{
				dump_metadata: { workers: [] },
				restart: 'permission denied',
			},
			{ errorVerbs: [ 'restart' ] }
		);
		const { result } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		await act( async () => {
			await expect(
				result.current.restart( 'firehose-workers' )
			).rejects.toThrow( /permission denied/i );
		} );
	} );

	test( 'a pending-matched restart error does NOT pollute the global view.error', async () => {
		const client = makeFakeClient(
			{
				dump_metadata: { workers: [] },
				restart: 'permission denied',
			},
			{ errorVerbs: [ 'restart' ] }
		);
		const { result } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		await act( async () => {
			await result.current
				.restart( 'firehose-workers' )
				.catch( () => {} );
		} );
		// Pending-matched errors are owned by the caller's catch; the view
		// model's global error stays null.
		expect( Core.node( VIEW ).setStateCache.view.error ).toBeNull();
	} );

	test( 'setRefreshInterval persists the choice to localStorage', async () => {
		const client = makeFakeClient( { dump_metadata: { workers: [] } } );
		const { result } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		act( () => result.current.setRefreshInterval( '5000' ) );
		expect( window.localStorage.getItem( REFRESH_KEY ) ).toBe( '5000' );
	} );

	test( 'refreshMs reflects the persisted/selected interval', async () => {
		const client = makeFakeClient( { dump_metadata: { workers: [] } } );
		const { result } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		act( () => result.current.setRefreshInterval( '10000' ) );
		expect( result.current.refreshMs ).toBe( '10000' );
	} );

	test( 'restores the persisted refresh interval on mount', async () => {
		window.localStorage.setItem( REFRESH_KEY, '10000' );
		const client = makeFakeClient( { dump_metadata: { workers: [] } } );
		const { result } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		expect( result.current.refreshMs ).toBe( '10000' );
	} );
} );

describe( 'useWorkerStatusGraph — teardown', () => {
	test( 'unmount unregisters the graph + the backbone', async () => {
		const client = makeFakeClient( { dump_metadata: { workers: [] } } );
		const { unmount } = renderHook( () =>
			useWorkerStatusGraph( { commandClient: client } )
		);
		await act( async () => {} );
		unmount();
		for ( const name of [ ...ALL_GRAPH_NAMES, CI, ROUTER ] ) {
			expect( Core.node( name ) ).toBeNull();
		}
	} );

	test( 'no further polls after unmount (interval cleared)', async () => {
		jest.useFakeTimers();
		try {
			const client = makeFakeClient( { dump_metadata: { workers: [] } } );
			const { unmount } = renderHook( () =>
				useWorkerStatusGraph( {
					commandClient: client,
					refreshMs: 2000,
				} )
			);
			await act( async () => {} );
			unmount();
			const after = client.batches.length;
			await act( async () => {
				jest.advanceTimersByTime( 10000 );
			} );
			expect( client.batches.length ).toBe( after );
		} finally {
			jest.useRealTimers();
		}
	} );
} );
