/**
 * useTopologyManager hook tests — the REAL topology-manager graph driving the
 * hook's data contract, with only the `_http` I/O boundary faked.
 *
 * A recording CommandClient double answers `topologies list` (two topologies:
 * `a` active with a worker-status section, `b` inactive) and `dump_graph` (a
 * snapshot whose graph carries the active topology). We assert:
 *  (a) `topologies` has both rows, active `a` carrying a non-null `status` and
 *      inactive `b` a null `status`, each with the right `source` / `active`;
 *  (b) `await deactivate('a')` dispatched `topologies deactivate a`;
 *  (c) `await activate('b')` dispatched `topologies activate b`;
 *  (d) `restart` dispatches the worker `restart` verb.
 *
 * The fake client records every posted command into `sent` so dispatch can be
 * asserted from the recorded sends (mirrors the worker-status integration
 * harness, plus a `sent` log).
 */

import { renderHook, act } from '@testing-library/react';
import {
	newMessage,
	TYPE,
	TO,
	ID,
	FROM,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from '../../runtime/message';
import { Core } from '../../runtime/core';
import { useTopologyManager } from '../hooks/useTopologyManager';

let mockPageVisible = true;
jest.mock( '../../shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => mockPageVisible,
} ) );

// Recording CommandClient double: postBatch records sends, resolves replies.
function makeRecordingClient( payloadByVerb = {}, errorVerbs = new Set() ) {
	const sent = [];
	const client = {
		buildMessage( { to, verb, args = '' } ) {
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ TO ] = to;
			m[ VALUE ] = { name: verb, arguments: args };
			return m;
		},
		postBatch( messages ) {
			const replies = messages.map( ( m ) => {
				const verb = m[ VALUE ]?.name;
				sent.push( {
					verb,
					args: m[ VALUE ]?.arguments ?? '',
					to: m[ TO ],
				} );
				const reply = newMessage();
				reply[ TYPE ] = errorVerbs.has( verb )
					? TM_COMMAND | TM_RESPONSE | TM_ERROR
					: TM_COMMAND | TM_RESPONSE;
				reply[ TO ] = m[ FROM ];
				reply[ ID ] = m[ ID ];
				reply[ VALUE ] = {
					name: verb,
					payload:
						payloadByVerb[ verb ] ?? payloadByVerb._default ?? null,
				};
				return reply;
			} );
			return Promise.resolve( replies );
		},
	};
	return { client, sent };
}

// A dump_graph snapshot whose graph carries the active topology `a`.
const DUMP_GRAPH = {
	workers: [
		{
			type: 'a',
			handler: 'a',
			partition: 0,
			started_at: 1000,
			status: 'running',
			inputs: [],
			outputs: [],
			inputs_status: [],
			outputs_status: [],
		},
	],
	supervisor: {
		type: 'supervisor',
		status: 'running',
		started_at: 1000,
		heartbeat_age: 2,
		restart_pending: false,
	},
	logs: [
		{
			name: 'a-log',
			segment_size: 64 * 1024 * 1024,
			partitions: [
				{
					partition: 0,
					segments: [ { id: 0, size: 1024, mtime: 1000 } ],
					total_size: 1024,
				},
			],
		},
	],
	graph: {
		a: { nodes: [ { name: 'a', kind: 'logic' } ], edges: [] },
	},
};

// A topologies-list reply: `a` active (in the dump_graph), `b` inactive.
const TOPOLOGIES_LIST = {
	topologies: [
		{ name: 'a', source: 'stock', active: true, num_partitions: 1 },
		{ name: 'b', source: 'user', active: false, num_partitions: 2 },
	],
	user_dir: '/tmp/topologies',
};

function buildClient() {
	return makeRecordingClient( {
		dump_graph: DUMP_GRAPH,
		list: TOPOLOGIES_LIST,
		activate: { name: 'b', active: true, spawned: 2 },
		deactivate: { name: 'a', active: false },
		restart: { restarted: true },
	} );
}

// Answers the FIRST poll, then wedges: later polls never reply at all.
function wedgingClient() {
	const { client } = buildClient();
	let answered = false;
	return {
		buildMessage: client.buildMessage,
		postBatch: ( messages ) => {
			if ( answered ) {
				return Promise.resolve( [] );
			}
			answered = true;
			return client.postBatch( messages );
		},
	};
}

