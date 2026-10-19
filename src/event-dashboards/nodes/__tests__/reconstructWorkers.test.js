import { globalRates } from '../../globalRates';
import { readFileSync } from 'fs';
import { join } from 'path';
import { brokerReaderId, reconstructWorkers } from '../reconstructWorkers';
import { buildTopologySections } from '../../topologyGraph';

const EMPTY_PRIOR = {};

// Flatten a buildTopologySections tree into all entities.
function flatten( entities, acc = [] ) {
	entities.forEach( ( e ) => {
		acc.push( e );
		flatten( e.children || [], acc );
	} );
	return acc;
}

// The `combined` shape: one consumer fans via a tee to TWO processors.
const FANOUT_GRAPH = {
	combined: {
		nodes: [
			{
				name: 'firehose:consumer',
				kind: 'consumer',
				reads: 'firehose.p{partition}',
			},
			{ name: 'firehose:tee', kind: 'tee' },
			{ name: 'request-builder', kind: 'logic' },
			{ name: 'job-router', kind: 'logic' },
			{
				name: 'requests:partition',
				kind: 'partition',
				writes: 'requests.p{partition}',
			},
			{
				name: 'jobs:partition',
				kind: 'partition',
				writes: 'jobs.p{partition}',
			},
		],
		edges: [
			[ 'firehose:consumer', 'firehose:tee' ],
			[ 'firehose:tee', 'request-builder' ],
			[ 'firehose:tee', 'job-router' ],
			[ 'request-builder', 'requests:partition' ],
			[ 'job-router', 'jobs:partition' ],
		],
	},
};

const FANOUT_DATA = {
	graph: FANOUT_GRAPH,
	workers: [
		{
			type: 'combined',
			partition: 0,
			state: 'live',
			restart_pending: false,
			heartbeat_age: 2,
			started_at: 1700000000,
		},
	],
	consumers: [
		{
			reader: 'firehose.p0',
			source: 'firehose.p0',
			partition: 0,
			cursor_segment: 0,
			cursor_offset: 50,
			end_segment: 0,
			end_size: 200,
			distance: 150,
			msgs: 7,
		},
	],
	logs: [
		{
			name: 'firehose.p0',
			partitions: [
				{
					partition: 0,
					segments: [ { id: 0, size: 200 } ],
					total_size: 200,
				},
			],
		},
	],
	timestamp: 1000,
};

describe( 'reconstructWorkers — fan-out attaches every processor', () => {
	it( 'emits one worker per downstream logic handler', () => {
		const { workers } = reconstructWorkers( FANOUT_DATA, EMPTY_PRIOR );
		const handlers = workers.map( ( w ) => w.handler ).sort();
		expect( handlers ).toEqual( [ 'job-router', 'request-builder' ] );
		// Both rows share the reader's snapshot + the worker's liveness.
		workers.forEach( ( w ) => {
			expect( w.behind ).toBe( 150 );
			expect( w.cursor_offset ).toBe( 50 );
			expect( w.state ).toBe( 'live' );
			expect( w.started_at ).toBe( 1700000000 );
		} );
	} );

	it( 'attaches a worker to BOTH the request-builder and job-router vertices in the tree', () => {
		const { workers } = reconstructWorkers( FANOUT_DATA, EMPTY_PRIOR );
		const sections = buildTopologySections(
			FANOUT_GRAPH,
			workers,
			FANOUT_DATA.logs
		);
		const entities = flatten( sections[ 0 ].tree );
		const byName = ( name ) =>
			entities.find( ( e ) => 'node' === e.kind && e.name === name );
		// Regression guard: picking only the first handler drops job-router.
		expect( byName( 'request-builder' )?.workers ?? [] ).toHaveLength( 1 );
		expect( byName( 'job-router' )?.workers ?? [] ).toHaveLength( 1 );
	} );

	it( 'emits one worker when two valid Tee paths converge on the same handler', () => {
		const graph = {
			combined: {
				...FANOUT_GRAPH.combined,
				nodes: [
					...FANOUT_GRAPH.combined.nodes,
					{ name: 'nested:tee', kind: 'tee' },
				],
				edges: [
					[ 'firehose:consumer', 'firehose:tee' ],
					[ 'firehose:tee', 'nested:tee' ],
					[ 'firehose:tee', 'job-router' ],
					[ 'nested:tee', 'job-router' ],
					[ 'job-router', 'jobs:partition' ],
				],
			},
		};
		const { workers } = reconstructWorkers(
			{ ...FANOUT_DATA, graph },
			EMPTY_PRIOR
		);

		expect( workers.map( ( worker ) => worker.handler ) ).toEqual( [
			'job-router',
		] );
	} );
} );

