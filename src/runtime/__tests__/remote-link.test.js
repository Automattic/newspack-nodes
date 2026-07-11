/**
 * RemoteLinkNode tests — the full-duplex "be the browser" SSE+HTTP channel base.
 *
 * One node that composes an UNNAMED per-link SseIn (an internal stream — not
 * registered in Core, so it never churns the canvas layout) and SHARES the
 * reserved-name `_http` (HttpOut) + `_heartbeat` (Heartbeat) singletons, plus the
 * `connected → slot` bridge. A dashboard makes ONE RemoteLink; RemoteIpc extends
 * it with the worker-relay send + single-connection steal. Mirrors the PHP
 * Remote_Source patron; the durable offsetlog stays a PHP-only `Remote_Source
 * extends Remote_Link` concern.
 */

import { RemoteLinkNode } from '../remote-link-node';
import { SseInNode } from '../sse-in-node';
import { HttpOutNode } from '../http-out-node';
import { HeartbeatNode } from '../heartbeat-node';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { Core } from '../core';
import { mountExospine } from '../exospine';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	TM_COMMAND,
	TM_INFO,
	TM_BYTESTREAM,
} from '../message';
import names from '../reserved-node-names.json';

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
		this.closed = false;
		FakeEventSource.last = this;
	}
	addEventListener( name, cb ) {
		( this.listeners[ name ] ||= [] ).push( cb );
	}
	close() {
		this.closed = true;
	}
}

beforeEach( () => {
	Core.reset();
	global.EventSource = FakeEventSource;
} );

function makeLink( subscribe = 'raw-logs' ) {
	const { interpreter } = mountExospine();
	const posted = [];
	const link = new RemoteLinkNode();
	link.name = 'dash:link';
	link.sink = interpreter;
	link.target = 'dash:view';
	link.client = {
		postBatch: ( messages ) => {
			posted.push( ...messages );
			return Promise.resolve( [] );
		},
	};
	link.arguments = `${ subscribe } /wp-json/ NONCE`;
	return { link, posted };
}

// SseIn splits the flat `connected` string into sessionPid / sessionSlot.
const connectedRaw = ( { pid = 4242, slot = 3 } = {} ) =>
	`PID ${ pid } SLOT ${ slot } SUBSCRIPTIONS raw-logs INTERVAL 2000`;
function dispatchConnected( link, opts ) {
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] = connectedRaw( opts );
	FakeEventSource.last.listeners.connected[ 0 ]( {
		data: JSON.stringify( m ),
	} );
}