beforeEach( () => {
	Core.reset();
	window.localStorage.clear();
	mockPageVisible = true;
} );

describe( 'useTopologyManager', () => {
	it( 'surfaces every topology (active + inactive) with provenance + active flag', async () => {
		const { client } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		const { topologies } = result.current;
		expect( topologies ).toHaveLength( 2 );

		const byName = Object.fromEntries(
			topologies.map( ( t ) => [ t.name, t ] )
		);
		expect( byName.a.active ).toBe( true );
		expect( byName.a.source ).toBe( 'stock' );
		expect( byName.b.active ).toBe( false );
		expect( byName.b.source ).toBe( 'user' );
	} );

	it( 'merges the live worker-status section onto the active topology only', async () => {
		const { client } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		const byName = Object.fromEntries(
			result.current.topologies.map( ( t ) => [ t.name, t ] )
		);
		expect( byName.a.status ).not.toBeNull();
		expect( byName.b.status ).toBeNull();
	} );

	it( 'enriches the active section with the worker-status rate/segment/time slices', async () => {
		const { client } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		const status = result.current.topologies.find(
			( t ) => 'a' === t.name
		).status;
		// The enriched WorkerStatus model, not a degraded reduction.
		expect( status ).toHaveProperty( 'byteRates' );
		expect( status ).toHaveProperty( 'writeRates' );
		expect( status ).toHaveProperty( 'prevSegments' );
		expect( status ).toHaveProperty( 'removingSegments' );
		expect( status ).toHaveProperty( 'segmentSize' );
		expect( status ).toHaveProperty( 'currentTime' );
	} );

	it( 'attaches the logs catalog (model.logs) to the active topology status', async () => {
		const { client } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		const status = result.current.topologies.find(
			( t ) => 'a' === t.name
		).status;
		expect( status ).toHaveProperty( 'logs' );
		expect( Array.isArray( status.logs ) ).toBe( true );
		const log = status.logs.find( ( l ) => 'a-log' === l.name );
		expect( log ).toBeTruthy();
		expect( log.partitions[ 0 ].segments ).toHaveLength( 1 );
	} );

	it( 'passes the supervisor card model through', async () => {
		const { client } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );
		expect( result.current.supervisor ).not.toBeNull();
		expect( result.current.supervisor.type ).toBe( 'supervisor' );
	} );

	it( 'exposes currentTime from the worker-status model', async () => {
		const { client } = healthClient( {
			heartbeatIntervalS: 10,
			currentTime: 2000,
			workers: [ worker( 0, { heartbeatAge: 5, behind: 0 } ) ],
		} );
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );
		expect( result.current.currentTime ).toBe( 2000 );
	} );

	it( 'deactivate dispatches `topologies deactivate <name>`', async () => {
		const { client, sent } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		await act( async () => {
			await result.current.deactivate( 'a' );
		} );

		const deactivateSend = sent.find( ( s ) => 'deactivate' === s.verb );
		expect( deactivateSend ).toBeTruthy();
		expect( deactivateSend.args ).toEqual( [ 'a' ] );
	} );

	it( 'activate dispatches `topologies activate <name>`', async () => {
		const { client, sent } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		await act( async () => {
			await result.current.activate( 'b' );
		} );

		const activateSend = sent.find( ( s ) => 'activate' === s.verb );
		expect( activateSend ).toBeTruthy();
		expect( activateSend.args ).toEqual( [ 'b' ] );
	} );

	it( 'restart is exposed and dispatches the worker restart verb', async () => {
		const { client, sent } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		expect( typeof result.current.restart ).toBe( 'function' );
		await act( async () => {
			await result.current.restart( 'a' );
		} );

		const restartSend = sent.find( ( s ) => 'restart' === s.verb );
		expect( restartSend ).toBeTruthy();
		expect( restartSend.args ).toEqual( [ 'a' ] );
	} );

	it( 'activate rejects when the server replies TM_ERROR', async () => {
		const { client } = makeRecordingClient(
			{
				dump_graph: DUMP_GRAPH,
				list: TOPOLOGIES_LIST,
				activate: { message: 'topology not found' },
			},
			new Set( [ 'activate' ] )
		);
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		await act( async () => {
			await expect( result.current.activate( 'x' ) ).rejects.toThrow(
				'topology not found'
			);
		} );
	} );

	it( 'each poll fires both dump_graph and topologies list', async () => {
		const { client, sent } = buildClient();
		renderHook( () => useTopologyManager( { commandClient: client } ) );
		await act( async () => {} );

		expect( sent.some( ( s ) => 'dump_graph' === s.verb ) ).toBe( true );
		expect( sent.some( ( s ) => 'list' === s.verb ) ).toBe( true );
	} );

	it( 'is a genuine node graph: toolkit boundary + a Fetcher per slice fanned from the owned Tee', async () => {
		const { client } = buildClient();
		renderHook( () => useTopologyManager( { commandClient: client } ) );
		await act( async () => {} );

		// useBatchedPoll owns the I/O boundary, fan-out Tee, hitchhike Timer.
		for ( const name of [
			'_http',
			'_shell',
			'topologymanager:timer',
			'topologymanager:tee',
		] ) {
			expect( Core.node( name ) ).toBeTruthy();
		}
		// One Fetcher per slice, each fanned from the owned Tee.
		for ( const fetcher of [ 'fetch-workers', 'fetch-topologies' ] ) {
			expect( Core.node( fetcher ) ).toBeTruthy();
		}
		expect( Core.node( 'topologymanager:tee' ).target ).toEqual(
			expect.arrayContaining( [ 'fetch-workers', 'fetch-topologies' ] )
		);
	} );

	it( 'puts WorkerStatusTransform on a graph edge: the receiver Tee fans to the transform, the transform targets the worker view', async () => {
		const { client } = buildClient();
		renderHook( () => useTopologyManager( { commandClient: client } ) );
		await act( async () => {} );

		// Transform rides the receiver-Tee to view edge, NOT inside the view.
		const transform = Core.node( 'workerstatus:transform' );
		expect( transform ).toBeTruthy();
		expect( transform.target ).toBe( 'workerstatus:view' );
		// The worker-status receiver Tee fans its reply into the transform.
		expect( Core.node( 'workerstatus:in' ).target ).toEqual(
			expect.arrayContaining( [ 'workerstatus:transform' ] )
		);
	} );

	it( 'one poll tick batches both slice commands into ONE HttpOut POST', async () => {
		const recording = [];
		const client = {
			buildMessage: buildClient().client.buildMessage,
			postBatch( messages ) {
				recording.push( messages );
				return buildClient().client.postBatch( messages );
			},
		};
		renderHook( () => useTopologyManager( { commandClient: client } ) );
		await act( async () => {} );
		recording.length = 0;

		await act( async () => {
			Core.node( '_router' ).fireCb();
		} );

		expect( recording.length ).toBe( 1 );
		const verbs = recording[ 0 ].map( ( m ) => m[ VALUE ].name ).sort();
		expect( verbs ).toEqual( [ 'dump_graph', 'list' ] );
	} );

	it( 'exposes connected state', async () => {
		const { client } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );
		expect( result.current ).toHaveProperty( 'connected' );
	} );

	it( 'goes disconnected when the channel wedges past three poll intervals', async () => {
		// Fake timers drive the poll interval AND Date.now, aging the clock.
		jest.useFakeTimers();
		try {
			const { result, rerender } = renderHook( () =>
				useTopologyManager( {
					commandClient: wedgingClient(),
					refreshMs: 4000,
				} )
			);
			await act( async () => {} );
			// First poll succeeded → connected.
			expect( result.current.connected ).toBe( true );

			// Under 3 × 4000ms of silence is still fresh…
			await act( async () => jest.advanceTimersByTime( 11000 ) );
			rerender();
			expect( result.current.connected ).toBe( true );

			// …past it, the wedged channel reads as disconnected.
			await act( async () => jest.advanceTimersByTime( 2000 ) );
			rerender();
			expect( result.current.connected ).toBe( false );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'stays connected while a hidden tab ages the clock (polling is paused)', async () => {
		jest.useFakeTimers();
		try {
			const { result, rerender } = renderHook( () =>
				useTopologyManager( {
					commandClient: wedgingClient(),
					refreshMs: 4000,
				} )
			);
			await act( async () => {} );

			// Hidden: the same silence that wedges a visible tab is expected.
			mockPageVisible = false;
			await act( async () => jest.advanceTimersByTime( 13000 ) );
			rerender();
			expect( result.current.connected ).toBe( true );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'reports disconnected when a poll reply comes back TM_ERROR', async () => {
		const { client } = makeRecordingClient(
			{
				dump_graph: DUMP_GRAPH,
				list: { message: 'topologies unavailable' },
			},
			new Set( [ 'list' ] )
		);
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );
		expect( result.current.connected ).toBe( false );
	} );

	it( 'does not flash disconnected before the very first poll lands', async () => {
		const { client } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		// Nothing has polled yet; the never-stamped clock is not "stale".
		expect( result.current.connected ).toBe( true );
		await act( async () => {} );
	} );

	it( 'stays connected while replies keep arriving (fresh polls)', async () => {
		const { client } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );
		expect( result.current.connected ).toBe( true );
	} );
} );

