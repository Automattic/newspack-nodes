/**
 * workerstatus:transform tests — the stateful transform that turns a raw
 * `dump_metadata` reply (VALUE=`{ name, payload }`, payload=the snapshot) into
 * an enriched `{ action:'model', model }`. Post-migration to substrate `_http`,
 * the transform receives the reply directly from HttpOut (TO=transform,
 * FROM=workers); the payload is the metadata. Rate + segment math is ported
 * verbatim from WorkerStatus.fetchWorkers, so the tests feed two consecutive
 * snapshots and assert the computed deltas.
 *
 * Date.now() is faked (not jest fake timers) so the time-delta between the two
 * snapshots is deterministic — the node reads Date.now() for its receive-time
 * delta exactly like the old lastFetchTimeRef logic.
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

// setName registers in the per-process Core registry; clear it between tests so
// re-creating the same-named node doesn't collide (matches the sibling tests).
beforeEach( () => Core.reset() );

// Construct the node directly (production wires it via interpreter.makeNode;
// bare-newing the class is fine inside a test).
function makeTransform( name ) {
	const node = new WorkerStatusTransformNode();
	node.setName( name );
	return node;
}

// Capture sink: a minimal node whose fill() records every message it receives.
function capture() {
	const got = [];
	return { node: { fill: ( m ) => got.push( m ) }, got };
}

// A dump_metadata reply Message as HttpOut delivers it: VALUE = { name, payload }
// where `payload` is the workers/logs metadata snapshot.
function metadataMsg( metadata ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	m[ VALUE ] = { name: 'dump_metadata', payload: metadata };
	return m;
}

// Pin Date.now() so the receive-time delta is deterministic.
function withClock( fn ) {
	const realNow = Date.now;
	let t = 1_000_000;
	Date.now = () => t;
	try {
		fn( ( ms ) => {
			t += ms;
		} );
	} finally {
		Date.now = realNow;
	}
}

// One firehose producer writing firehose.log; total_size grows between snapshots.
const producerSnapshot = ( totalSize ) => ( {
	workers: [
		{
			type: 'firehose-workers',
			handler: 'firehose-workers',
			partition: 0,
			inputs: [],
			outputs: [ 'firehose.log' ],
			inputs_status: [],
			outputs_status: [
				{
					name: 'firehose.log',
					segments: [ { id: 1, size: totalSize } ],
					total_size: totalSize,
				},
			],
		},
	],
	supervisor: null,
	logs: [],
} );

// One request consumer reading firehose.log; cursor advances between snapshots.
const consumerSnapshot = ( cursorOffset ) => ( {
	workers: [
		{
			type: 'request-workers',
			handler: 'request-workers',
			partition: 0,
			inputs: [ 'firehose.log' ],
			outputs: [],
			inputs_status: [
				{
					name: 'firehose.log',
					segments: [ { id: 1, size: 100000 } ],
					total_size: 100000,
					cursor_seg: 1,
					cursor_offset: cursorOffset,
				},
			],
			outputs_status: [],
		},
	],
	supervisor: null,
	logs: [],
} );

describe( 'workerstatus:transform — model envelope', () => {
	test( 'emits a TM_STRUCT { action:"model", model } for a metadata snapshot', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		t.target = 'workerstatus:view';
		t.fill( metadataMsg( producerSnapshot( 100 ) ) );
		expect( sink.got ).toHaveLength( 1 );
		expect( sink.got[ 0 ][ TYPE ] ).toBe( TM_STRUCT );
		// Rule #2: the model emit stamps TO=target for router delivery.
		expect( sink.got[ 0 ][ TO ] ).toBe( 'workerstatus:view' );
		expect( sink.got[ 0 ][ VALUE ].action ).toBe( 'model' );
	} );

	test( 'the model carries the canonical shape', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		t.fill( metadataMsg( producerSnapshot( 100 ) ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( Object.keys( model ).sort() ).toEqual(
			[
				'byteRates',
				'currentTime',
				'error',
				'loading',
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

	test( 'forwards the workers / supervisor / logs straight through', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		const snap = producerSnapshot( 100 );
		snap.supervisor = { type: 'supervisor', status: 'running' };
		snap.logs = [ { name: 'firehose.log', partitions: [] } ];
		t.fill( metadataMsg( snap ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.workers ).toEqual( snap.workers );
		expect( model.supervisor ).toEqual( snap.supervisor );
		expect( model.logs ).toEqual( snap.logs );
	} );

	test( 'passes segment_size and timestamp through to the model', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		const snap = producerSnapshot( 100 );
		snap.segment_size = 1048576;
		snap.timestamp = 4242;
		t.fill( metadataMsg( snap ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.segmentSize ).toBe( 1048576 );
		expect( model.currentTime ).toBe( 4242 );
	} );

	test( 'retains the last segment_size when a later poll omits it', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		// Poll 1 carries a segment_size; poll 2 omits it.
		const withSize = producerSnapshot( 100 );
		withSize.segment_size = 1048576;
		t.fill( metadataMsg( withSize ) );
		t.fill( metadataMsg( producerSnapshot( 200 ) ) ); // no segment_size
		const { model } = sink.got[ 1 ][ VALUE ];
		// Retained poll-1's value, NOT reset to the 64MB default.
		expect( model.segmentSize ).toBe( 1048576 );
	} );

	test( 'retains the last timestamp when a later poll omits it', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		// Poll 1 carries a timestamp; poll 2 omits it.
		const withTs = producerSnapshot( 100 );
		withTs.timestamp = 4242;
		t.fill( metadataMsg( withTs ) );
		t.fill( metadataMsg( producerSnapshot( 200 ) ) ); // no timestamp
		const { model } = sink.got[ 1 ][ VALUE ];
		// Retained poll-1's value, NOT reset to the client clock.
		expect( model.currentTime ).toBe( 4242 );
	} );

	test( 'first snapshot reports loading=false and a null error', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		t.fill( metadataMsg( producerSnapshot( 100 ) ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.loading ).toBe( false );
		expect( model.error ).toBeNull();
	} );
} );

describe( 'workerstatus:transform — rate math from two snapshots', () => {
	test( 'first snapshot yields no rates (no previous to delta against)', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		t.fill( metadataMsg( producerSnapshot( 100 ) ) );
		const { model } = sink.got[ 0 ][ VALUE ];
		expect( model.writeRates ).toEqual( {} );
		expect( model.byteRates ).toEqual( {} );
	} );

	test( 'second snapshot computes write rate from total_size delta / time', () => {
		withClock( ( advance ) => {
			const sink = capture();
			const t = makeTransform( 'workerstatus:transform' );
			t.sink = sink.node;
			t.fill( metadataMsg( producerSnapshot( 100 ) ) );
			advance( 2000 ); // 2s between snapshots
			t.fill( metadataMsg( producerSnapshot( 1100 ) ) );
			const { model } = sink.got[ 1 ][ VALUE ];
			// (1100 - 100) bytes / 2s = 500 B/s, keyed by `${name}-${partition}`.
			expect( model.writeRates[ 'firehose-0' ] ).toBe( 500 );
		} );
	} );

	test( 'second snapshot computes per-worker read rate from cursor delta', () => {
		withClock( ( advance ) => {
			const sink = capture();
			const t = makeTransform( 'workerstatus:transform' );
			t.sink = sink.node;
			t.fill( metadataMsg( consumerSnapshot( 0 ) ) );
			advance( 1000 ); // 1s
			t.fill( metadataMsg( consumerSnapshot( 2000 ) ) );
			const { model } = sink.got[ 1 ][ VALUE ];
			// processed went 0 → 2000 over 1s; key `${handler}-${partition}-${source}`.
			expect( model.byteRates[ 'request-workers-0-' ] ).toBe( 2000 );
		} );
	} );

	test( 'a shrinking total_size clamps the write rate to zero (stale snapshot)', () => {
		withClock( ( advance ) => {
			const sink = capture();
			const t = makeTransform( 'workerstatus:transform' );
			t.sink = sink.node;
			t.fill( metadataMsg( producerSnapshot( 1100 ) ) );
			advance( 2000 );
			t.fill( metadataMsg( producerSnapshot( 100 ) ) ); // went backwards
			const { model } = sink.got[ 1 ][ VALUE ];
			expect( model.writeRates[ 'firehose-0' ] ).toBe( 0 );
		} );
	} );
} );

describe( 'workerstatus:transform — segment tracking', () => {
	test( 'a removed segment shows up in removingSegments on the next snapshot', () => {
		withClock( ( advance ) => {
			const sink = capture();
			const t = makeTransform( 'workerstatus:transform' );
			t.sink = sink.node;
			// Snapshot 1: two segments.
			const two = producerSnapshot( 200 );
			two.workers[ 0 ].outputs_status[ 0 ].segments = [
				{ id: 1, size: 100 },
				{ id: 2, size: 100 },
			];
			t.fill( metadataMsg( two ) );
			advance( 2000 );
			// Snapshot 2: segment 1 rolled off.
			const one = producerSnapshot( 100 );
			one.workers[ 0 ].outputs_status[ 0 ].segments = [
				{ id: 2, size: 100 },
			];
			t.fill( metadataMsg( one ) );
			const { model } = sink.got[ 1 ][ VALUE ];
			expect( model.removingSegments[ 'firehose-0' ] ).toEqual( [
				{ id: 1, size: 100 },
			] );
		} );
	} );

	test( 'prevSegments reflects the PRIOR snapshot ids so new segments animate in', () => {
		withClock( ( advance ) => {
			const sink = capture();
			const t = makeTransform( 'workerstatus:transform' );
			t.sink = sink.node;
			// Snapshot 1: one segment.
			t.fill( metadataMsg( producerSnapshot( 100 ) ) );
			advance( 2000 );
			// Snapshot 2: a second segment appeared.
			const two = producerSnapshot( 200 );
			two.workers[ 0 ].outputs_status[ 0 ].segments = [
				{ id: 1, size: 100 },
				{ id: 2, size: 100 },
			];
			t.fill( metadataMsg( two ) );
			const { model } = sink.got[ 1 ][ VALUE ];
			// The model's prevSegments is the PRIOR snapshot (only id 1), so id 2
			// is detected as new by the render path.
			const prev = model.prevSegments[ 'firehose-0' ];
			expect( prev.has( 1 ) ).toBe( true );
			expect( prev.has( 2 ) ).toBe( false );
		} );
	} );

	test( 'no removals → removingSegments is empty', () => {
		withClock( ( advance ) => {
			const sink = capture();
			const t = makeTransform( 'workerstatus:transform' );
			t.sink = sink.node;
			t.fill( metadataMsg( producerSnapshot( 100 ) ) );
			advance( 2000 );
			t.fill( metadataMsg( producerSnapshot( 200 ) ) );
			const { model } = sink.got[ 1 ][ VALUE ];
			expect( model.removingSegments ).toEqual( {} );
		} );
	} );
} );

describe( 'workerstatus:transform — non-metadata replies', () => {
	test( 'ignores a reply for a verb other than dump_metadata', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		t.target = 'workerstatus:view';
		const reply = newMessage();
		reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		reply[ VALUE ] = { name: 'something_else', payload: {} };
		t.fill( reply );
		// Transform only acts on dump_metadata replies; anything else is a no-op
		// (the view is the receiver for restart/error replies).
		expect( sink.got ).toHaveLength( 0 );
		// Suppress unused-var lint on TM_STRUCT now that the control-pass-through
		// test is gone — TM_STRUCT is still used for the emit assertion above.
		void TM_STRUCT;
	} );

	test( 'forwards a TM_ERROR reply to the view (un-correlated poll failure)', () => {
		const sink = capture();
		const t = makeTransform( 'workerstatus:transform' );
		t.sink = sink.node;
		t.target = 'workerstatus:view';
		const err = newMessage();
		err[ TYPE ] = TM_COMMAND | TM_RESPONSE | TM_ERROR;
		err[ VALUE ] = {
			name: 'dump_metadata',
			payload: 'Server disconnected',
		};
		t.fill( err );
		// Transform forwards (rather than dropping) so the view's
		// un-correlated-error path can surface the disconnect banner.
		expect( sink.got ).toHaveLength( 1 );
		expect( sink.got[ 0 ][ TO ] ).toBe( 'workerstatus:view' );
	} );
} );

describe( 'workerstatus:transform — node wiring', () => {
	test( 'names the node', () => {
		const t = makeTransform( 'workerstatus:transform' );
		expect( t.name ).toBe( 'workerstatus:transform' );
	} );

	test( 'does nothing without a sink', () => {
		const t = makeTransform( 'workerstatus:transform' );
		expect( () =>
			t.fill( metadataMsg( producerSnapshot( 100 ) ) )
		).not.toThrow();
	} );
} );