// Two topologies tail the SAME source via distinct readers; match by reader.
const SHARED_SOURCE_GRAPH = {
	'request-builder': {
		nodes: [
			{
				name: 'firehose:consumer',
				kind: 'consumer',
				reads: 'firehose.p{partition}',
				reader: 'firehose.request-builder.p{partition}',
			},
			{ name: 'request-builder', kind: 'logic' },
			{
				name: 'requests:partition',
				kind: 'partition',
				writes: 'requests.p{partition}',
			},
		],
		edges: [
			[ 'firehose:consumer', 'request-builder' ],
			[ 'request-builder', 'requests:partition' ],
		],
	},
	'job-router': {
		nodes: [
			{
				name: 'firehose:consumer',
				kind: 'consumer',
				reads: 'firehose.p{partition}',
				reader: 'firehose.job-router.p{partition}',
			},
			{ name: 'job-router', kind: 'logic' },
			{
				name: 'jobs:partition',
				kind: 'partition',
				writes: 'jobs.p{partition}',
			},
		],
		edges: [
			[ 'firehose:consumer', 'job-router' ],
			[ 'job-router', 'jobs:partition' ],
		],
	},
};
const wk = ( type ) => ( {
	type,
	partition: 0,
	state: 'live',
	restart_pending: false,
	heartbeat_age: 2,
	started_at: 1700000000,
} );
const SHARED_SOURCE_DATA = {
	graph: SHARED_SOURCE_GRAPH,
	workers: [ wk( 'request-builder' ), wk( 'job-router' ) ],
	consumers: [
		{
			reader: 'firehose.request-builder.p0',
			source: 'firehose.p0',
			partition: 0,
			cursor_segment: 0,
			cursor_offset: 50,
			end_segment: 0,
			end_size: 200,
			distance: 150,
			msgs: 7,
		},
		{
			reader: 'firehose.job-router.p0',
			source: 'firehose.p0',
			partition: 0,
			cursor_segment: 0,
			cursor_offset: 10,
			end_segment: 0,
			end_size: 200,
			distance: 190,
			msgs: 3,
		},
	],
	logs: [
		{
			name: 'firehose.p0',
			partitions: [
				{
					partition: 0,
					segments: [ { id: 0, size: 200 } ],
					total_size: 200,
				},
			],
		},
	],
	timestamp: 1000,
};

describe( 'reconstructWorkers — two topologies sharing one source', () => {
	it( 'matches each topology to ITS OWN reader, not the foreign one', () => {
		const { workers } = reconstructWorkers(
			SHARED_SOURCE_DATA,
			EMPTY_PRIOR
		);
		const rb = workers.filter( ( w ) => w.type === 'request-builder' );
		const jr = workers.filter( ( w ) => w.type === 'job-router' );
		expect( rb ).toHaveLength( 1 );
		expect( jr ).toHaveLength( 1 );
		// Each shows its OWN reader's distance, not the other's.
		expect( rb[ 0 ].behind ).toBe( 150 );
		expect( jr[ 0 ].behind ).toBe( 190 );
	} );

	it( 'each topology node entity shows exactly one worker per partition', () => {
		const { workers } = reconstructWorkers(
			SHARED_SOURCE_DATA,
			EMPTY_PRIOR
		);
		const sections = buildTopologySections(
			SHARED_SOURCE_GRAPH,
			workers,
			SHARED_SOURCE_DATA.logs
		);
		const entities = flatten( sections.flatMap( ( s ) => s.tree ) );
		const byName = ( name ) =>
			entities.find( ( e ) => 'node' === e.kind && e.name === name );
		expect( byName( 'request-builder' )?.workers ?? [] ).toHaveLength( 1 );
		expect( byName( 'job-router' )?.workers ?? [] ).toHaveLength( 1 );
	} );
} );