// LEAN dump_graph payload: per-partition liveness + probe rows to workers.
function healthDump( {
	workers,
	heartbeatIntervalS = 10,
	currentTime,
	cursorOffset = 0,
} ) {
	const dump = {
		// Liveness only — heartbeat_age + status per (type, partition).
		workers: workers.map( ( w ) => ( {
			type: w.type,
			partition: w.partition,
			status: w.status,
			started_at: w.started_at,
			heartbeat_age: w.heartbeat_age,
			heartbeat_at: 999,
			live: 'running' === w.status,
			stale: 'stale' === w.status,
			restart_pending: false,
		} ) ),
		// Probe STATE — `distance` reconstructs to `behind`.
		consumers: workers.map( ( w ) => ( {
			reader: `a.p${ w.partition }`,
			source: `a.p${ w.partition }`,
			partition: w.partition,
			cursor_segment: 0,
			cursor_offset: cursorOffset,
			end_segment: 0,
			end_size: 0,
			distance: w.behind,
			msgs: 0,
		} ) ),
		supervisor: {
			type: 'supervisor',
			status: 'running',
			started_at: 1000,
			heartbeat_age: 2,
			restart_pending: false,
		},
		logs: workers.map( ( w ) => ( {
			name: `a.p${ w.partition }`,
			partitions: [
				{ partition: w.partition, segments: [], total_size: 0 },
			],
			segment_size: 16 * 1024 * 1024,
		} ) ),
		graph: {
			a: {
				nodes: [
					{ name: 'a-in', kind: 'consumer', reads: 'a.p<partition>' },
					{ name: 'a-log', kind: 'log', writes: 'a.p<partition>' },
				],
				edges: [ [ 'a-in', 'a-log' ] ],
			},
		},
	};
	if ( heartbeatIntervalS !== undefined ) {
		dump.heartbeat_interval_s = heartbeatIntervalS;
	}
	if ( currentTime !== undefined ) {
		dump.timestamp = currentTime;
	}
	return dump;
}

