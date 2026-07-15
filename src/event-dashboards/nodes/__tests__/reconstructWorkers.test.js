import { reconstructWorkers } from '../reconstructWorkers';
import { buildTopologySections } from '../../topologyGraph';

const EMPTY_PRIOR = { read: {}, write: {} };

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
				reads: 'firehose.p<partition>',
			},
			{ name: 'firehose:tee', kind: 'tee' },
			{ name: 'request-builder', kind: 'logic' },
			{ name: 'job-router', kind: 'logic' },
			{
				name: 'requests:partition',
				kind: 'partition',
				writes: 'requests.p<partition>',
			},
			{
				name: 'jobs:partition',
				kind: 'partition',
				writes: 'jobs.p<partition>',
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
			status: 'running',
			live: true,
			stale: false,
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
			expect( w.status ).toBe( 'running' );
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
				reads: 'firehose.p<partition>',
				reader: 'firehose.request-builder.p<partition>',
			},
			{ name: 'request-builder', kind: 'logic' },
			{
				name: 'requests:partition',
				kind: 'partition',
				writes: 'requests.p<partition>',
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
				reads: 'firehose.p<partition>',
				reader: 'firehose.job-router.p<partition>',
			},
			{ name: 'job-router', kind: 'logic' },
			{
				name: 'jobs:partition',
				kind: 'partition',
				writes: 'jobs.p<partition>',
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
	status: 'running',
	live: true,
	stale: false,
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

	it( 'derives read_rate from the absolute cursor-byte delta across polls; first poll is 0', () => {
		const first = reconstructWorkers( FANOUT_DATA, EMPTY_PRIOR );
		const rb = `request-builder-0-firehose.p0`;
		expect( first.byteRates[ rb ] ).toBe( 0 ); // no prior

		// Cursor advances 50 → 150 over 10s → 10 B/s.
		const next = {
			...FANOUT_DATA,
			consumers: [
				{ ...FANOUT_DATA.consumers[ 0 ], cursor_offset: 150 },
			],
			timestamp: 1010,
		};
		const second = reconstructWorkers( next, {
			read: first.nextRead,
			write: first.nextWrite,
		} );
		expect( second.byteRates[ rb ] ).toBe( 10 );
		// Each worker carries its own read_rate (ETA rollup / health).
		const w = second.workers.find(
			( x ) => x.handler === 'request-builder'
		);
		expect( w.read_rate ).toBe( 10 );
	} );

	it( 'never reports a negative rate when the cursor goes backward (worker restart)', () => {
		const first = reconstructWorkers(
			{
				...FANOUT_DATA,
				consumers: [
					{ ...FANOUT_DATA.consumers[ 0 ], cursor_offset: 150 },
				],
			},
			EMPTY_PRIOR
		);
		const reset = reconstructWorkers(
			{
				...FANOUT_DATA,
				consumers: [
					{ ...FANOUT_DATA.consumers[ 0 ], cursor_offset: 10 },
				],
				timestamp: 1010,
			},
			{ read: first.nextRead, write: first.nextWrite }
		);
		expect( reset.byteRates[ `request-builder-0-firehose.p0` ] ).toBe( 0 );
	} );

	it( 'HOLDS the read rate across polls where the cursor is unchanged (no flicker to 0)', () => {
		const rb = `request-builder-0-firehose.p0`;
		// Poll 1: baseline (rate 0). Poll 2 (cursor advanced): rate 10.
		const p1 = reconstructWorkers( FANOUT_DATA, EMPTY_PRIOR );
		const p2 = reconstructWorkers(
			{
				...FANOUT_DATA,
				consumers: [
					{ ...FANOUT_DATA.consumers[ 0 ], cursor_offset: 150 },
				],
				timestamp: 1010,
			},
			{ read: p1.nextRead, write: p1.nextWrite }
		);
		expect( p2.byteRates[ rb ] ).toBe( 10 );
		// Poll 3: SAME probe data, clock +1s. Rate must HOLD at 10, not 0.
		const p3 = reconstructWorkers(
			{
				...FANOUT_DATA,
				consumers: [
					{ ...FANOUT_DATA.consumers[ 0 ], cursor_offset: 150 },
				],
				timestamp: 1011,
			},
			{ read: p2.nextRead, write: p2.nextWrite }
		);
		expect( p3.byteRates[ rb ] ).toBe( 10 );
	} );

	it( 'derives write_rate from the probe END delta (not the live total) and holds it between ticks', () => {
		const src = 'firehose.p0';
		const base = ( endSize, timestamp ) => ( {
			...FANOUT_DATA,
			consumers: [
				{
					...FANOUT_DATA.consumers[ 0 ],
					end_segment: 0,
					end_size: endSize,
				},
			],
			// Live total grows, but write rate tracks only the probe END.
			logs: [
				{
					name: 'firehose.p0',
					partitions: [
						{
							partition: 0,
							segments: [ { id: 0, size: 9999 } ],
							total_size: 9999,
						},
					],
				},
			],
			timestamp,
		} );
		const p1 = reconstructWorkers( base( 100, 1000 ), EMPTY_PRIOR );
		expect( p1.writeRates[ src ] ).toBe( 0 ); // first sample
		// End advances 100 → 300 over 10s → 20 B/s (NOT the live 9999).
		const p2 = reconstructWorkers( base( 300, 1010 ), {
			read: p1.nextRead,
			write: p1.nextWrite,
		} );
		expect( p2.writeRates[ src ] ).toBe( 20 );
		// Same end, poll clock advanced → HOLD 20.
		const p3 = reconstructWorkers( base( 300, 1011 ), {
			read: p2.nextRead,
			write: p2.nextWrite,
		} );
		expect( p3.writeRates[ src ] ).toBe( 20 );
	} );

	it( 'computes write rate for an OUTPUT log with no consumer (from the live head)', () => {
		// `completed` has no consumer rows, so its rate = live segment head.
		const src = 'completed.p0';
		const make = ( headSize, ts ) => ( {
			...FANOUT_DATA,
			consumers: [],
			logs: [
				{
					name: src,
					partitions: [
						{
							partition: 0,
							segments: [ { id: 0, size: headSize } ],
							total_size: headSize,
						},
					],
				},
			],
			timestamp: ts,
		} );
		const p1 = reconstructWorkers( make( 100, 1000 ), EMPTY_PRIOR );
		expect( p1.writeRates[ src ] ).toBe( 0 ); // first sample
		const p2 = reconstructWorkers( make( 300, 1010 ), {
			read: p1.nextRead,
			write: p1.nextWrite,
		} );
		expect( p2.writeRates[ src ] ).toBe( 20 ); // live head 100→300 over 10s
	} );

	it( 'tracks the consumer END for write rate even when the live head-segment size lags it (no cap)', () => {
		// Write position follows the fresh end, not the capped live head-size.
		const src = 'firehose.p0';
		const make = ( endSize, ts ) => ( {
			...FANOUT_DATA,
			consumers: [
				{
					...FANOUT_DATA.consumers[ 0 ],
					end_segment: 0,
					end_size: endSize,
				},
			],
			logs: [
				{
					name: src,
					partitions: [
						{
							partition: 0,
							segments: [ { id: 0, size: 50 } ], // lags end
							total_size: 50,
						},
					],
				},
			],
			timestamp: ts,
		} );
		const p1 = reconstructWorkers( make( 100, 1000 ), EMPTY_PRIOR );
		expect( p1.writeRates[ src ] ).toBe( 0 ); // first sample
		const p2 = reconstructWorkers( make( 300, 1010 ), {
			read: p1.nextRead,
			write: p1.nextWrite,
		} );
		// (300 − 100)/10 = 20 — NOT 0 from the capped live size of 50.
		expect( p2.writeRates[ src ] ).toBe( 20 );
	} );

	it( 'collapses a partition read by MULTIPLE consumers to one write rate (max end), stable across flipped row order', () => {
		// Two readers of one partition: head=max(end) is order-independent.
		const src = 'firehose.p0';
		const make = ( endA, endB, order, ts ) => ( {
			...FANOUT_DATA,
			consumers: order.map( ( which ) => ( {
				...FANOUT_DATA.consumers[ 0 ],
				reader: 'A' === which ? 'rb/firehose.p0' : 'jr/firehose.p0',
				end_segment: 0,
				end_size: 'A' === which ? endA : endB,
			} ) ),
			logs: [
				{
					name: src,
					partitions: [
						{
							partition: 0,
							segments: [ { id: 0, size: 999999 } ],
							total_size: 999999,
						},
					],
				},
			],
			timestamp: ts,
		} );
		const p1 = reconstructWorkers(
			make( 1000, 100, [ 'A', 'B' ], 1000 ),
			EMPTY_PRIOR
		);
		expect( p1.writeRates[ src ] ).toBe( 0 ); // first sample
		const p2 = reconstructWorkers( make( 2000, 200, [ 'B', 'A' ], 1010 ), {
			read: p1.nextRead,
			write: p1.nextWrite,
		} );
		expect( p2.writeRates[ src ] ).toBe( 100 ); // Δmax = 1000/10s
		const p3 = reconstructWorkers( make( 3000, 300, [ 'A', 'B' ], 1020 ), {
			read: p2.nextRead,
			write: p2.nextWrite,
		} );
		expect( p3.writeRates[ src ] ).toBe( 100 );
	} );
} );

