/**
 * worker-status:transform tests — the stateful transform that turns a raw
 * `dump_graph` reply (VALUE=`{ name, payload }`, payload=the snapshot) into
 * an enriched `{ action:'model', model }`.
 *
 * The dump_graph payload is LEAN and POSITIONAL: PHP does not pre-join worker
 * attribution. The transform BUILDS the rich `workers[]` array (the shape
 * `topologyGraph.buildTopologySections`, `TreeEntity`, and `SegmentBar` read)
 * by joining the four inputs — `graph` (.tsl structure), `workers` (liveness
 * only), `consumers` (per-reader probe STATE), and `logs` (live segment
 * lists) — entirely here.
 *
 * Read/write byte rates are CLIENT-SIDE deltas across two polls (the probe
 * carries no rate on each descriptor), so the rate tests feed two
 * consecutive snapshots and assert the computed deltas. Date.now is NOT read
 * for the delta — `data.timestamp` is the clock — but it seeds the sticky
 * currentTime, so we pin it for determinism.
 */

import {
	VALUE,
	TO,
	FROM,
	TYPE,
	TM_STRUCT,
	TM_COMMAND,
	TM_RESPONSE,
	newMessage,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { WorkerStatusTransformNode } from '../worker-status-transform-node';
import { globalRates } from '../../globalRates';

beforeEach( () => Core.reset() );

function makeTransform( name ) {
	const node = new WorkerStatusTransformNode();
	node.name = name;
	return node;
}

function capture() {
	const got = [];
	return { node: { fill: ( m ) => got.push( m ) }, got };
}

// A dump_graph reply Message as HttpOut delivers it: VALUE = { name, payload }.
function metadataMsg( metadata ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { name: 'dump_graph', payload: metadata };
	return m;
}

// Pin Date.now() for the sticky currentTime seed only.
function withClock( fn ) {
	const realNow = Date.now;
	Date.now = () => 1_000_000;
	try {
		fn();
	} finally {
		Date.now = realNow;
	}
}

// Single-stage firehose topology: Consumer → Log, partition 0 only.
const firehoseGraph = () => ( {
	'firehose-workers': {
		nodes: [
			{
				name: 'firehose-in',
				kind: 'consumer',
				reads: 'firehose.p{partition}',
			},
			{
				name: 'firehose-log',
				kind: 'log',
				writes: 'firehose.p{partition}',
			},
		],
		edges: [ [ 'firehose-in', 'firehose-log' ] ],
	},
} );

// Request topology: Consumer → request-builder → completed Log; 2 parts.
const requestGraph = () => ( {
	'request-workers': {
		nodes: [
			{
				name: 'req-in',
				kind: 'consumer',
				reads: 'requests.p{partition}',
			},
			{ name: 'request-builder', kind: 'logic' },
			{
				name: 'completed-log',
				kind: 'log',
				writes: 'completed.p{partition}',
			},
		],
		edges: [
			[ 'req-in', 'request-builder' ],
			[ 'request-builder', 'completed-log' ],
		],
	},
} );

// A consumer feeding through a tee before the logic node — tee must contract.
const teeGraph = () => ( {
	'request-workers': {
		nodes: [
			{
				name: 'req-in',
				kind: 'consumer',
				reads: 'requests.p{partition}',
			},
			{ name: 'fanout', kind: 'tee' },
			{ name: 'request-builder', kind: 'logic' },
		],
		edges: [
			[ 'req-in', 'fanout' ],
			[ 'fanout', 'request-builder' ],
		],
	},
} );

// liveness row for a (type, partition).
const liveness = ( type, partition, extra = {} ) => ( {
	type,
	partition,
	state: 'live',
	started_at: 1000,
	heartbeat_age: 1,
	heartbeat_at: 999,
	restart_pending: false,
	...extra,
} );

// probe STATE row for a reader.
const consumerRow = ( reader, source, partition, extra = {} ) => ( {
	reader,
	source,
	partition,
	cursor_segment: 0,
	cursor_offset: 0,
	end_segment: 0,
	end_size: 0,
	distance: 0,
	msgs: 0,
	...extra,
} );

// a logs[] entry: one concrete partition with the given segments.
const logEntry = ( name, partition, segments ) => ( {
	name,
	partitions: [
		{
			partition,
			segments,
			total_size: segments.reduce( ( a, s ) => a + s.size, 0 ),
		},
	],
	segment_size: 16 * 1024 * 1024,
} );

describe( 'worker-status:transform — reconstructs the rich workers[]', () => {
	test( 'a single-stage consumer (feeds a Log) gets handler = its own node name', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: firehoseGraph(),
					workers: [ liveness( 'firehose-workers', 0 ) ],
					consumers: [
						consumerRow( 'firehose.p0', 'firehose.p0', 0 ),
					],
					logs: [
						logEntry( 'firehose.p0', 0, [ { id: 0, size: 100 } ] ),
					],
				} )
			)
		);
		// The emitted model message identifies its source node via FROM.
		expect( sink.got[ 0 ][ FROM ] ).toBe( 'worker-status:transform' );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.workers ).toHaveLength( 1 );
		const wkr = model.workers[ 0 ];
		expect( wkr.type ).toBe( 'firehose-workers' );
		expect( wkr.handler ).toBe( 'firehose-in' );
		expect( wkr.source ).toBe( 'firehose.p0' );
		expect( wkr.inputs ).toEqual( [ 'firehose.p0' ] );
		expect( wkr.outputs ).toEqual( [] );
		expect( wkr.outputs_status ).toEqual( [] );
	} );

	test( 'a consumer feeding a logic node gets handler = that logic node', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: requestGraph(),
					workers: [ liveness( 'request-workers', 0 ) ],
					consumers: [
						consumerRow( 'requests.p0', 'requests.p0', 0 ),
					],
					logs: [ logEntry( 'requests.p0', 0, [] ) ],
				} )
			)
		);
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.workers[ 0 ].handler ).toBe( 'request-builder' );
	} );

	test( 'a tee between consumer and logic node is contracted out', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: teeGraph(),
					workers: [ liveness( 'request-workers', 0 ) ],
					consumers: [
						consumerRow( 'requests.p0', 'requests.p0', 0 ),
					],
					logs: [ logEntry( 'requests.p0', 0, [] ) ],
				} )
			)
		);
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.workers[ 0 ].handler ).toBe( 'request-builder' );
	} );

	test( 'joins probe cursor/distance onto the rich worker (cursor_offset carried through, distance→behind)', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: firehoseGraph(),
					workers: [ liveness( 'firehose-workers', 0 ) ],
					consumers: [
						consumerRow( 'firehose.p0', 'firehose.p0', 0, {
							cursor_segment: 2,
							cursor_offset: 50,
							distance: 4096,
						} ),
					],
					logs: [
						logEntry( 'firehose.p0', 0, [ { id: 2, size: 100 } ] ),
					],
				} )
			)
		);
		const wkr = sink.got[ 0 ][ VALUE ].model.workers[ 0 ];
		expect( wkr.cursor_segment ).toBe( 2 );
		expect( wkr.cursor_offset ).toBe( 50 );
		expect( wkr.behind ).toBe( 4096 );
	} );

	test( 'joins liveness state onto the rich worker', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: firehoseGraph(),
					workers: [
						liveness( 'firehose-workers', 0, {
							state: 'stale',
							restart_pending: true,
							heartbeat_age: 99,
						} ),
					],
					consumers: [
						consumerRow( 'firehose.p0', 'firehose.p0', 0 ),
					],
					logs: [ logEntry( 'firehose.p0', 0, [] ) ],
				} )
			)
		);
		const wkr = sink.got[ 0 ][ VALUE ].model.workers[ 0 ];
		expect( wkr.state ).toBe( 'stale' );
		expect( wkr.restart_pending ).toBe( true );
		expect( wkr.heartbeat_age ).toBe( 99 );
	} );

	test( 'a consumer row with no liveness row defaults state to down', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: firehoseGraph(),
					workers: [],
					consumers: [
						consumerRow( 'firehose.p0', 'firehose.p0', 0 ),
					],
					logs: [ logEntry( 'firehose.p0', 0, [] ) ],
				} )
			)
		);
		const wkr = sink.got[ 0 ][ VALUE ].model.workers[ 0 ];
		expect( wkr.state ).toBe( 'down' );
	} );

	test( 'a liveness row with no consumer row still emits a worker (so the tree shows it)', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: firehoseGraph(),
					workers: [ liveness( 'firehose-workers', 0 ) ],
					consumers: [],
					logs: [ logEntry( 'firehose.p0', 0, [] ) ],
				} )
			)
		);
		const wkr = sink.got[ 0 ][ VALUE ].model.workers[ 0 ];
		expect( wkr.type ).toBe( 'firehose-workers' );
		expect( wkr.state ).toBe( 'live' );
	} );

	test( 'expands all partitions present across the inputs', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: requestGraph(),
					workers: [
						liveness( 'request-workers', 0 ),
						liveness( 'request-workers', 1 ),
					],
					consumers: [
						consumerRow( 'requests.p0', 'requests.p0', 0 ),
						consumerRow( 'requests.p1', 'requests.p1', 1 ),
					],
					logs: [
						logEntry( 'requests.p0', 0, [] ),
						logEntry( 'requests.p1', 1, [] ),
					],
				} )
			)
		);
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.workers.map( ( wkr ) => wkr.partition ).sort() ).toEqual(
			[ 0, 1 ]
		);
		expect( model.workers.map( ( wkr ) => wkr.source ).sort() ).toEqual( [
			'requests.p0',
			'requests.p1',
		] );
	} );

	test( 'disambiguated readers of one source each get their own rich worker row', () => {
		// Two readers of firehose.p0 under distinct ids — both get a row.
		const graph = {
			'firehose-workers-and-jobs': {
				nodes: [
					{
						name: 'job-router',
						kind: 'consumer',
						reads: 'firehose.p{partition}',
					},
					{
						name: 'request-builder',
						kind: 'consumer',
						reads: 'firehose.p{partition}',
					},
					{
						name: 'jobs-log',
						kind: 'log',
						writes: 'jobs.p{partition}',
					},
				],
				edges: [
					[ 'job-router', 'jobs-log' ],
					[ 'request-builder', 'jobs-log' ],
				],
			},
		};
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph,
					workers: [ liveness( 'firehose-workers-and-jobs', 0 ) ],
					consumers: [
						consumerRow(
							'firehose.job-router.p0',
							'firehose.p0',
							0,
							{ msgs: 5 }
						),
						consumerRow(
							'firehose.request-builder.p0',
							'firehose.p0',
							0,
							{ msgs: 9 }
						),
					],
					logs: [
						logEntry( 'firehose.p0', 0, [ { id: 0, size: 100 } ] ),
					],
				} )
			)
		);
		const { model } = sink.got[ 0 ][ VALUE ];
		const fromP0 = model.workers.filter(
			( wkr ) => wkr.source === 'firehose.p0'
		);
		expect( fromP0 ).toHaveLength( 2 );
	} );
} );