describe( 'reconstructWorkers — full live segments + recorded end', () => {
	it( 'the logs payload carries FULL live segments (untrimmed) + full total_size', () => {
		const data = {
			...FANOUT_DATA,
			consumers: [
				{
					reader: 'firehose.p0',
					source: 'firehose.p0',
					partition: 0,
					cursor_segment: 0,
					cursor_offset: 50,
					end_segment: 1,
					end_size: 30,
					distance: 0,
					msgs: 1,
				},
			],
			logs: [
				{
					name: 'firehose.p0',
					partitions: [
						{
							partition: 0,
							segments: [
								{ id: 0, size: 100 },
								{ id: 1, size: 250 },
								{ id: 2, size: 999 },
							],
							total_size: 1349,
						},
					],
				},
			],
		};
		const { logs } = reconstructWorkers( data, EMPTY_PRIOR );
		// The bar paints a gray beyond region, so carry FULL live segments.
		const logSegs = logs[ 0 ].partitions[ 0 ].segments;
		expect( logSegs.map( ( s ) => [ s.id, s.size ] ) ).toEqual( [
			[ 0, 100 ],
			[ 1, 250 ],
			[ 2, 999 ],
		] );
		expect( logs[ 0 ].partitions[ 0 ].total_size ).toBe( 1349 );
	} );

	it( 'inputs_status carries FULL live segments and the consumer end_segment/end_size', () => {
		const data = {
			...FANOUT_DATA,
			consumers: [
				{
					reader: 'firehose.p0',
					source: 'firehose.p0',
					partition: 0,
					cursor_segment: 0,
					cursor_offset: 50,
					end_segment: 1,
					end_size: 30,
					distance: 0,
					msgs: 1,
				},
			],
			logs: [
				{
					name: 'firehose.p0',
					partitions: [
						{
							partition: 0,
							segments: [
								{ id: 0, size: 100 },
								{ id: 1, size: 250 },
								{ id: 2, size: 999 },
							],
							total_size: 1349,
						},
					],
				},
			],
		};
		const { workers } = reconstructWorkers( data, EMPTY_PRIOR );
		const status = workers[ 0 ].inputs_status[ 0 ];
		expect( status.segments.map( ( s ) => [ s.id, s.size ] ) ).toEqual( [
			[ 0, 100 ],
			[ 1, 250 ],
			[ 2, 999 ],
		] );
		expect( status.total_size ).toBe( 1349 );
		expect( status.cursor_segment ).toBe( 0 );
		expect( status.cursor_offset ).toBe( 50 );
		expect( status.end_segment ).toBe( 1 );
		expect( status.end_size ).toBe( 30 );
	} );

	it( 'the segment bar (buildTopologySections log entity) shows the FULL live segments with the consumer end merged', () => {
		const data = {
			...FANOUT_DATA,
			consumers: [
				{
					reader: 'firehose.p0',
					source: 'firehose.p0',
					partition: 0,
					cursor_segment: 0,
					cursor_offset: 50,
					end_segment: 1,
					end_size: 30,
					distance: 0,
					msgs: 1,
				},
			],
			logs: [
				{
					name: 'firehose.p0',
					partitions: [
						{
							partition: 0,
							segments: [
								{ id: 0, size: 100 },
								{ id: 1, size: 250 },
								{ id: 2, size: 999 },
							],
							total_size: 1349,
						},
					],
				},
			],
		};
		const { workers, logs } = reconstructWorkers( data, EMPTY_PRIOR );
		const sections = buildTopologySections( FANOUT_GRAPH, workers, logs );
		const firehose = flatten( sections[ 0 ].tree ).find(
			( e ) => 'log' === e.kind && 'firehose' === e.name
		);
		const part = firehose.partitions[ 0 ];
		// id 2 (live, past the probe end) STAYS — paints as gray beyond.
		expect( part.segments.map( ( s ) => s.id ) ).toEqual( [ 0, 1, 2 ] );
		expect( part.cursor_segment ).toBe( 0 );
		expect( part.cursor_offset ).toBe( 50 );
		expect( part.end_segment ).toBe( 1 );
		expect( part.end_size ).toBe( 30 );
	} );

	it( 'counts a fan-out reader ONCE in the fleet-wide read rate', () => {
		// FANOUT_DATA is one firehose reader feeding request-builder AND
		// job-router. Keying the rate map by handler wrote the same reader's
		// rate under two keys, and globalRates sums every value.
		const { byteRates } = reconstructWorkers(
			{
				...FANOUT_DATA,
				consumers: [
					{
						...FANOUT_DATA.consumers[ 0 ],
						bytes_read: 6200,
						elapsed_ms: 15_500,
					},
				],
			},
			EMPTY_PRIOR
		);

		expect( Object.keys( byteRates ) ).toHaveLength( 1 );
		expect( globalRates( byteRates, {} ).readRate ).toBe( 400 );
	} );

	it( 'reads a reader rate off its newest probe record alone: bytes read over the window they cover', () => {
		const rb = FANOUT_DATA.consumers[ 0 ].reader;
		const { byteRates, workers } = reconstructWorkers(
			{
				...FANOUT_DATA,
				consumers: [
					{
						...FANOUT_DATA.consumers[ 0 ],
						bytes_read: 589_824_000,
						elapsed_ms: 15_000,
					},
				],
			},
			EMPTY_PRIOR
		);

		// 37.5 MiB/s on the very first poll: no baseline to wait for.
		expect( byteRates[ rb ] ).toBe( 39_321_600 );
		const w = workers.find( ( x ) => x.handler === 'request-builder' );
		expect( w.read_rate ).toBe( 39_321_600 );
	} );

	it( 'reads zero for a record whose window covers no time', () => {
		const rb = FANOUT_DATA.consumers[ 0 ].reader;
		const { byteRates } = reconstructWorkers(
			{
				...FANOUT_DATA,
				consumers: [
					{
						...FANOUT_DATA.consumers[ 0 ],
						bytes_read: 4417,
						elapsed_ms: 0,
					},
				],
			},
			EMPTY_PRIOR
		);

		expect( byteRates[ rb ] ).toBe( 0 );
	} );

	// One log whose newest Partition record grew `grown` bytes over its window.
	const probed = ( grown, elapsedMs ) => ( {
		...FANOUT_DATA,
		consumers: [],
		logs: [
			{
				name: 'firehose.p0',
				partitions: [
					{
						partition: 0,
						// The live total disagrees, so a rate off it shows.
						segments: [ { id: 0, size: 9999 } ],
						total_size: 9999,
						probe: { grown, elapsed_ms: elapsedMs },
					},
				],
			},
		],
		logs_at: 1003.5,
	} );

	it( 'divides ONE Partition record: the bytes its log grew over its own window', () => {
		const { writeRates, nextLive } = reconstructWorkers(
			probed( 196_608_000, 15_000 ),
			EMPTY_PRIOR
		);

		// 12.5 MiB/s on the very first poll, from the prober's own clock.
		expect( writeRates[ 'firehose.p0' ] ).toBe( 13_107_200 );
		// The live sample rides along, a baseline should the probe lapse.
		expect( nextLive ).toEqual( {
			'firehose.p0': { at: 1003.5, sizes: { 0: 9999 } },
		} );
	} );

	// One log no worker probes: its live segments, stamped at `at`.
	const unprobed = ( segments, at ) => ( {
		...FANOUT_DATA,
		consumers: [],
		logs: [
			{
				name: 'completed.p0',
				partitions: [
					{
						partition: 0,
						segments,
						total_size: segments.reduce(
							( a, s ) => a + s.size,
							0
						),
						probe: null,
					},
				],
			},
		],
		logs_at: at,
	} );

	it( 'rates a log no probe record names from its live segments on the stat clock', () => {
		const src = 'completed.p0';
		const p1 = reconstructWorkers(
			unprobed( [ { id: 4, size: 100 } ], 1000.25 ),
			EMPTY_PRIOR
		);
		expect( p1.writeRates[ src ] ).toBe( 0 ); // first sample
		const p2 = reconstructWorkers(
			unprobed( [ { id: 4, size: 330 } ], 1010.25 ),
			p1.nextLive
		);
		expect( p2.writeRates[ src ] ).toBe( 23 ); // 230 bytes over 10s
		// The stat clock moved, so an unchanged log is idle.
		const p3 = reconstructWorkers(
			unprobed( [ { id: 4, size: 330 } ], 1015.25 ),
			p2.nextLive
		);
		expect( p3.writeRates[ src ] ).toBe( 0 );
	} );

	it( 'never lets retention subtract from a live log rate', () => {
		const src = 'completed.p0';
		const p1 = reconstructWorkers(
			unprobed(
				[
					{ id: 4, size: 6000 },
					{ id: 5, size: 100 },
				],
				1000.5
			),
			EMPTY_PRIOR
		);
		// Segment 4 aged out, 5 grew by 300 and 6 opened with 500.
		const p2 = reconstructWorkers(
			unprobed(
				[
					{ id: 5, size: 400 },
					{ id: 6, size: 500 },
				],
				1005.5
			),
			p1.nextLive
		);
		expect( p2.writeRates[ src ] ).toBe( 160 );
	} );

	it( 'reads a log whose probe went stale off its live segments, with no dip', () => {
		const src = 'completed.p0';
		const withProbe = {
			...unprobed( [ { id: 4, size: 1000 } ], 1000.5 ),
		};
		withProbe.logs[ 0 ].partitions[ 0 ].probe = {
			grown: 15_000,
			elapsed_ms: 15_000,
		};
		const p1 = reconstructWorkers( withProbe, EMPTY_PRIOR );
		expect( p1.writeRates[ src ] ).toBe( 1000 );
		// The prober recycled: its first window is too short to stand.
		const p2 = reconstructWorkers(
			unprobed( [ { id: 4, size: 1500 } ], 1005.5 ),
			p1.nextLive
		);
		expect( p2.writeRates[ src ] ).toBe( 100 );
	} );

	it( 'counts a segment smaller than it was whole: the log was wiped and rewritten', () => {
		const src = 'completed.p0';
		const p1 = reconstructWorkers(
			unprobed( [ { id: 4, size: 6000 } ], 1000.5 ),
			EMPTY_PRIOR
		);
		const p2 = reconstructWorkers(
			unprobed( [ { id: 4, size: 250 } ], 1005.5 ),
			p1.nextLive
		);
		expect( p2.writeRates[ src ] ).toBe( 50 );
	} );

	it( 'reads zero, never NaN, for a poll with no stat clock, and keeps its baseline', () => {
		const src = 'completed.p0';
		const p1 = reconstructWorkers(
			unprobed( [ { id: 4, size: 100 } ], 1000.25 ),
			EMPTY_PRIOR
		);
		const p2 = reconstructWorkers(
			unprobed( [ { id: 4, size: 700 } ], undefined ),
			p1.nextLive
		);
		expect( p2.writeRates[ src ] ).toBe( 0 );
		// A clock that ran backward does not make a span either.
		const p3 = reconstructWorkers(
			unprobed( [ { id: 4, size: 700 } ], 999.75 ),
			p2.nextLive
		);
		expect( p3.writeRates[ src ] ).toBe( 0 );
		const p4 = reconstructWorkers(
			unprobed( [ { id: 4, size: 1300 } ], 1004.75 ),
			p3.nextLive
		);
		expect( p4.writeRates[ src ] ).toBe( 120 ); // 600 over 5s
	} );
} );

