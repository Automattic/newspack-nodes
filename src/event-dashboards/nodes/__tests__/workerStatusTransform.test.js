/**
 * workerstatus:transform tests — the stateful transform that turns a raw
 * `dump_graph` reply (VALUE=`{ name, payload }`, payload=the snapshot) into
 * an enriched `{ action:'model', model }`.
 *
 * Post-migration the dump_graph payload is LEAN and POSITIONAL: PHP no longer
 * pre-joins worker attribution. The transform now REBUILDS the old rich
 * `workers[]` array (the shape `topologyGraph.buildTopologySections`,
 * `TreeEntity`, and `SegmentBar` were written against) by joining the four new
 * inputs — `graph` (.tsl structure), `workers` (liveness only), `consumers`
 * (per-reader probe STATE), and `logs` (live segment lists) — entirely here,
 * so everything downstream stays unchanged.
 *
 * Read/write byte rates are now CLIENT-SIDE deltas across two polls (the probe
 * no longer rides a rate on each descriptor), so the rate tests feed two
 * consecutive snapshots and assert the computed deltas. Date.now is NOT read
 * for the delta — `data.timestamp` is the clock — but it seeds the sticky
 * currentTime, so we pin it for determinism.
 */

import {
	VALUE,
	TO,
	TYPE,
	TM_STRUCT,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	newMessage,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { WorkerStatusTransformNode } from '../workerStatusTransform';

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

// A single-stage firehose producer topology: one Consumer reading firehose
// straight into a Log (no logic node), partition 0 only.
const firehoseGraph = () => ( {
	'firehose-workers': {
		nodes: [
			{
				name: 'firehose-in',
				kind: 'consumer',
				reads: 'firehose.p<partition>',
			},
			{
				name: 'firehose-log',
				kind: 'log',
				writes: 'firehose.p<partition>',
			},
		],
		edges: [ [ 'firehose-in', 'firehose-log' ] ],
	},
} );

// A request topology: Consumer reads requests → request-builder (logic) →
// completed Log. Two partitions.
const requestGraph = () => ( {
	'request-workers': {
		nodes: [
			{
				name: 'req-in',
				kind: 'consumer',
				reads: 'requests.p<partition>',
			},
			{ name: 'request-builder', kind: 'logic' },
			{
				name: 'completed-log',
				kind: 'log',
				writes: 'completed.p<partition>',
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
				reads: 'requests.p<partition>',
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
	status: 'running',
	started_at: 1000,
	heartbeat_age: 1,
	heartbeat_at: 999,
	live: true,
	stale: false,
	restart_pending: false,
	...extra,
} );

// probe STATE row for a reader.
const consumerRow = ( reader, source, partition, extra = {} ) => ( {
	reader,
	source,
	partition,
	cursor_seg: 0,
	cursor_off: 0,
	end_seg: 0,
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

describe( 'workerstatus:transform — reconstructs the rich workers[]', () => {
	test( 'a single-stage consumer (feeds a Log) gets handler = its own node name', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
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
		const t = makeTransform( 'workerstatus:transform' );
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
		const t = makeTransform( 'workerstatus:transform' );
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

	test( 'joins probe cursor/distance onto the rich worker (cursor_off→cursor_offset, distance→behind)', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: firehoseGraph(),
					workers: [ liveness( 'firehose-workers', 0 ) ],
					consumers: [
						consumerRow( 'firehose.p0', 'firehose.p0', 0, {
							cursor_seg: 2,
							cursor_off: 50,
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
		expect( wkr.cursor_seg ).toBe( 2 );
		expect( wkr.cursor_offset ).toBe( 50 );
		expect( wkr.behind ).toBe( 4096 );
	} );

	test( 'joins liveness status onto the rich worker', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: firehoseGraph(),
					workers: [
						liveness( 'firehose-workers', 0, {
							status: 'stale',
							live: false,
							stale: true,
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
		expect( wkr.status ).toBe( 'stale' );
		expect( wkr.live ).toBe( false );
		expect( wkr.stale ).toBe( true );
		expect( wkr.restart_pending ).toBe( true );
		expect( wkr.heartbeat_age ).toBe( 99 );
	} );

	test( 'a consumer row with no liveness row defaults status to dead', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
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
		expect( wkr.status ).toBe( 'dead' );
	} );

	test( 'a liveness row with no consumer row still emits a worker (so the tree shows it)', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
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
		expect( wkr.status ).toBe( 'running' );
	} );

	test( 'expands all partitions present across the inputs', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
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
		// Two readers of firehose.p0 under distinct reader ids — both get a row.
		const graph = {
			'firehose-workers-and-jobs': {
				nodes: [
					{
						name: 'job-router',
						kind: 'consumer',
						reads: 'firehose.p<partition>',
					},
					{
						name: 'request-builder',
						kind: 'consumer',
						reads: 'firehose.p<partition>',
					},
					{
						name: 'jobs-log',
						kind: 'log',
						writes: 'jobs.p<partition>',
					},
				],
				edges: [
					[ 'job-router', 'jobs-log' ],
					[ 'request-builder', 'jobs-log' ],
				],
			},
		};
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
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

describe( 'workerstatus:transform — inputs_status carries full live segments + recorded end', () => {
	test( 'keeps the full live segments and carries the consumer end_seg/end_size', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill(
				metadataMsg( {
					graph: firehoseGraph(),
					workers: [ liveness( 'firehose-workers', 0 ) ],
					consumers: [
						consumerRow( 'firehose.p0', 'firehose.p0', 0, {
							cursor_seg: 1,
							cursor_off: 0,
							end_seg: 1,
							end_size: 40,
						} ),
					],
					// Live partition has grown past the snapshot: seg 2 is new, seg 1
					// is now bigger than end_size. The bar paints the full live data
					// (gray beyond the recorded end), so NOTHING is trimmed here.
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
		expect( status.cursor_seg ).toBe( 1 );
		expect( status.cursor_offset ).toBe( 0 );
		// The recorded probe end rides along so the bar can paint its red/gray split.
		expect( status.end_seg ).toBe( 1 );
		expect( status.end_size ).toBe( 40 );
	} );
} );

describe( 'workerstatus:transform — byte rates from cross-poll deltas', () => {
	// Read rate = Δ(absolute cursor byte position)/Δts; absolute position =
	// Σ(live seg.size for id < cursor_seg) + cursor_off. Write rate =
	// Δ(partition end position)/Δts.
	const snapshot = (
		ts,
		cursorSeg,
		cursorOff,
		segSizes,
		endSeg,
		endSize
	) => ( {
		graph: firehoseGraph(),
		timestamp: ts,
		workers: [ liveness( 'firehose-workers', 0 ) ],
		consumers: [
			consumerRow( 'firehose.p0', 'firehose.p0', 0, {
				cursor_seg: cursorSeg,
				cursor_off: cursorOff,
				end_seg: endSeg,
				end_size: endSize,
			} ),
		],
		logs: [
			logEntry(
				'firehose.p0',
				0,
				segSizes.map( ( size, id ) => ( { id, size } ) )
			),
		],
	} );

	test( 'first snapshot reports a zero read_rate and write_rate', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill( metadataMsg( snapshot( 1000, 0, 0, [ 100 ], 0, 100 ) ) )
		);
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.byteRates[ 'firehose-in-0-firehose.p0' ] ).toBe( 0 );
		expect( model.writeRates[ 'firehose.p0' ] ).toBe( 0 );
	} );

	test( 'read_rate = Δ(absolute cursor position)/Δts across two polls', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		withClock( () => {
			// Poll 1: cursor at seg 0 offset 0 → abs pos 0.
			t.fill( metadataMsg( snapshot( 1000, 0, 0, [ 100 ], 0, 100 ) ) );
			// Poll 2 at ts 1002 (Δ 2s): cursor at seg 1 offset 50. The cursor seg
			// contributes only its offset, segments below it their full live size.
			// abs pos = Σ(live seg.size for id < cursor_seg 1) + cursor_off
			//         = 100 + 50 = 150. Δ = 150 - 0 = 150 over 2s = 75 B/s.
			t.fill(
				metadataMsg( snapshot( 1002, 1, 50, [ 100, 90 ], 1, 80 ) )
			);
		} );
		const { model } = sink.got[ 1 ][ VALUE ];
		expect( model.byteRates[ 'firehose-in-0-firehose.p0' ] ).toBe( 75 );
	} );

	test( 'write_rate = Δ(partition total live bytes)/Δts across two polls', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		withClock( () => {
			// Poll 1: total live = 100.
			t.fill( metadataMsg( snapshot( 1000, 0, 0, [ 100 ], 0, 100 ) ) );
			// Poll 2 at ts 1004 (Δ 4s): total live = 100 + 300 = 400.
			// Δ = 400 - 100 = 300 over 4s = 75 B/s.
			t.fill(
				metadataMsg( snapshot( 1004, 0, 0, [ 100, 300 ], 1, 300 ) )
			);
		} );
		const { model } = sink.got[ 1 ][ VALUE ];
		expect( model.writeRates[ 'firehose.p0' ] ).toBe( 75 );
	} );

	test( 'a cursor that goes backwards (worker restart) yields read_rate 0, never negative', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		withClock( () => {
			// Poll 1: cursor well advanced.
			t.fill(
				metadataMsg( snapshot( 1000, 1, 50, [ 100, 100 ], 1, 100 ) )
			);
			// Poll 2: cursor reset to the start (restart).
			t.fill(
				metadataMsg( snapshot( 1002, 0, 0, [ 100, 100 ], 1, 100 ) )
			);
		} );
		const { model } = sink.got[ 1 ][ VALUE ];
		expect( model.byteRates[ 'firehose-in-0-firehose.p0' ] ).toBe( 0 );
	} );

	test( 'a zero time delta yields rate 0 (no divide-by-zero)', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		withClock( () => {
			t.fill( metadataMsg( snapshot( 1000, 0, 0, [ 100 ], 0, 100 ) ) );
			t.fill(
				metadataMsg( snapshot( 1000, 1, 0, [ 100, 100 ], 1, 100 ) )
			);
		} );
		const { model } = sink.got[ 1 ][ VALUE ];
		expect( model.byteRates[ 'firehose-in-0-firehose.p0' ] ).toBe( 0 );
		expect( model.writeRates[ 'firehose.p0' ] ).toBe( 0 );
	} );
} );

describe( 'workerstatus:transform — model envelope', () => {
	const snap = () => ( {
		graph: firehoseGraph(),
		workers: [ liveness( 'firehose-workers', 0 ) ],
		consumers: [ consumerRow( 'firehose.p0', 'firehose.p0', 0 ) ],
		logs: [ logEntry( 'firehose.p0', 0, [ { id: 0, size: 100 } ] ) ],
	} );

	test( 'emits a TM_STRUCT { action:"model", model } stamped TO=target', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		t.target = 'workerstatus:view';
		withClock( () => t.fill( metadataMsg( snap() ) ) );
		expect( sink.got ).toHaveLength( 1 );
		expect( sink.got[ 0 ][ TYPE ] ).toBe( TM_STRUCT );
		expect( sink.got[ 0 ][ TO ] ).toBe( 'workerstatus:view' );
		expect( sink.got[ 0 ][ VALUE ].action ).toBe( 'model' );
	} );

	test( 'the model carries the canonical shape', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
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
				'removingSegments',
				'segmentSize',
				'supervisor',
				'writeRates',
				'workers',
			].sort()
		);
	} );

	test( 'threads the graph field straight through into the model', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		const s = snap();
		withClock( () => t.fill( metadataMsg( s ) ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.graph ).toEqual( s.graph );
	} );

	test( 'defaults graph to an empty object when the payload omits it', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		withClock( () =>
			t.fill( metadataMsg( { workers: [], consumers: [], logs: [] } ) )
		);
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.graph ).toEqual( {} );
	} );

	test( 'forwards supervisor straight through; forwards logs when the reader is at the live end', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		const s = snap();
		s.supervisor = { type: 'supervisor', status: 'running' };
		// Reader caught up to the live end (end_size matches the 100B segment) →
		// the snapshot trim is a no-op, so logs pass through unchanged.
		s.consumers = [
			consumerRow( 'firehose.p0', 'firehose.p0', 0, { end_size: 100 } ),
		];
		withClock( () => t.fill( metadataMsg( s ) ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.supervisor ).toEqual( s.supervisor );
		expect( model.logs ).toEqual( s.logs );
	} );

	test( 'passes heartbeat_interval_s through and retains it on a later omitting poll', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
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
		const t = makeTransform( 'workerstatus:transform' );
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
		const t = makeTransform( 'workerstatus:transform' );
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

	test( 'first snapshot reports loading=false and a null error', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		withClock( () => t.fill( metadataMsg( snap() ) ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.loading ).toBe( false );
		expect( model.error ).toBeNull();
	} );
} );

describe( 'workerstatus:transform — segment tracking from the TRIMMED inputs_status', () => {
	const grow = ( segments, endSeg, endSize ) => ( {
		graph: firehoseGraph(),
		timestamp: 1000,
		workers: [ liveness( 'firehose-workers', 0 ) ],
		consumers: [
			consumerRow( 'firehose.p0', 'firehose.p0', 0, {
				end_seg: endSeg,
				end_size: endSize,
			} ),
		],
		logs: [ logEntry( 'firehose.p0', 0, segments ) ],
	} );

	test( 'a removed segment shows up in removingSegments on the next snapshot', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
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
		const t = makeTransform( 'workerstatus:transform' );
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

	test( 'no removals → removingSegments is empty', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		withClock( () => {
			t.fill( metadataMsg( grow( [ { id: 1, size: 100 } ], 1, 100 ) ) );
			t.fill( metadataMsg( grow( [ { id: 1, size: 200 } ], 1, 200 ) ) );
		} );
		const { model } = sink.got[ 1 ][ VALUE ];
		expect( model.removingSegments ).toEqual( {} );
	} );
} );

describe( 'workerstatus:transform — non-metadata replies', () => {
	test( 'ignores a reply for a verb other than dump_graph', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		t.target = 'workerstatus:view';
		const reply = newMessage();
		reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		reply[ VALUE ] = { name: 'something_else', payload: {} };
		t.fill( reply );
		expect( sink.got ).toHaveLength( 0 );
		void TM_STRUCT;
	} );

	test( 'forwards a TM_ERROR reply to the view (un-correlated poll failure)', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		t.target = 'workerstatus:view';
		const err = newMessage();
		err[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
		err[ VALUE ] = { name: 'dump_graph', payload: 'Server disconnected' };
		t.fill( err );
		expect( sink.got ).toHaveLength( 1 );
		expect( sink.got[ 0 ][ TO ] ).toBe( 'workerstatus:view' );
	} );
} );

describe( 'workerstatus:transform — node wiring', () => {
	const snap = () => ( {
		graph: firehoseGraph(),
		workers: [ liveness( 'firehose-workers', 0 ) ],
		consumers: [ consumerRow( 'firehose.p0', 'firehose.p0', 0 ) ],
		logs: [ logEntry( 'firehose.p0', 0, [] ) ],
	} );

	test( 'names the node', () => {
		const t = makeTransform( 'workerstatus:transform' );
		expect( t.name ).toBe( 'workerstatus:transform' );
	} );

	test( 'does nothing without a sink', () => {
		const t = makeTransform( 'workerstatus:transform' );
		expect( () =>
			withClock( () => t.fill( metadataMsg( snap() ) ) )
		).not.toThrow();
	} );

	test( 'fill increments the node counter so the overlay shows throughput', () => {
		const t = makeTransform( 'workerstatus:transform' );
		const sink = capture();
		t.sink = sink.node;
		t.target = 'workerstatus:view';
		expect( t.counter ).toBe( 0 );
		withClock( () => t.fill( metadataMsg( snap() ) ) );
		expect( t.counter ).toBe( 1 );
	} );
} );