describe( 'worker-status:transform — inputs_status carries full live segments + recorded end', () => {
	test( 'keeps the full live segments and carries the consumer end_segment/end_size', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: firehoseGraph(),
					workers: [ liveness( 'firehose-workers', 0 ) ],
					consumers: [
						consumerRow( 'firehose.p0', 'firehose.p0', 0, {
							cursor_segment: 1,
							cursor_offset: 0,
							end_segment: 1,
							end_size: 40,
						} ),
					],
					// Live grew past the snapshot; bar paints it all, no trim.
					logs: [
						logEntry( 'firehose.p0', 0, [
							{ id: 0, size: 100 },
							{ id: 1, size: 100 },
							{ id: 2, size: 30 },
						] ),
					],
				} )
			)
		);
		const wkr = sink.got[ 0 ][ VALUE ].model.workers[ 0 ];
		const status = wkr.inputs_status[ 0 ];
		expect( status.name ).toBe( 'firehose.p0' );
		// Full live segments — none dropped, none capped.
		expect( status.segments ).toEqual( [
			{ id: 0, size: 100 },
			{ id: 1, size: 100 },
			{ id: 2, size: 30 },
		] );
		expect( status.total_size ).toBe( 230 );
		expect( status.cursor_segment ).toBe( 1 );
		expect( status.cursor_offset ).toBe( 0 );
		// The recorded probe end rides along for the bar's red/gray split.
		expect( status.end_segment ).toBe( 1 );
		expect( status.end_size ).toBe( 40 );
	} );
} );