// Bind to the handler equal to the reader basename (prereq), not req.
const SUBSTRING_COLLISION_GRAPH = {
	t: {
		nodes: [
			{
				name: 'req',
				kind: 'consumer',
				reads: 'shared.p{partition}',
			},
			{
				name: 'prereq',
				kind: 'consumer',
				reads: 'shared.p{partition}',
			},
			{ name: 'req-proc', kind: 'logic' },
			{ name: 'prereq-proc', kind: 'logic' },
		],
		edges: [
			[ 'req', 'req-proc' ],
			[ 'prereq', 'prereq-proc' ],
		],
	},
};
const SUBSTRING_COLLISION_DATA = {
	graph: SUBSTRING_COLLISION_GRAPH,
	workers: [ wk( 't' ) ],
	consumers: [
		{
			reader: 'prereq.p0',
			source: 'shared.p0',
			partition: 0,
			cursor_segment: 0,
			cursor_offset: 50,
			end_segment: 0,
			end_size: 200,
			distance: 150,
			msgs: 7,
		},
	],
	logs: [
		{
			name: 'shared.p0',
			partitions: [
				{
					partition: 0,
					segments: [ { id: 0, size: 200 } ],
					total_size: 200,
				},
			],
		},
	],
	timestamp: 1000,
};