const TOPOLOGY_A_LIST = {
	topologies: [
		{ name: 'a', source: 'stock', active: true, num_partitions: 2 },
	],
	user_dir: '/tmp/topologies',
};

// Single-poll client over the lean dump: read_rate has no delta yet, so 0.
function healthClient( opts ) {
	return makeRecordingClient( {
		dump_graph: healthDump( opts ),
		list: TOPOLOGY_A_LIST,
	} );
}

// A lean per-partition fixture: liveness (status/heartbeat_age) + probe behind.
function worker( partition, { heartbeatAge, behind, status = 'running' } ) {
	return {
		type: 'a',
		partition,
		status,
		started_at: 1000,
		heartbeat_age: heartbeatAge,
		behind,
	};
}

// Poll once with the lean dump; return topology `a`'s merged row.
async function pollHealth( opts ) {
	const { client } = healthClient( opts );
	const { result } = renderHook( () =>
		useTopologyManager( { commandClient: client } )
	);
	await act( async () => {} );
	return result.current.topologies.find( ( t ) => 'a' === t.name );
}

/**
 * Poll TWICE with an advancing cursor and clock, so the transform has a real
 * read-rate delta to hand the health roll-up: 500 bytes over 50s = 10 B/s.
 * A single poll can only ever produce rate 0 (nothing to delta against).
 *
 * @param {Array} workers Lean per-partition fixtures.
 * @return {Object} Topology `a`'s merged row after the second poll.
 */