// Bind to the handler equal to the reader basename (prereq), not req.
const SUBSTRING_COLLISION_GRAPH = {
	t: {
		nodes: [
			{
				name: 'req',
				kind: 'consumer',
				reads: 'shared.p<partition>',
			},
			{
				name: 'prereq',
				kind: 'consumer',
				reads: 'shared.p<partition>',
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

describe( 'reconstructWorkers — read step computed once per reader (not per topology)', () => {
	// The per-reader read step must be computed ONCE, not per topology (N×M).
	const buildData = ( topologyCount ) => {
		const graph = {};
		for ( let i = 0; i < topologyCount; i++ ) {
			graph[ `t${ i }` ] = {
				nodes: [
					{
						name: 'c',
						kind: 'consumer',
						reads: 'shared.p<partition>',
					},
					{ name: 'proc', kind: 'logic' },
				],
				edges: [ [ 'c', 'proc' ] ],
			};
		}
		let idReads = 0;
		const segment = {
			get id() {
				idReads++;
				return 0;
			},
			size: 200,
		};
		const data = {
			graph,
			workers: [],
			consumers: [
				{
					reader: 'shared.p0',
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
							segments: [ segment ],
							total_size: 200,
						},
					],
				},
			],
			timestamp: 1000,
		};
		reconstructWorkers( data, EMPTY_PRIOR );
		return idReads;
	};

	it( 'does not scale the per-reader read computation with the number of topologies', () => {
		const oneTopology = buildData( 1 );
		const fourTopologies = buildData( 4 );
		// A reader's read step is same no matter how many topologies use it.
		expect( fourTopologies ).toBe( oneTopology );
	} );
} );

describe( 'reconstructWorkers — liveness backfill', () => {
	it( 'emits a row for a live worker that has no probe row yet', () => {
		const data = { ...FANOUT_DATA, consumers: [] };
		const { workers } = reconstructWorkers( data, EMPTY_PRIOR );
		expect( workers ).toHaveLength( 1 );
		expect( workers[ 0 ].type ).toBe( 'combined' );
		expect( workers[ 0 ].live ).toBe( true );
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
				status: 'running',
				live: true,
				stale: false,
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
		// Only undeclared + unbacked is a ghost; declared-but-dead stays.
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
// client substituted only `<partition>`, so `firehose.<topology>.p0` never
// matched the live reader `firehose.combined.p0` — no cursor, and every segment
// bar on the topologies dashboard painted grey.
const TOPOLOGY_TOKEN_GRAPH = {
	combined: {
		nodes: [
			{
				name: 'firehose:consumer',
				kind: 'consumer',
				reads: 'firehose.p<partition>',
				reader: 'firehose.<topology>.p<partition>',
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
	workers: [ { type: 'combined', partition: 0, status: 'live', live: true } ],
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