describe( 'reconstructWorkers — reader/handler identity match (no loose substring)', () => {
	it( 'binds a probe row to the handler whose name EQUALS the reader basename, not a substring', () => {
		const { workers } = reconstructWorkers(
			SUBSTRING_COLLISION_DATA,
			EMPTY_PRIOR
		);
		// reader prereq.p0 resolves to prereq-proc, NOT req-proc.
		const handlers = workers.map( ( w ) => w.handler ).sort();
		expect( handlers ).toEqual( [ 'prereq-proc' ] );
	} );
} );

describe( 'reconstructWorkers — liveness backfill', () => {
	it( 'emits a row for a live worker that has no probe row yet', () => {
		const data = { ...FANOUT_DATA, consumers: [] };
		const { workers } = reconstructWorkers( data, EMPTY_PRIOR );
		expect( workers ).toHaveLength( 1 );
		expect( workers[ 0 ].type ).toBe( 'combined' );
		expect( workers[ 0 ].state ).toBe( 'live' );
		expect( workers[ 0 ].started_at ).toBe( 1700000000 );
	} );
} );

describe( 'reconstructWorkers — hides ghost readers of an undeclared partition', () => {
	// After num_partitions 2→1, drop the stale p1 reader (no decl, no worker).
	const GHOST_DATA = {
		graph: FANOUT_GRAPH,
		workers: [
			{
				type: 'combined',
				partition: 0,
				state: 'live',
				restart_pending: false,
				heartbeat_age: 2,
				started_at: 1700000000,
			},
		],
		consumers: [
			{
				reader: 'firehose.p0',
				source: 'firehose.p0',
				partition: 0,
				cursor_segment: 0,
				cursor_offset: 50,
				end_segment: 0,
				end_size: 200,
				distance: 150,
				msgs: 7,
			},
			{
				// Stale ghost: p1 no longer declared, no p1 worker.
				reader: 'firehose.p1',
				source: 'firehose.p1',
				partition: 1,
				cursor_segment: 0,
				cursor_offset: 0,
				end_segment: 0,
				end_size: 0,
				distance: 0,
				msgs: 0,
			},
		],
		logs: [
			{
				name: 'firehose.p0',
				partitions: [
					{
						partition: 0,
						segments: [ { id: 0, size: 200 } ],
						total_size: 200,
					},
				],
			},
		],
		timestamp: 1000,
	};

	it( 'drops the worker rows for the undeclared, unbacked p1 reader', () => {
		const { workers } = reconstructWorkers( GHOST_DATA, EMPTY_PRIOR );
		expect( workers.filter( ( w ) => w.partition === 1 ) ).toHaveLength(
			0
		);
		expect(
			workers.filter( ( w ) => w.partition === 0 ).length
		).toBeGreaterThan( 0 );
	} );

	it( 'keeps a reader whose partition IS still declared even if its worker is momentarily absent', () => {
		// Only undeclared + unbacked is a ghost; declared-but-down stays.
		const data = {
			...GHOST_DATA,
			logs: [
				...GHOST_DATA.logs,
				{
					name: 'firehose.p1',
					partitions: [
						{
							partition: 1,
							segments: [ { id: 0, size: 10 } ],
							total_size: 10,
						},
					],
				},
			],
		};
		const { workers } = reconstructWorkers( data, EMPTY_PRIOR );
		expect(
			workers.filter( ( w ) => w.partition === 1 ).length
		).toBeGreaterThan( 0 );
	} );
} );