async function pollHealthAtTenBytesPerSecond( workers ) {
	const payloads = {
		dump_graph: healthDump( { workers, currentTime: 1000 } ),
		list: TOPOLOGY_A_LIST,
	};
	const { client } = makeRecordingClient( payloads );
	const { result } = renderHook( () =>
		useTopologyManager( { commandClient: client } )
	);
	await act( async () => {} );
	payloads.dump_graph = healthDump( {
		workers,
		currentTime: 1050,
		cursorOffset: 500,
	} );
	await act( async () => {
		Core.node( '_router' ).fireCb();
	} );
	return result.current.topologies.find( ( t ) => 'a' === t.name );
}

describe( 'useTopologyManager — partition stall + rolled-up health', () => {
	it( 'stalls a partition only past heartbeat interval × 3', async () => {
		const row = await pollHealth( {
			heartbeatIntervalS: 10,
			workers: [
				worker( 0, { heartbeatAge: 29, behind: 0 } ),
				worker( 1, { heartbeatAge: 31, behind: 0 } ),
			],
		} );
		const byPart = Object.fromEntries(
			row.partitions.map( ( p ) => [ p.partition, p ] )
		);
		expect( byPart[ 0 ].stalled ).toBe( false );
		expect( byPart[ 1 ].stalled ).toBe( true );
		expect( row.health ).toBe( 'stalled' );
	} );

	it( 'rolls up to health=behind when no partition stalled but a consumer is behind', async () => {
		const row = await pollHealth( {
			heartbeatIntervalS: 10,
			workers: [
				worker( 0, { heartbeatAge: 5, behind: 0 } ),
				worker( 1, { heartbeatAge: 5, behind: 4096 } ),
			],
		} );
		expect( row.partitions.every( ( p ) => ! p.stalled ) ).toBe( true );
		expect( row.health ).toBe( 'behind' );
		// No read progress at all — the catch-up ETA never arrives.
		expect( row.etaSeconds ).toBe( Infinity );
	} );

	it( 'lets a heartbeat stall outrank a behind consumer', async () => {
		const row = await pollHealth( {
			heartbeatIntervalS: 10,
			workers: [ worker( 0, { heartbeatAge: 40, behind: 4096 } ) ],
		} );
		expect( row.health ).toBe( 'stalled' );
	} );

	it( 'does NOT count a sub-minute catch-up ETA as behind', async () => {
		// 100 bytes behind at 10 B/s = a 10s ETA — caught up enough.
		const row = await pollHealthAtTenBytesPerSecond( [
			worker( 0, { heartbeatAge: 5, behind: 100 } ),
		] );
		expect( row.health ).toBe( 'ok' );
		expect( row.etaSeconds ).toBe( 10 );
	} );

	it( 'counts a >=1min ETA as behind and reports the WORST partition eta', async () => {
		const row = await pollHealthAtTenBytesPerSecond( [
			worker( 0, { heartbeatAge: 5, behind: 100 } ),
			worker( 1, { heartbeatAge: 5, behind: 6000 } ),
		] );
		expect( row.health ).toBe( 'behind' );
		expect( row.etaSeconds ).toBe( 600 );
	} );

	it( 'gives an inactive topology no partitions, health ok, and eta 0', async () => {
		const { client } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		const row = result.current.topologies.find( ( t ) => 'b' === t.name );
		expect( row.status ).toBeNull();
		expect( row.partitions ).toEqual( [] );
		expect( row.health ).toBe( 'ok' );
		expect( row.etaSeconds ).toBe( 0 );
	} );

	it( 'rolls up to health=ok when nothing is stalled or behind', async () => {
		const row = await pollHealth( {
			heartbeatIntervalS: 10,
			workers: [
				worker( 0, { heartbeatAge: 5, behind: 0 } ),
				worker( 1, { heartbeatAge: 5, behind: 0 } ),
			],
		} );
		expect( row.health ).toBe( 'ok' );
		expect( row.etaSeconds ).toBe( 0 );
	} );

	it( 'does not flag a never-heartbeated worker (heartbeat_age null) as stalled', async () => {
		const row = await pollHealth( {
			heartbeatIntervalS: 10,
			workers: [ worker( 0, { heartbeatAge: null, behind: 0 } ) ],
		} );
		expect( row.partitions.every( ( p ) => ! p.stalled ) ).toBe( true );
		expect( row.health ).toBe( 'ok' );
	} );
} );