describe( 'RemoteLinkNode', () => {
	it( 'composes an UNNAMED SseIn + the shared `_http`/`_heartbeat` singletons on connect', () => {
		const { link } = makeLink();
		link.connect();
		// SseIn is internal — held, but NOT registered (no canvas churn).
		expect( link.sseIn ).toBeInstanceOf( SseInNode );
		expect( Core.node( 'dash:link:sse-in' ) ).toBe( null );
		// HttpOut + Heartbeat are shared reserved-name singletons.
		expect( Core.node( names.HTTP ) ).toBeInstanceOf( HttpOutNode );
		expect( Core.node( names.HEARTBEAT ) ).toBeInstanceOf( HeartbeatNode );
		expect( link.httpOut ).toBe( Core.node( names.HTTP ) );
		expect( link.heartbeat ).toBe( Core.node( names.HEARTBEAT ) );
	} );

	it( 'never arms the shared heartbeat itself: the slot lifecycle does (setSlot arms, close stops)', () => {
		const { link } = makeLink();
		link.connect();
		const hb = Core.node( names.HEARTBEAT );
		expect( hb.mode ).toBe( 'inactive' );
		dispatchConnected( link, { slot: 3 } );
		expect( hb.slot ).toBe( 3 );
		expect( hb.mode ).toBe( 'router' );
		link.close();
		expect( hb.slot ).toBeNull();
		expect( hb.mode ).toBe( 'inactive' );
	} );

	it( 'surfaces its anonymous SseIn read tally but NOT the shared HttpOut writes (avoids double-count)', () => {
		const { link } = makeLink();
		link.connect();
		link.sseIn.bytesRead = 500;
		link.sseIn.largestMsgSent = 120;
		link.httpOut.bytesWritten = 80;
		// SseIn is unlisted, so the link surfaces its reads (else uncounted).
		expect( link.bytesRead ).toBe( 500 );
		expect( link.largestMsgSent ).toBe( 120 );
		// _http is already listed; the link must NOT re-surface its writes.
		expect( link.bytesWritten ).toBe( 0 );
	} );

	it( 'connectNode points BOTH the link target and its already-built SseIn', () => {
		const { link } = makeLink();
		link.connect();
		expect( link.sseIn ).toBeInstanceOf( SseInNode );
		link.connectNode( 'new:view' );
		expect( link.target ).toBe( 'new:view' );
		expect( link.sseIn.target ).toBe( 'new:view' );
	} );

	it( 'connectNode before children exist seeds the SseIn via ensureChildren', () => {
		const { link } = makeLink();
		link.connectNode( 'new:view' );
		expect( link.target ).toBe( 'new:view' );
		expect( link.sseIn ).toBe( null );
		link.connect();
		expect( link.sseIn.target ).toBe( 'new:view' );
	} );

	it( 'resumePositions() exposes the SseIn last-seen offset so a reconnect resumes', () => {
		const { link } = makeLink( 'errors' );
		link.connect();
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ FROM ] = 'errors.p0/request-builder';
		m[ ID ] = '3:99:70';
		m[ VALUE ] = 'a line';
		FakeEventSource.last.listeners.msg[ 0 ]( {
			data: JSON.stringify( m ),
		} );
		expect( link.resumePositions() ).toEqual( {
			'errors.p0': { segment: 3, offset: 99 + 70 },
		} );
	} );

	it( 'lastEventTime() passes through the composed SseIn freshness clock (null before connect)', () => {
		const { link } = makeLink( 'errors' );
		expect( link.lastEventTime() ).toBeNull(); // no SseIn composed yet
		link.connect();
		link.sseIn.lastEventTime = 1717000000000;
		expect( link.lastEventTime() ).toBe( 1717000000000 );
	} );

	it( 'subscribes its SseIn to the configured topic, forwarding to the link sink/target', () => {
		const { link } = makeLink( 'errors' );
		link.connect();
		expect( link.sseIn.subscribe ).toEqual( [ 'errors' ] );
		expect( link.sseIn.sink ).toBe( link.sink );
		expect( link.sseIn.target ).toBe( 'dash:view' );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=errors' );
	} );

	it( 'connect() with no positions leaves the SseIn tailing (positions null)', () => {
		const { link } = makeLink();
		link.connect();
		expect( link.sseIn.positions ).toBeNull();
		expect( FakeEventSource.last.url ).not.toContain( 'positions=' );
	} );

	it( 'connect(positions) threads the seek seed into the SseIn stream URL', () => {
		const { link } = makeLink( 'topicprobe.p0' );
		link.connect( { 'topicprobe.p0': 'start' } );
		expect( link.sseIn.positions ).toEqual( {
			'topicprobe.p0': 'start',
		} );
		expect( FakeEventSource.last.url ).toContain( 'positions=' );
	} );

	it( 'setSubscribe(subscribe, positions) re-points the stream with a new seek seed', () => {
		const { link } = makeLink( 'topicprobe.p0' );
		link.connect( { 'topicprobe.p0': 'start' } );
		link.setSubscribe( [ 'topicprobe.p0' ], {
			'topicprobe.p0': 'end',
		} );
		expect( link.sseIn.positions ).toEqual( {
			'topicprobe.p0': 'end',
		} );
	} );

	it( 'setSubscribe(subscribe) without positions clears the seed (tail-seek)', () => {
		const { link } = makeLink( 'topicprobe.p0' );
		link.connect( { 'topicprobe.p0': 'start' } );
		link.setSubscribe( [ 'errors' ] );
		expect( link.sseIn.positions ).toBeNull();
	} );

	it( 'points the shared Heartbeat at the workers CI via the shared `_http`', () => {
		const { link } = makeLink();
		link.connect();
		expect( Core.node( names.HEARTBEAT ).target ).toBe(
			`${ names.HTTP }/workers`
		);
	} );

	it( 'bridges the SseIn connected slot into the shared Heartbeat', () => {
		const { link } = makeLink();
		link.connect();
		dispatchConnected( link, { pid: 7, slot: 3 } );
		expect( Core.node( names.HEARTBEAT ).slot ).toBe( 3 );
	} );

	it( 'delegates pid() to its composed SseIn', () => {
		const { link } = makeLink();
		link.connect();
		dispatchConnected( link, { pid: 4242, slot: 0 } );
		expect( link.pid() ).toBe( 4242 );
	} );

	it( 'routes send() out through the shared `_http` with the address intact', () => {
		const { link, posted } = makeLink();
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = 'dash:view';
		m[ TO ] = 'raw-logs';
		m[ VALUE ] = { name: 'list_logs', arguments: '' };
		link.send( m );
		expect( posted ).toHaveLength( 1 );
		expect( posted[ 0 ][ TO ] ).toBe( 'raw-logs' );
		expect( posted[ 0 ][ FROM ] ).toBe( 'dash:view' );
		expect( posted[ 0 ][ VALUE ] ).toEqual( {
			name: 'list_logs',
			arguments: '',
		} );
	} );

	it( 'is registered at the runtime level so dashboards resolve it via make_node', () => {
		expect( CommandInterpreterNode.includeNodes.RemoteLink ).toBe(
			RemoteLinkNode
		);
	} );

	it( 'clears the Heartbeat slot + closes the stream on close', () => {
		const { link } = makeLink();
		link.connect();
		const hb = Core.node( names.HEARTBEAT );
		hb.setSlot( 5 );
		link.close();
		expect( hb.slot ).toBe( null );
		expect( FakeEventSource.last.closed ).toBe( true );
	} );

	it( 'pid() is null before connect (no SseIn yet)', () => {
		const { link } = makeLink();
		expect( link.pid() ).toBe( null );
	} );

	it( 'ensureChildren is idempotent — a second connect reuses the SseIn', () => {
		const { link } = makeLink();
		link.connect();
		const sse = link.sseIn;
		link.connect();
		expect( link.sseIn ).toBe( sse );
	} );

	it( 'removeNode tears down the SseIn but leaves the backbone _http/_heartbeat', () => {
		const { link } = makeLink();
		link.connect();
		link.removeNode();
		expect( link.sseIn ).toBe( null );
		// _http/_heartbeat are backbone singletons; the link leaves them.
		expect( Core.node( names.HTTP ) ).not.toBe( null );
		expect( Core.node( names.HEARTBEAT ) ).not.toBe( null );
	} );

	it( 'removeNode closes the live EventSource (teardown is self-sufficient)', () => {
		const { link } = makeLink();
		link.connect();
		const es = FakeEventSource.last;
		link.removeNode();
		expect( es.closed ).toBe( true );
	} );

	it( 'fires the optional onClose hook once when the link closes', () => {
		const { link } = makeLink();
		let calls = 0;
		link.onClose = () => {
			calls += 1;
		};
		link.connect();
		link.close();
		expect( calls ).toBe( 1 );
	} );

	it( 'fires the optional onConnected hook with the connected payload', () => {
		const { link } = makeLink();
		const seen = [];
		link.onConnected = ( payload ) => seen.push( payload );
		link.connect();
		dispatchConnected( link, { pid: 4242, slot: 3 } );
		// Bridge fires the hook with the CONNECTED payload (raw envelope).
		expect( seen ).toEqual( [ connectedRaw( { pid: 4242, slot: 3 } ) ] );
	} );

	it( 'dumpNode filters out its internal sub-node refs (sseIn/httpOut/heartbeat)', () => {
		// RemoteLink composes 3 nodes; dumpNode masks them, not serialized.
		const { link } = makeLink();
		link.connect(); // wires sseIn + the shared _http/_heartbeat singletons.

		const snap = link.dumpNode();

		expect( snap.sseIn ).toBe( '{...}' );
		expect( snap.httpOut ).toBe( '{...}' );
		expect( snap.heartbeat ).toBe( '{...}' );
		expect( () => JSON.stringify( snap ) ).not.toThrow();
	} );
} );