// The reader template carries `<topology>` now (the fleet-scoped cursor). The
// client substituted only `{partition}`, so `firehose.<topology>.p0` never
// matched the live reader `firehose.combined.p0` — no cursor, and every segment
// bar on the topologies dashboard painted grey.
const TOPOLOGY_TOKEN_GRAPH = {
	combined: {
		nodes: [
			{
				name: 'firehose:consumer',
				kind: 'consumer',
				reads: 'firehose.p{partition}',
				reader: 'firehose.<topology>.p{partition}',
			},
			{ name: 'request-builder', kind: 'logic' },
		],
		edges: [ [ 'firehose:consumer', 'request-builder' ] ],
	},
};

const TOPOLOGY_TOKEN_DATA = {
	consumers: [
		{
			reader: 'firehose.combined.p0',
			source: 'firehose.p0',
			partition: 0,
			cursor_segment: 3,
			cursor_offset: 128,
			end_segment: 3,
			end_size: 512,
			distance: 384,
		},
	],
	workers: [ { type: 'combined', partition: 0, state: 'live' } ],
	logs: [],
	graph: TOPOLOGY_TOKEN_GRAPH,
};

describe( 'reconstructWorkers — the <topology> token in a reader template', () => {
	it( 'resolves <topology> so the cursor lands (grey bars otherwise)', () => {
		const { workers } = reconstructWorkers(
			TOPOLOGY_TOKEN_DATA,
			EMPTY_PRIOR
		);

		const w = workers.find( ( x ) => x.type === 'combined' );
		expect( w ).toBeDefined();
		expect( w.cursor_segment ).toBe( 3 );
		expect( w.inputs_status[ 0 ].cursor_offset ).toBe( 128 );
	} );
} );