describe( 'worker-status:transform — byte rates on the probe clock', () => {
	// 37.5 MiB/s read, 12.5 MiB/s written, each sweep 15 seconds apart.
	const READ = 39_321_600;
	const WRITE = 13_107_200;
	const SWEEP_S = 15;

	// The poll at `ts` carries the newest sweep at or before it, made at `at`.
	// Cursor and end advance with the sweeps, as a real reader's do.
	const snapshot = ( ts, at ) => {
		const read = READ * ( at - 1000 );
		const end = WRITE * ( at - 1000 );
		return {
			graph: firehoseGraph(),
			timestamp: ts,
			workers: [ liveness( 'firehose-workers', 0 ) ],
			consumers: [
				consumerRow( 'firehose.p0', 'firehose.p0', 0, {
					cursor_offset: read,
					end_size: end,
					bytes_read: READ * SWEEP_S,
					elapsed_ms: SWEEP_S * 1000,
				} ),
			],
			logs: [
				{
					...logEntry( 'firehose.p0', 0, [ { id: 0, size: end } ] ),
					partitions: [
						{
							partition: 0,
							segments: [ { id: 0, size: end } ],
							total_size: end,
							probe: {
								grown: WRITE * SWEEP_S,
								elapsed_ms: SWEEP_S * 1000,
							},
						},
					],
				},
			],
		};
	};

	// The Read and Write cards' sums for each emitted model.
	const cards = ( sink ) =>
		sink.got.map( ( m ) =>
			globalRates(
				m[ VALUE ].model.byteRates,
				m[ VALUE ].model.writeRates
			)
		);

	test( 'a hidden gap followed by polls 5s apart reads the probe rate, not ~3x', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () => {
			t.fill( metadataMsg( snapshot( 1003, 1000.5 ) ) );
			t.fill( metadataMsg( snapshot( 1008, 1000.5 ) ) );
			// Hidden for ten minutes; the first poll back sees the sweep at
			// 1600.5, and the next, five seconds on, the sweep after it.
			t.fill( metadataMsg( snapshot( 1611, 1600.5 ) ) );
			t.fill( metadataMsg( snapshot( 1616, 1615.5 ) ) );
			t.fill( metadataMsg( snapshot( 1621, 1615.5 ) ) );
		} );
		const [ , , back, next, held ] = cards( sink );
		expect( back.readRate ).toBe( READ );
		expect( next.readRate ).toBe( READ );
		expect( held.readRate ).toBe( READ );
		expect( back.writeRate ).toBe( WRITE );
		expect( next.writeRate ).toBe( WRITE );
		expect( held.writeRate ).toBe( WRITE );
	} );

	test( 'steady polling reads the probe rate on every poll', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () => {
			t.fill( metadataMsg( snapshot( 1985, 1981.5 ) ) );
			[
				[ 1990, 1981.5 ],
				[ 1995, 1981.5 ],
				[ 2000, 1996.5 ],
				[ 2005, 1996.5 ],
				[ 2010, 1996.5 ],
				[ 2015, 2011.5 ],
				[ 2020, 2011.5 ],
				[ 2025, 2011.5 ],
				[ 2030, 2026.5 ],
			].forEach( ( [ ts, at ] ) =>
				t.fill( metadataMsg( snapshot( ts, at ) ) )
			);
		} );
		cards( sink ).forEach( ( card ) =>
			expect( card ).toEqual( { readRate: READ, writeRate: WRITE } )
		);
	} );
} );

