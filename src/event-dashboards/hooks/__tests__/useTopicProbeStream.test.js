/**
 * useTopicProbeStream tests — one RemoteLink tailing topicprobe.p0 into a
 * TopicProbeView, on the canonical backbone. EventSource is faked; we drive a
 * `msg` probe frame through it and assert it routes link → view (accumulated as
 * a per-offsetlog_dir rate/backlog series), and that the mode selects the seek.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import { Node } from '../../../runtime/node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	TIMESTAMP,
	VALUE,
	TM_STRUCT,
} from '../../../runtime/message';
import {
	SOURCE,
	READER,
	CURSOR_SEG,
	CURSOR_OFF,
	END_SEG,
	END_SIZE,
	DISTANCE,
	MSGS,
	END_BYTES,
} from '../../../runtime/probe-record';

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
		this.closed = false;
		FakeEventSource.last = this;
		FakeEventSource.instances.push( this );
	}
	addEventListener( name, cb ) {
		( this.listeners[ name ] ||= [] ).push( cb );
	}
	close() {
		this.closed = true;
	}
	dispatch( name, data ) {
		( this.listeners[ name ] || [] ).forEach( ( cb ) => cb( { data } ) );
	}
}

beforeEach( () => {
	Core.reset();
	FakeEventSource.last = null;
	FakeEventSource.instances = [];
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

import { useTopicProbeStream } from '../useTopicProbeStream';

const LINK = 'topicprobe:link';
const TEE = 'topicprobe:stream';
const VIEW = 'topicprobe:view';

const fakeClient = () => ( { postBatch: () => Promise.resolve( [] ) } );

// The view node drops probe records older than 24h by wall clock, so `ts` here is
// an OFFSET from a recent epoch base — the synthetic frames must sit in the live
// window or they never accumulate.
const TS_BASE = Math.floor( Date.now() / 1000 ) - 10000;

function probeFrame( {
	ts = 1000,
	reader = 'firehose.p0',
	source = 'firehose.p0',
	distance = 0,
	msgs = 0,
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ FROM ] = 'topicprobe.p0';
	// topicprobe.p0 is a PARTITION, so each replayed record carries the TO the
	// probe stamped server-side (routing it to the partition) — a path that means
	// nothing in the browser. The RemoteLink must re-home it to its target.
	m[ TO ] = 'topicprobe';
	m[ TIMESTAMP ] = TS_BASE + ts;
	const v = [];
	v[ SOURCE ] = source;
	v[ READER ] = reader;
	v[ CURSOR_SEG ] = 0;
	v[ CURSOR_OFF ] = 0;
	v[ END_SEG ] = 0;
	v[ END_SIZE ] = 0;
	v[ DISTANCE ] = distance;
	v[ MSGS ] = msgs;
	v[ END_BYTES ] = msgs;
	m[ VALUE ] = v;
	return m;
}

describe( 'useTopicProbeStream', () => {
	it( 'mounts the backbone + a RemoteLink to topicprobe.p0 + the view', async () => {
		renderHook( () =>
			useTopicProbeStream( {
				mode: 'follow',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		expect( Core.node( '_command_interpreter' ) ).toBeTruthy();
		expect( Core.node( LINK ) ).toBeTruthy();
		expect( Core.node( VIEW ) ).toBeTruthy();
		expect( Core.node( LINK ).sseIn.subscribe ).toEqual( [
			'topicprobe.p0',
		] );
		expect( FakeEventSource.last.url ).toContain(
			'subscribe=topicprobe.p0'
		);
	} );

	it( "mode:'history' seeks from start (positions in the stream URL)", async () => {
		renderHook( () =>
			useTopicProbeStream( {
				mode: 'history',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		expect( FakeEventSource.last.url ).toContain( 'positions=' );
		expect( FakeEventSource.last.url ).toContain(
			encodeURIComponent( JSON.stringify( { 'topicprobe.p0': 'start' } ) )
		);
	} );

	it( "mode:'follow' tail-seeks (no positions param)", async () => {
		renderHook( () =>
			useTopicProbeStream( {
				mode: 'follow',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		expect( FakeEventSource.last.url ).not.toContain( 'positions=' );
	} );

	it( 'inserts an inspectable Tee on the stream edge: link → tee → view', async () => {
		renderHook( () =>
			useTopicProbeStream( {
				mode: 'follow',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		const interpreter = Core.node( '_command_interpreter' );
		const tee = Core.node( TEE );
		expect( tee ).toBeTruthy();
		expect( tee.constructor.name ).toBe( 'TeeNode' );
		expect( tee.sink ).toBe( interpreter );
		// The link re-homes received frames to the Tee, which fans to the view.
		expect( Core.node( LINK ).sseIn.target ).toBe( TEE );
		expect( tee.target ).toEqual( [ VIEW ] );
	} );

	it( 'fans the live probe stream to a debug-overlay watcher without disturbing the view', async () => {
		renderHook( () =>
			useTopicProbeStream( {
				mode: 'follow',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		const watcher = new Node();
		watcher.name = 'watcher';
		const seen = [];
		watcher.fill = ( m ) => seen.push( m[ VALUE ][ SOURCE ] );
		Core.node( TEE ).connectNode( 'watcher' );
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				JSON.stringify(
					probeFrame( { msgs: 1000, distance: 50, ts: 100 } )
				)
			);
		} );
		// The watcher saw the raw probe AND the view accumulated the series.
		expect( seen ).toContain( 'firehose.p0' );
		expect( Core.node( VIEW ).snapshot()[ 'firehose.p0' ] ).toBeTruthy();
	} );

	it( 'routes a probe frame through the link into the view as a rate/backlog series', async () => {
		renderHook( () =>
			useTopicProbeStream( {
				mode: 'follow',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				JSON.stringify(
					probeFrame( { msgs: 1000, distance: 50, ts: 100 } )
				)
			);
			FakeEventSource.last.dispatch(
				'msg',
				JSON.stringify(
					probeFrame( { msgs: 4000, distance: 7800, ts: 103 } )
				)
			);
		} );
		const snap = Core.node( VIEW ).snapshot();
		expect( snap[ 'firehose.p0' ] ).toBeTruthy();
		expect( snap[ 'firehose.p0' ].latest.msgRate ).toBe( 1000 ); // +3000 msgs / 3s
		expect( snap[ 'firehose.p0' ].latest.backlog ).toBe( 7800 );
		expect( snap[ 'firehose.p0' ].source ).toBe( 'firehose.p0' );
	} );

	it( 'reconnects (re-seeking history) after a graph rebuild drops + recreates the link', async () => {
		// A graph-generation bump (Reset Graph, or a co-mounted dashboard's
		// rebuild) tears down + recreates the link. The connect must re-fire on the
		// fresh link — even though page visibility never changed — or the rebuilt
		// link sits unconnected and the panels go empty.
		renderHook( () =>
			useTopicProbeStream( {
				mode: 'history',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		const firstLink = Core.node( LINK );
		const before = FakeEventSource.instances.length;

		await act( async () => {
			Core.bumpGraphGeneration();
		} );

		expect( Core.node( LINK ) ).not.toBe( firstLink ); // rebuilt
		expect( FakeEventSource.instances.length ).toBeGreaterThan( before ); // reconnected
		expect( FakeEventSource.last.url ).toContain(
			encodeURIComponent( JSON.stringify( { 'topicprobe.p0': 'start' } ) )
		); // re-seeks history, not a tail-follow
	} );
} );