/**
 * The server decides each slot's state. This join REBUILDS each worker row
 * from a whitelist, so a field it forgets is a verdict the dashboard silently
 * cannot see.
 */
describe( 'reconstructWorkers — carries the server state', () => {
	it( 'keeps the state on a row joined to a consumer', () => {
		const data = {
			...FANOUT_DATA,
			workers: [
				{
					type: 'combined',
					partition: 0,
					state: 'held',
					restart_pending: false,
					heartbeat_age: null,
					started_at: null,
				},
			],
		};

		const { workers } = reconstructWorkers( data, EMPTY_PRIOR );

		expect( workers.length ).toBeGreaterThan( 0 );
		workers.forEach( ( w ) => expect( w.state ).toBe( 'held' ) );
	} );

	it( 'keeps the state on a liveness row with no consumer of its own', () => {
		const data = {
			graph: { lonely: { nodes: [], edges: [] } },
			workers: [
				{
					type: 'lonely',
					partition: 0,
					state: 'idle',
				},
			],
			consumers: [],
		};

		const { workers } = reconstructWorkers( data, EMPTY_PRIOR );

		expect( workers[ 0 ].state ).toBe( 'idle' );
		expect( workers[ 0 ] ).not.toHaveProperty( 'idle' );
	} );
} );

