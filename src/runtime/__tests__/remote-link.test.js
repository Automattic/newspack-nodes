/**
 * RemoteLinkNode tests — the full-duplex "be the browser" SSE+HTTP channel base.
 *
 * One node that composes a per-link `<name>:sse-in` (registered so `trace` can
 * reach it, patron-owned so the canvas skips it) and SHARES the
 * reserved-name `_http` (HttpOut) + `_heartbeat` (Heartbeat) singletons, plus the
 * `connected → slot` bridge. A dashboard makes ONE RemoteLink; RemoteIpc extends
 * it with the worker-relay send + single-connection steal. Mirrors the PHP
 * Remote_Source patron; the durable offsetlog stays a PHP-only `Remote_Source
 * extends Remote_Link` concern.
 */

import { RemoteLinkNode } from '../remote-link-node';
import { SseInNode, SEEK_END } from '../sse-in-node';
import { HttpOutNode } from '../http-out-node';
import { HeartbeatNode } from '../heartbeat-node';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { dumpMetadataPayload } from '../metadata-node';
import { NodeRegistry } from '../node-registry';
import { RouterNode } from '../router-node';
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
	FakeEventSource.last = null;
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
	link.arguments = [ subscribe ];
	return { link, posted };
}

// Deliberately exceeds Number.MAX_SAFE_INTEGER: lease owners stay strings.
const LEASE_OWNER = '9007199254740995';
const connectedRaw = ( { pid = 4242, slot = 3, owner = LEASE_OWNER } = {} ) =>
	`PID ${ pid } SLOT ${ slot } OWNER ${ owner } ` +
	'SUBSCRIPTIONS raw-logs INTERVAL 2000';
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
	it( 'composes a patron-owned `<name>:sse-in` + the shared `_http`/`_heartbeat` singletons on connect', () => {
		const { link } = makeLink();
		link.connect();
		// Registered so `trace` can reach it; patron keeps it off the canvas.
		expect( link.sseIn ).toBeInstanceOf( SseInNode );
		expect( Core.node( 'dash:link:sse-in' ) ).toBe( link.sseIn );
		expect( link.sseIn.patron ).toBe( link );
		expect( dumpMetadataPayload() ).not.toHaveProperty(
			'dash:link:sse-in'
		);
		// HttpOut + Heartbeat are shared reserved-name singletons.
		expect( Core.node( names.HTTP ) ).toBeInstanceOf( HttpOutNode );
		expect( Core.node( names.HEARTBEAT ) ).toBeInstanceOf( HeartbeatNode );
		expect( link.heartbeat ).toBe( Core.node( names.HEARTBEAT ) );
	} );

	it( 'names the child in the PATRON’s table, so a draft graph keeps it out of Core', () => {
		const { interpreter } = mountExospine();
		const drafts = new NodeRegistry();
		// Every real graph has a backbone; the child hitchhikes its router.
		const router = new RouterNode();
		router.registry = drafts;
		router.name = names.ROUTER;
		const link = new RemoteLinkNode();
		link.registry = drafts; // Before the name — the setter enforces it.
		link.name = 'draft:link';
		link.sink = interpreter;
		link.arguments = [ 'raw-logs' ];

		link.connect();

		// Named into Core instead, a second graph collides on the same name.
		expect( drafts.node( 'draft:link:sse-in' ) ).toBe( link.sseIn );
		expect( Core.registry.node( 'draft:link:sse-in' ) ).toBe( null );
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

	it( 'surfaces its own SseIn read tally but NOT the shared HttpOut writes (avoids double-count)', () => {
		const { link } = makeLink();
		link.connect();
		link.sseIn.bytesRead = 500;
		link.sseIn.largestMsgSent = 120;
		Core.node( names.HTTP ).bytesWritten = 80;
		// SseIn is off the canvas, so the link surfaces its reads.
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

	it( 'connectNode before children exist starts the SseIn with its target', () => {
		const { link } = makeLink();
		link.connectNode( 'new:view' );
		expect( link.target ).toBe( 'new:view' );
		expect( link.sseIn ).toBeInstanceOf( SseInNode );
		expect( link.sseIn.target ).toBe( 'new:view' );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=raw-logs' );
	} );

	it( 'a palette make + edge opens the configured subscription and dumpConfig replay reopens it', () => {
		window.NewspackNodesData = {
			restUrl: 'https://palette.example/wp-json/',
			nonce: 'INDIGO-NONCE-863',
		};
		try {
			const { interpreter } = mountExospine();
			interpreter.dispatch( 'make_node', [
				'RemoteLink',
				'violet-link-947',
				'gyroscope.p7',
			] );
			interpreter.dispatch( 'connect_node', [
				'violet-link-947',
				'indigo-view-863',
			] );

			const first = Core.node( 'violet-link-947' );
			expect( first.sseIn ).toBeInstanceOf( SseInNode );
			expect( first.sseIn.target ).toBe( 'indigo-view-863' );
			expect( FakeEventSource.last.url ).toContain(
				'subscribe=gyroscope.p7'
			);
			const config = first.dumpConfig();
			expect( config ).toBe(
				'make_node RemoteLink violet-link-947 gyroscope.p7\n' +
					'connect_node violet-link-947 indigo-view-863\n'
			);

			const firstStream = FakeEventSource.last;
			first.removeNode();
			for ( const line of config.trim().split( '\n' ) ) {
				const [ verb, ...args ] = line.split( ' ' );
				interpreter.dispatch( verb, args );
			}

			const reopened = Core.node( 'violet-link-947' );
			expect( reopened ).not.toBe( first );
			expect( reopened.arguments ).toEqual( [ 'gyroscope.p7' ] );
			expect( reopened.target ).toBe( 'indigo-view-863' );
			expect( FakeEventSource.last ).not.toBe( firstStream );
			expect( FakeEventSource.last.url ).toContain(
				'subscribe=gyroscope.p7'
			);
		} finally {
			delete window.NewspackNodesData;
		}
	} );

	it( 'disconnecting the canvas edge closes the palette-started stream', () => {
		const { link } = makeLink( 'completed.p11' );
		link.connectNode( 'cerulean-view-619' );
		const stream = FakeEventSource.last;

		link.disconnectNode( 'cerulean-view-619' );

		expect( link.target ).toBe( '' );
		expect( link.sseIn.target ).toBe( '' );
		expect( stream.closed ).toBe( true );
	} );

	it( 'fails make_node when the required subscription is missing', () => {
		const { interpreter } = mountExospine();
		expect( () =>
			interpreter.makeNode( 'RemoteLink', 'empty-link-439' )
		).toThrow( 'Missing required argument: subscribe' );
		expect( Core.node( 'empty-link-439' ) ).toBeNull();
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

	it( 'subscribes its SseIn to the configured topic, forwarding to the link sink/target', () => {
		const { link } = makeLink( 'errors' );
		link.connect();
		expect( link.sseIn.subscribe ).toEqual( [ 'errors' ] );
		expect( link.sseIn.sink ).toBe( link.sink );
		expect( link.sseIn.target ).toBe( 'dash:view' );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=errors' );
	} );

	it( 'connect() with no positions asks the SseIn to tail', () => {
		const { link } = makeLink();
		link.connect();
		expect( link.sseIn.positions ).toBeNull();
		// No seed of its own, so the seek it names is the tail sentinel.
		expect( link.sseIn.seekMap() ).toEqual( { 'raw-logs': SEEK_END } );
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

	it( 'routes the SseIn at an overridden endpoint (e.g. /log/stream) when endpoint is set', () => {
		const { link } = makeLink( 'php' );
		link.endpoint = 'newspack-nodes/v1/log/stream';
		link.connect();
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/log/stream?subscribe=php'
		);
		expect( FakeEventSource.last.url ).not.toContain( 'messages/stream' );
	} );

	it( 'defaults the SseIn to the messages/stream endpoint when endpoint is unset', () => {
		const { link } = makeLink( 'errors' );
		link.connect();
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/messages/stream?subscribe=errors'
		);
	} );

	it( 'points the shared Heartbeat at the workers CI via the shared `_http`', () => {
		const { link } = makeLink();
		link.connect();
		expect( Core.node( names.HEARTBEAT ).target ).toBe(
			`${ names.HTTP }/workers`
		);
	} );

	it( 'bridges the exact SseIn slot + lease owner into the shared Heartbeat', () => {
		const { link } = makeLink();
		link.connect();
		dispatchConnected( link, {
			pid: 7,
			slot: 3,
			owner: LEASE_OWNER,
		} );
		const heartbeat = Core.node( names.HEARTBEAT );
		expect( heartbeat.slot ).toBe( 3 );
		expect( heartbeat.leaseOwner ).toBe( LEASE_OWNER );
	} );

	it( 'does not arm the Heartbeat when the connected owner is missing', () => {
		const warn = jest
			.spyOn( Core, 'printLessOften' )
			.mockImplementation( () => {} );
		const { link } = makeLink();
		link.connect();
		const m = newMessage();
		m[ TYPE ] = TM_INFO;
		m[ KEY ] = 'connected';
		m[ VALUE ] = 'PID 7007 SLOT 7 SUBSCRIPTIONS raw-logs INTERVAL 2000';

		FakeEventSource.last.listeners.connected[ 0 ]( {
			data: JSON.stringify( m ),
		} );

		const heartbeat = Core.node( names.HEARTBEAT );
		expect( heartbeat.slot ).toBeNull();
		expect( heartbeat.leaseOwner ).toBeNull();
		expect( warn ).toHaveBeenCalledWith(
			'ERROR: SseInNode: connected envelope missing or invalid OWNER'
		);
		warn.mockRestore();
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
		m[ VALUE ] = { name: 'list_logs', arguments: [] };
		link.send( m );
		expect( posted ).toHaveLength( 1 );
		expect( posted[ 0 ][ TO ] ).toBe( 'raw-logs' );
		expect( posted[ 0 ][ FROM ] ).toBe( 'dash:view' );
		expect( posted[ 0 ][ VALUE ] ).toEqual( {
			name: 'list_logs',
			arguments: [],
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
		dispatchConnected( link, { pid: 5005, slot: 5 } );
		link.close();
		expect( hb.slot ).toBe( null );
		expect( FakeEventSource.last.closed ).toBe( true );
	} );

	it( 'closing an inactive link preserves the active sibling heartbeat', () => {
		const { link: first } = makeLink( 'completed.p11' );
		first.name = 'inactive-link-349';
		first.connect();
		dispatchConnected( first, { pid: 349, slot: 13 } );

		const { link: active } = makeLink( 'errors.p17' );
		active.name = 'active-link-947';
		active.connect();
		dispatchConnected( active, { pid: 947, slot: 47 } );
		const activeStream = FakeEventSource.last;

		first.close();

		expect( Core.node( names.HEARTBEAT ).slot ).toBe( 47 );
		expect( activeStream.closed ).toBe( false );
	} );

	it( 'closing the latest link restores the earlier live heartbeat slot', () => {
		const { link: first } = makeLink( 'completed.p13' );
		first.name = 'first-link-349';
		first.connect();
		dispatchConnected( first, { pid: 349, slot: 13 } );
		const firstStream = FakeEventSource.last;

		const { link: latest } = makeLink( 'errors.p47' );
		latest.name = 'latest-link-947';
		latest.connect();
		dispatchConnected( latest, { pid: 947, slot: 47 } );

		latest.close();

		expect( Core.node( names.HEARTBEAT ).slot ).toBe( 13 );
		expect( firstStream.closed ).toBe( false );
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
		// The CONNECTED payload, which carries no lease owner.
		expect( seen ).toEqual( [ 'PID 4242 SLOT 3' ] );
	} );

	it( 'defaults the shared `_http` client from the localized global when none is injected and args carry no baseUrl/nonce', () => {
		window.NewspackNodesData = {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'GLOBALNONCE',
		};
		try {
			const { interpreter } = mountExospine();
			const link = new RemoteLinkNode();
			link.name = 'dash:link';
			link.sink = interpreter;
			// subscribe only — no baseUrl/nonce tokens, no injected client.
			link.arguments = [ 'raw-logs' ];
			link.connect();
			const http = Core.node( names.HTTP );
			// The transport closes over the base + nonce; a POST shows them.
			expect( typeof http.client.postBatch ).toBe( 'function' );
		} finally {
			delete window.NewspackNodesData;
		}
	} );

	it( 'dumpNode filters out its internal sub-node refs (sseIn/heartbeat)', () => {
		// RemoteLink composes 3 nodes; dumpNode masks them, not serialized.
		const { link } = makeLink();
		link.connect(); // wires sseIn + the shared _http/_heartbeat singletons.

		const snap = link.dumpNode();

		expect( snap.sseIn ).toBe( '{...}' );
		expect( snap.heartbeat ).toBe( '{...}' );
		expect( () => JSON.stringify( snap ) ).not.toThrow();
	} );
} );