describe( 'worker-status:transform — model envelope', () => {
	const snap = () => ( {
		graph: firehoseGraph(),
		workers: [ liveness( 'firehose-workers', 0 ) ],
		consumers: [ consumerRow( 'firehose.p0', 'firehose.p0', 0 ) ],
		logs: [ logEntry( 'firehose.p0', 0, [ { id: 0, size: 100 } ] ) ],
	} );

	test( 'emits a TM_STRUCT { action:"model", model } stamped TO=target', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		t.target = 'worker-status:view';
		withClock( () => t.fill( metadataMsg( snap() ) ) );
		expect( sink.got ).toHaveLength( 1 );
		expect( sink.got[ 0 ][ TYPE ] ).toBe( TM_STRUCT );
		expect( sink.got[ 0 ][ TO ] ).toBe( 'worker-status:view' );
		expect( sink.got[ 0 ][ VALUE ].action ).toBe( 'model' );
	} );

	test( 'the model carries the canonical shape', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () => t.fill( metadataMsg( snap() ) ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( Object.keys( model ).sort() ).toEqual(
			[
				'byteRates',
				'currentTime',
				'error',
				'graph',
				'heartbeatIntervalS',
				'loading',
				'logPartitions',
				'logs',
				'prevSegments',
				'refusedProducers',
				'removingSegments',
				'segmentSize',
				'unparseableLines',
				'unreadable',
				'writeRates',
				'workers',
			].sort()
		);
	} );

	test( 'threads the graph field straight through into the model', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		const s = snap();
		withClock( () => t.fill( metadataMsg( s ) ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.graph ).toEqual( s.graph );
	} );

	test( 'defaults graph to an empty object when the payload omits it', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill( metadataMsg( { workers: [], consumers: [], logs: [] } ) )
		);
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.graph ).toEqual( {} );
	} );

	test( 'forwards logs when the reader is at the live end', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		const s = snap();
		// Reader caught up to the live end → trim is a no-op, logs unchanged.
		s.consumers = [
			consumerRow( 'firehose.p0', 'firehose.p0', 0, { end_size: 100 } ),
		];
		withClock( () => t.fill( metadataMsg( s ) ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.logs ).toEqual( s.logs );
	} );

	test( 'passes heartbeat_interval_s through and retains it on a later omitting poll', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		const s = snap();
		s.heartbeat_interval_s = 10;
		withClock( () => {
			t.fill( metadataMsg( s ) );
			t.fill( metadataMsg( snap() ) );
		} );
		expect( sink.got[ 0 ][ VALUE ].model.heartbeatIntervalS ).toBe( 10 );
		expect( sink.got[ 1 ][ VALUE ].model.heartbeatIntervalS ).toBe( 10 );
	} );

	test( 'passes segment_size and timestamp through and retains them on a later omitting poll', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		const s = snap();
		s.segment_size = 1048576;
		s.timestamp = 4242;
		withClock( () => {
			t.fill( metadataMsg( s ) );
			t.fill( metadataMsg( snap() ) );
		} );
		expect( sink.got[ 0 ][ VALUE ].model.segmentSize ).toBe( 1048576 );
		expect( sink.got[ 0 ][ VALUE ].model.currentTime ).toBe( 4242 );
		expect( sink.got[ 1 ][ VALUE ].model.segmentSize ).toBe( 1048576 );
		expect( sink.got[ 1 ][ VALUE ].model.currentTime ).toBe( 4242 );
	} );

	test( 'threads log_partitions into the model and retains it on a later omitting poll', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		const s = snap();
		s.log_partitions = 11;
		withClock( () => {
			t.fill( metadataMsg( s ) );
			t.fill( metadataMsg( snap() ) );
		} );
		expect( sink.got[ 0 ][ VALUE ].model.logPartitions ).toBe( 11 );
		expect( sink.got[ 1 ][ VALUE ].model.logPartitions ).toBe( 11 );
	} );

	test( "carries each poll's unparseable_lines as measured, never a stale one", () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		const torn = snap();
		torn.unparseable_lines = 13;
		const clean = snap();
		clean.unparseable_lines = 0;
		withClock( () => {
			t.fill( metadataMsg( torn ) );
			t.fill( metadataMsg( clean ) );
		} );
		expect( sink.got[ 0 ][ VALUE ].model.unparseableLines ).toBe( 13 );
		expect( sink.got[ 1 ][ VALUE ].model.unparseableLines ).toBe( 0 );
	} );

	test( "carries each poll's unreadable topologies and refused producers as answered", () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		const broken = snap();
		broken.unreadable = { 'marmot-3301': 'include orphaned-3302 failed' };
		broken.refused_producers = {
			'firehose-3303.p{partition}': 'log producer firehose-3303 refused',
		};
		const mended = snap();
		mended.unreadable = [];
		mended.refused_producers = [];
		withClock( () => {
			t.fill( metadataMsg( broken ) );
			t.fill( metadataMsg( mended ) );
		} );
		const first = sink.got[ 0 ][ VALUE ].model;
		expect( first.unreadable ).toEqual( broken.unreadable );
		expect( first.refusedProducers ).toEqual( broken.refused_producers );
		const second = sink.got[ 1 ][ VALUE ].model;
		expect( second.unreadable ).toEqual( [] );
		expect( second.refusedProducers ).toEqual( [] );
	} );

	test( 'first snapshot reports loading=false and a null error', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () => t.fill( metadataMsg( snap() ) ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.loading ).toBe( false );
		expect( model.error ).toBeNull();
	} );
} );