describe( 'reconstructWorkers — a broker hangs its readers under its own node', () => {
	const probeRow = ( reader, source, cursorSegment, cursorOffset ) => ( {
		reader,
		source,
		partition: 2,
		cursor_segment: cursorSegment,
		cursor_offset: cursorOffset,
		end_segment: cursorSegment,
		end_size: cursorOffset + 479,
		distance: 479,
		msgs: 31,
	} );
	const BROKER_DATA = {
		graph: {
			'hub-7731': {
				nodes: [
					{
						name: 'firehose:okapi-3',
						kind: 'logic',
						type: 'Remote_Source',
						vault_id: 'okapi-3',
						sources: [
							{
								source: 'firehose.p{partition}',
								target: 'remote-job-rewrite',
							},
						],
					},
					{
						name: 'firehose:tapir-8',
						kind: 'logic',
						type: 'Remote_Source',
						vault_id: 'tapir-8',
						sources: [
							{
								source: 'firehose.p{partition}',
								target: 'remote-job-rewrite',
							},
						],
					},
					{ name: 'remote-job-rewrite', kind: 'logic' },
				],
				edges: [
					[ 'firehose:okapi-3', 'remote-job-rewrite' ],
					[ 'firehose:tapir-8', 'remote-job-rewrite' ],
				],
			},
		},
		workers: [
			{
				type: 'hub-7731',
				partition: 2,
				state: 'live',
				restart_pending: false,
				heartbeat_age: 3,
				started_at: 1700000000,
			},
		],
		consumers: [
			probeRow(
				'hub-7731.firehose:okapi-3:firehose.p2.p2',
				'remote:okapi-3:firehose.p2',
				14,
				9021
			),
			probeRow(
				'hub-7731.firehose:okapi-3:sources:php.p2',
				'remote:okapi-3:sources:php',
				null,
				40913
			),
			probeRow(
				'hub-7731.firehose:tapir-8:firehose.p2.p2',
				'remote:tapir-8:firehose.p2',
				6,
				118
			),
			probeRow(
				'zorp-55.firehose:okapi-3:firehose.p2.p2',
				'remote:okapi-3:firehose.p2',
				9,
				77
			),
			probeRow( 'firehose.p2', 'firehose.p2', 3, 12 ),
		],
		logs: [],
	};

	it( 'joins each reader row to the broker its reader id names', () => {
		const { workers } = reconstructWorkers( BROKER_DATA, EMPTY_PRIOR );
		const readsOf = ( handler ) =>
			workers
				.filter( ( w ) => w.handler === handler )
				.map( ( w ) => [
					w.source,
					w.cursor_segment,
					w.cursor_offset,
				] );

		expect( readsOf( 'firehose:okapi-3' ) ).toEqual( [
			[ 'remote:okapi-3:firehose.p2', 14, 9021 ],
			[ 'remote:okapi-3:sources:php', null, 40913 ],
		] );
		expect( readsOf( 'firehose:tapir-8' ) ).toEqual( [
			[ 'remote:tapir-8:firehose.p2', 6, 118 ],
		] );
	} );

	it( 'draws the rows under the broker vertex in the tree', () => {
		const { workers } = reconstructWorkers( BROKER_DATA, EMPTY_PRIOR );
		const sections = buildTopologySections(
			BROKER_DATA.graph,
			workers,
			BROKER_DATA.logs
		);
		const entities = flatten( sections[ 0 ].tree );
		// Two brokers feeding one rewrite converge on one joined entity.
		const brokers = entities.find(
			( e ) =>
				'node' === e.kind && e.names?.includes( 'firehose:okapi-3' )
		);

		expect( brokers.names ).toEqual( [
			'firehose:okapi-3',
			'firehose:tapir-8',
		] );
		expect( brokers.workers.map( ( w ) => w.source ) ).toEqual( [
			'remote:okapi-3:firehose.p2',
			'remote:okapi-3:sources:php',
			'remote:tapir-8:firehose.p2',
		] );
	} );
} );

describe( 'brokerReaderId parity with Remote_Broker_Node::reader_id()', () => {
	const cases = JSON.parse(
		readFileSync(
			join( __dirname, '../../../../tests/fixtures/log-remotes.json' ),
			'utf8'
		)
	);

	it.each( cases )(
		'%s',
		( _label, _vault, stamp, _name, topology, broker, partition, id ) => {
			expect( brokerReaderId( topology, broker, stamp, partition ) ).toBe(
				id
			);
		}
	);
} );
