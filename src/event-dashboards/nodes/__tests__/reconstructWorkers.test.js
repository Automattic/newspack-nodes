import { reconstructWorkers } from '../reconstructWorkers';
import { buildTopologySections } from '../../topologyGraph';

const EMPTY_PRIOR = { read: {}, write: {} };

// Flatten a buildTopologySections tree into all entities, for attachment asserts.
function flatten( entities, acc = [] ) {
	entities.forEach( ( e ) => {
		acc.push( e );
		flatten( e.children || [], acc );
	} );
	return acc;
}

// The `combined` topology shape: one consumer fans through a tee to TWO logic
// processors. The OLD payload emitted one worker row per target; the join must
// reproduce that so EACH processor's collapsed-graph vertex gets a worker row.
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
			cursor_seg: 0,
			cursor_off: 50,
			end_seg: 0,
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
		// Both rows share the reader's snapshot state + the worker's liveness
		// (including started_at, which drives the per-partition uptime).
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
		// The regression guard: picking only the first downstream handler would
		// leave job-router with no worker row.
		expect( byName( 'request-builder' )?.workers ?? [] ).toHaveLength( 1 );
		expect( byName( 'job-router' )?.workers ?? [] ).toHaveLength( 1 );
	} );
} );

// Two SEPARATE topologies tailing the SAME source log (firehose.p<N>) via their
// own offsetlogs — the request-builder / job-router shape. Each consumer carries
// a distinct `reader` template; the join must match each topology to ITS reader,
// not every probe row that happens to share the source.
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
			cursor_seg: 0,
			cursor_off: 50,
			end_seg: 0,
			end_size: 200,
			distance: 150,
			msgs: 7,
		},
		{
			reader: 'firehose.job-router.p0',
			source: 'firehose.p0',
			partition: 0,
			cursor_seg: 0,
			cursor_off: 10,
			end_seg: 0,
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
					cursor_seg: 0,
					cursor_off: 50,
					end_seg: 1,
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
		// The bar paints the live head with a gray "beyond" region, so the
		// payload must carry the FULL live segments — NOT trimmed to the probe.
		const logSegs = logs[ 0 ].partitions[ 0 ].segments;
		expect( logSegs.map( ( s ) => [ s.id, s.size ] ) ).toEqual( [
			[ 0, 100 ],
			[ 1, 250 ],
			[ 2, 999 ],
		] );
		expect( logs[ 0 ].partitions[ 0 ].total_size ).toBe( 1349 );
	} );

	it( 'inputs_status carries FULL live segments and the consumer end_seg/end_size', () => {
		const data = {
			...FANOUT_DATA,
			consumers: [
				{
					reader: 'firehose.p0',
					source: 'firehose.p0',
					partition: 0,
					cursor_seg: 0,
					cursor_off: 50,
					end_seg: 1,
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
		expect( status.cursor_seg ).toBe( 0 );
		expect( status.cursor_offset ).toBe( 50 );
		expect( status.end_seg ).toBe( 1 );
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
					cursor_seg: 0,
					cursor_off: 50,
					end_seg: 1,
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
		// id 2 (live, past the probe end) STAYS — it paints as the gray beyond region.
		expect( part.segments.map( ( s ) => s.id ) ).toEqual( [ 0, 1, 2 ] );
		expect( part.cursor_seg ).toBe( 0 );
		expect( part.cursor_offset ).toBe( 50 );
		expect( part.end_seg ).toBe( 1 );
		expect( part.end_size ).toBe( 30 );
	} );

	it( 'derives read_rate from the absolute cursor-byte delta across polls; first poll is 0', () => {
		const first = reconstructWorkers( FANOUT_DATA, EMPTY_PRIOR );
		const rb = `request-builder-0-firehose.p0`;
		expect( first.byteRates[ rb ] ).toBe( 0 ); // no prior

		// Cursor advances 50 → 150 over 10s → 10 B/s.
		const next = {
			...FANOUT_DATA,
			consumers: [ { ...FANOUT_DATA.consumers[ 0 ], cursor_off: 150 } ],
			timestamp: 1010,
		};
		const second = reconstructWorkers( next, {
			read: first.nextRead,
			write: first.nextWrite,
		} );
		expect( second.byteRates[ rb ] ).toBe( 10 );
		// Each worker also carries its own read_rate (for the ETA rollup / health).
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
					{ ...FANOUT_DATA.consumers[ 0 ], cursor_off: 150 },
				],
			},
			EMPTY_PRIOR
		);
		const reset = reconstructWorkers(
			{
				...FANOUT_DATA,
				consumers: [
					{ ...FANOUT_DATA.consumers[ 0 ], cursor_off: 10 },
				],
				timestamp: 1010,
			},
			{ read: first.nextRead, write: first.nextWrite }
		);
		expect( reset.byteRates[ `request-builder-0-firehose.p0` ] ).toBe( 0 );
	} );

	it( 'HOLDS the read rate across polls where the cursor is unchanged (no flicker to 0)', () => {
		const rb = `request-builder-0-firehose.p0`;
		// Poll 1: baseline (rate 0). Poll 2 (probe advanced the cursor): rate 10.
		const p1 = reconstructWorkers( FANOUT_DATA, EMPTY_PRIOR );
		const p2 = reconstructWorkers(
			{
				...FANOUT_DATA,
				consumers: [
					{ ...FANOUT_DATA.consumers[ 0 ], cursor_off: 150 },
				],
				timestamp: 1010,
			},
			{ read: p1.nextRead, write: p1.nextWrite }
		);
		expect( p2.byteRates[ rb ] ).toBe( 10 );
		// Poll 3: SAME probe data (cursor unchanged), poll clock advanced 1s. The
		// rate must HOLD at 10 — not drop to 0 because the poll saw no new probe.
		const p3 = reconstructWorkers(
			{
				...FANOUT_DATA,
				consumers: [
					{ ...FANOUT_DATA.consumers[ 0 ], cursor_off: 150 },
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
					end_seg: 0,
					end_size: endSize,
				},
			],
			// Live total GROWS every poll, but the write rate must ignore it and
			// track only the probe END — so a poll with unchanged end holds.
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
		// `completed` is written but nothing in the graph reads it — there are no
		// consumer rows, so its rate must come from the live segment head, else an
		// output log under a constant stream shows W 0 B/s forever.
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
		// The live head-segment size is sampled separately from the consumer end and
		// can be STALE/smaller; the write position must follow the fresh end (as the
		// READ rate follows the fresh cursor offset), not the capped live size — that
		// cap is why firehose.p1 stuck at 0 B/s while clearly filling.
		const src = 'firehose.p0';
		const make = ( endSize, ts ) => ( {
			...FANOUT_DATA,
			consumers: [
				{
					...FANOUT_DATA.consumers[ 0 ],
					end_seg: 0,
					end_size: endSize,
				},
			],
			logs: [
				{
					name: src,
					partitions: [
						{
							partition: 0,
							segments: [ { id: 0, size: 50 } ], // lags the end below
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
		// Two separate consumers (distinct readers) of the SAME partition, with
		// differing end snapshots; the head = max(end) advances 1000→2000→3000 over
		// 10s steps = 100 B/s. The committed rate must track the head and NOT depend
		// on the (unstable) consumers[] order — the bug stranded a fanned partition
		// at 0 because the two readers clobbered one writeRates key non-monotonically.
		const src = 'firehose.p0';
		const make = ( endA, endB, order, ts ) => ( {
			...FANOUT_DATA,
			consumers: order.map( ( which ) => ( {
				...FANOUT_DATA.consumers[ 0 ],
				reader: 'A' === which ? 'rb/firehose.p0' : 'jr/firehose.p0',
				end_seg: 0,
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
		expect( p2.writeRates[ src ] ).toBe( 100 ); // Δmax = 1000/10s, order-independent
		const p3 = reconstructWorkers( make( 3000, 300, [ 'A', 'B' ], 1020 ), {
			read: p2.nextRead,
			write: p2.nextWrite,
		} );
		expect( p3.writeRates[ src ] ).toBe( 100 );
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