describe( 'worker-status:transform — segment tracking from the live logs', () => {
	const grow = ( segments, endSegment, endSize ) => ( {
		graph: firehoseGraph(),
		timestamp: 1000,
		workers: [ liveness( 'firehose-workers', 0 ) ],
		consumers: [
			consumerRow( 'firehose.p0', 'firehose.p0', 0, {
				end_segment: endSegment,
				end_size: endSize,
			} ),
		],
		logs: [ logEntry( 'firehose.p0', 0, segments ) ],
	} );

	test( 'a removed segment shows up in removingSegments on the next snapshot', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () => {
			t.fill(
				metadataMsg(
					grow(
						[
							{ id: 1, size: 100 },
							{ id: 2, size: 100 },
						],
						2,
						100
					)
				)
			);
			t.fill( metadataMsg( grow( [ { id: 2, size: 100 } ], 2, 100 ) ) );
		} );
		const { model } = sink.got[ 1 ][ VALUE ];
		expect( model.removingSegments[ 'firehose.p0' ] ).toEqual( [
			{ id: 1, size: 100 },
		] );
	} );

	test( 'prevSegments reflects the PRIOR snapshot ids so new segments animate in', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () => {
			t.fill( metadataMsg( grow( [ { id: 1, size: 100 } ], 1, 100 ) ) );
			t.fill(
				metadataMsg(
					grow(
						[
							{ id: 1, size: 100 },
							{ id: 2, size: 100 },
						],
						2,
						100
					)
				)
			);
		} );
		const { model } = sink.got[ 1 ][ VALUE ];
		const prev = model.prevSegments[ 'firehose.p0' ];
		expect( prev.has( 1 ) ).toBe( true );
		expect( prev.has( 2 ) ).toBe( false );
	} );

	test( 'a log no worker reads is tracked like one a worker does, two departures at once included', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		const unread = ( segments ) => ( {
			...grow( [ { id: 1, size: 100 } ], 1, 100 ),
			logs: [
				logEntry( 'firehose.p0', 0, [ { id: 1, size: 100 } ] ),
				logEntry( 'completed.p0', 0, segments ),
			],
		} );
		const seg = ( id ) => ( { id, size: 4471 } );
		withClock( () => {
			t.fill(
				metadataMsg( unread( [ seg( 649 ), seg( 650 ), seg( 651 ) ] ) )
			);
			t.fill(
				metadataMsg( unread( [ seg( 651 ), seg( 652 ), seg( 653 ) ] ) )
			);
		} );
		const { model } = sink.got[ 1 ][ VALUE ];
		expect( [ ...model.prevSegments[ 'completed.p0' ] ] ).toEqual( [
			649, 650, 651,
		] );
		expect( model.removingSegments[ 'completed.p0' ] ).toEqual( [
			seg( 649 ),
			seg( 650 ),
		] );
	} );

	test( 'no removals → removingSegments is empty', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		withClock( () => {
			t.fill( metadataMsg( grow( [ { id: 1, size: 100 } ], 1, 100 ) ) );
			t.fill( metadataMsg( grow( [ { id: 1, size: 200 } ], 1, 200 ) ) );
		} );
		const { model } = sink.got[ 1 ][ VALUE ];
		expect( model.removingSegments ).toEqual( {} );
	} );
} );

