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
import {
	useTopologyManager,
	STALL_PAD,
	deriveHealth,
} from '../hooks/useTopologyManager';

describe( 'deriveHealth — eta-aware behind', () => {
	const sect = ( workers ) => ( { workers, heartbeatIntervalS: 10 } );

	it( 'returns ok + eta 0 for no section', () => {
		expect( deriveHealth( null ) ).toEqual( {
			partitions: [],
			health: 'ok',
			etaSeconds: 0,
		} );
	} );

	it( 'does NOT count a sub-minute ETA as behind', () => {
		// behind 100B at 10 B/s = 10s ETA → caught up enough; health stays ok.
		const r = deriveHealth(
			sect( [
				{ partition: 0, heartbeat_age: 5, behind: 100, read_rate: 10 },
			] )
		);
		expect( r.health ).toBe( 'ok' );
		expect( r.etaSeconds ).toBe( 10 );
	} );

	it( 'counts a >=1min ETA as behind and reports the worst eta', () => {
		const r = deriveHealth(
			sect( [
				{ partition: 0, heartbeat_age: 5, behind: 6000, read_rate: 10 },
			] )
		);
		expect( r.health ).toBe( 'behind' );
		expect( r.etaSeconds ).toBe( 600 );
	} );

	it( 'counts lag with no read progress (rate 0) as behind (Infinity eta)', () => {
		const r = deriveHealth(
			sect( [
				{ partition: 0, heartbeat_age: 5, behind: 4096, read_rate: 0 },
			] )
		);
		expect( r.health ).toBe( 'behind' );
		expect( r.etaSeconds ).toBe( Infinity );
	} );

	it( 'heartbeat stall outranks behind', () => {
		const r = deriveHealth(
			sect( [
				{
					partition: 0,
					heartbeat_age: 40,
					behind: 6000,
					read_rate: 10,
				},
			] )
		);
		expect( r.health ).toBe( 'stalled' );
	} );
} );

jest.mock( '../../shared/hooks/usePageVisibility', () => ( {
	__esModule: true,
	default: () => true,
} ) );

// A recording CommandClient double mirroring HttpOut's seam: postBatch records
// every posted command into `sent`, then resolves replies addressed back along
// FROM with a per-verb payload.
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

beforeEach( () => {
	Core.reset();
	window.localStorage.clear();
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
		// The same enriched model slices WorkerStatus threads into
		// TopologySection — not a degraded { graph, workers } reduction.
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
		expect( deactivateSend.args ).toBe( 'a' );
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
		expect( activateSend.args ).toBe( 'b' );
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
		expect( restartSend.args ).toBe( 'a' );
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

	it( 'exposes connected state', async () => {
		const { client } = buildClient();
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );
		expect( result.current ).toHaveProperty( 'connected' );
	} );
} );

// Build a single-active-topology client whose LEAN dump_graph payload carries
// the per-partition liveness + probe rows (heartbeat_age / behind) the
// transform reconstructs into rich workers. Topology `a` reads `a.p<partition>`.
function healthClient( { workers, heartbeatIntervalS = 10, currentTime } ) {
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
			cursor_seg: 0,
			cursor_off: 0,
			end_seg: 0,
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
	const topologies = {
		topologies: [
			{ name: 'a', source: 'stock', active: true, num_partitions: 2 },
		],
		user_dir: '/tmp/topologies',
	};
	return makeRecordingClient( { dump_graph: dump, list: topologies } );
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

describe( 'useTopologyManager — partition stall + rolled-up health', () => {
	it( 'exports STALL_PAD = 3', () => {
		expect( STALL_PAD ).toBe( 3 );
	} );

	it( 'flags a partition stalled when heartbeat_age exceeds interval × STALL_PAD', async () => {
		const { client } = healthClient( {
			heartbeatIntervalS: 10,
			workers: [
				worker( 0, { heartbeatAge: 5, behind: 0 } ),
				worker( 1, { heartbeatAge: 40, behind: 0 } ),
			],
		} );
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		const row = result.current.topologies.find( ( t ) => 'a' === t.name );
		const byPart = Object.fromEntries(
			row.partitions.map( ( p ) => [ p.partition, p ] )
		);
		expect( byPart[ 0 ].stalled ).toBe( false );
		expect( byPart[ 1 ].stalled ).toBe( true );
		expect( row.health ).toBe( 'stalled' );
	} );

	it( 'rolls up to health=behind when no partition stalled but a consumer is behind', async () => {
		const { client } = healthClient( {
			heartbeatIntervalS: 10,
			workers: [
				worker( 0, { heartbeatAge: 5, behind: 0 } ),
				worker( 1, { heartbeatAge: 5, behind: 4096 } ),
			],
		} );
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		const row = result.current.topologies.find( ( t ) => 'a' === t.name );
		expect( row.partitions.every( ( p ) => ! p.stalled ) ).toBe( true );
		expect( row.health ).toBe( 'behind' );
	} );

	it( 'rolls up to health=ok when nothing is stalled or behind', async () => {
		const { client } = healthClient( {
			heartbeatIntervalS: 10,
			workers: [
				worker( 0, { heartbeatAge: 5, behind: 0 } ),
				worker( 1, { heartbeatAge: 5, behind: 0 } ),
			],
		} );
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		const row = result.current.topologies.find( ( t ) => 'a' === t.name );
		expect( row.health ).toBe( 'ok' );
	} );

	it( 'does not flag a never-heartbeated worker (heartbeat_age null) as stalled', async () => {
		const { client } = healthClient( {
			heartbeatIntervalS: 10,
			workers: [ worker( 0, { heartbeatAge: null, behind: 0 } ) ],
		} );
		const { result } = renderHook( () =>
			useTopologyManager( { commandClient: client } )
		);
		await act( async () => {} );

		const row = result.current.topologies.find( ( t ) => 'a' === t.name );
		expect( row.partitions.every( ( p ) => ! p.stalled ) ).toBe( true );
		expect( row.health ).toBe( 'ok' );
	} );
} );
