import { reconstructWorkers } from '../reconstructWorkers';
import { buildTopologySections } from '../../topologyGraph';

const EMPTY_PRIOR = { cursorBytes: {}, totalBytes: {}, timestamp: null };

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

describe( 'reconstructWorkers — segment trim + cursor rate', () => {
	it( 'trims live segments to the probe (end_seg, end_size)', () => {
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
		const segs = workers[ 0 ].inputs_status[ 0 ].segments;
		// id 2 dropped (past end_seg=1); id 1 capped at end_size=30.
		expect( segs.map( ( s ) => [ s.id, s.size ] ) ).toEqual( [
			[ 0, 100 ],
			[ 1, 30 ],
		] );
		expect( workers[ 0 ].inputs_status[ 0 ].total_size ).toBe( 130 );
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
			cursorBytes: first.nextCursorBytes,
			totalBytes: first.nextTotalBytes,
			timestamp: 1000,
		} );
		expect( second.byteRates[ rb ] ).toBe( 10 );
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
			{
				cursorBytes: first.nextCursorBytes,
				totalBytes: first.nextTotalBytes,
				timestamp: 1000,
			}
		);
		expect( reset.byteRates[ `request-builder-0-firehose.p0` ] ).toBe( 0 );
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