describe( 'worker-status:transform — non-metadata replies', () => {
	test( 'ignores a reply for a verb other than dump_graph', () => {
		const sink = capture();
		const t = makeTransform( 'worker-status:transform' );
		t.sink = sink.node;
		t.target = 'worker-status:view';
		const reply = newMessage();
		reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		reply[ VALUE ] = { name: 'something_else', payload: {} };
		t.fill( reply );
		expect( sink.got ).toHaveLength( 0 );
		void TM_STRUCT;
	} );
} );

describe( 'worker-status:transform — node wiring', () => {
	const snap = () => ( {
		graph: firehoseGraph(),
		workers: [ liveness( 'firehose-workers', 0 ) ],
		consumers: [ consumerRow( 'firehose.p0', 'firehose.p0', 0 ) ],
		logs: [ logEntry( 'firehose.p0', 0, [] ) ],
	} );

	test( 'names the node', () => {
		const t = makeTransform( 'worker-status:transform' );
		expect( t.name ).toBe( 'worker-status:transform' );
	} );

	test( 'does nothing without a sink', () => {
		const t = makeTransform( 'worker-status:transform' );
		expect( () =>
			withClock( () => t.fill( metadataMsg( snap() ) ) )
		).not.toThrow();
	} );

	test( 'fill increments the node counter so the overlay shows throughput', () => {
		const t = makeTransform( 'worker-status:transform' );
		const sink = capture();
		t.sink = sink.node;
		t.target = 'worker-status:view';
		expect( t.counter ).toBe( 0 );
		withClock( () => t.fill( metadataMsg( snap() ) ) );
		expect( t.counter ).toBe( 1 );
	} );
} );
