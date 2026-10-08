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
import { Node } from '../node';
import { SseInNode, SEEK_END, SEEK_START } from '../sse-in-node';
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
		// As a real one: CONNECTING until a frame arrives.
		this.readyState = FakeEventSource.CONNECTING;
		FakeEventSource.last = this;
		FakeEventSource.opened++;
	}
	addEventListener( name, cb ) {
		( this.listeners[ name ] ||= [] ).push( cb );
	}
	close() {
		this.closed = true;
		this.readyState = FakeEventSource.CLOSED;
	}
	dispatch( name, data ) {
		if ( 'error' !== name ) {
			this.readyState = FakeEventSource.OPEN;
		}
		( this.listeners[ name ] || [] ).forEach( ( cb ) => cb( { data } ) );
	}
}
FakeEventSource.CONNECTING = 0;
FakeEventSource.OPEN = 1;
FakeEventSource.CLOSED = 2;

beforeEach( () => {
	Core.reset();
	global.EventSource = FakeEventSource;
	FakeEventSource.last = null;
	FakeEventSource.opened = 0;
} );

function makeLink( subscribe = 'raw-logs' ) {
	const { interpreter } = mountExospine();
	const posted = [];
	const link = new RemoteLinkNode();
	link.name = 'dash-link';
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
// The handle jest.setup.js issues every test's command session under.
const HARNESS_SESSION = 'e2e11111e2e22222e2e33333e2e44444';
const connectedRaw = ( { slot = 3, owner = LEASE_OWNER } = {} ) =>
	`SESSION ${ HARNESS_SESSION } SLOT ${ slot } OWNER ${ owner } ` +
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
		expect( Core.node( 'dash-link:sse-in' ) ).toBe( link.sseIn );
		expect( link.sseIn.patron ).toBe( link );
		expect( dumpMetadataPayload() ).not.toHaveProperty(
			'dash-link:sse-in'
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
		link.name = 'draft-link';
		link.sink = interpreter;
		link.arguments = [ 'raw-logs' ];

		link.connect();

		// Named into Core instead, a second graph collides on the same name.
		expect( drafts.node( 'draft-link:sse-in' ) ).toBe( link.sseIn );
		expect( Core.registry.node( 'draft-link:sse-in' ) ).toBe( null );
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

	it( 'connectNode during a scheduled reopen waits it out', () => {
		jest.useFakeTimers();
		try {
			const { link } = makeLink( 'quartz.p4' );
			link.connect();
			FakeEventSource.last.dispatch( 'error' );
			link.connectNode( 'ochre-3307:view' );
			expect( FakeEventSource.opened ).toBe( 1 );
			expect( link.sseIn.target ).toBe( 'ochre-3307:view' );
			jest.advanceTimersByTime( 2000 );
			expect( FakeEventSource.opened ).toBe( 2 );
			link.removeNode();
		} finally {
			jest.useRealTimers();
		}
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

	// A subscription CHOSEN later is a real flow (a dashboard whose catalog
	// picks one), so the link builds bare and refuses at the point of use —
	// which is the refusal that cannot be talked around with a placeholder.
	it( 'builds with no subscription and refuses to open until it has one', () => {
		const { interpreter } = mountExospine();
		const link = interpreter.makeNode( 'RemoteLink', 'empty-link-439' );
		expect( link.arguments ).toEqual( [] );
		expect( () => link.connect() ).toThrow(
			'RemoteLink requires an SSE subscription'
		);
		expect( link.sseIn ).toBeNull();
	} );

	it( 'a graph attaching supplies it, and `arguments` then reports it', async () => {
		const { interpreter } = mountExospine();
		const link = interpreter.makeNode( 'RemoteLink', 'late-link-812' );
		link.attach( [ 'quartz.p7' ], 'grebe:stream' );
		await Promise.resolve();
		expect( link.arguments ).toEqual( [ 'quartz.p7' ] );
		expect( link.sseIn.subscribe ).toEqual( [ 'quartz.p7' ] );
	} );

	// `arguments` is what dump_config re-emits, so a link that reports the
	// token it was BUILT with saves a graph replaying the log the dashboard
	// opened on rather than the one it was showing.
	it( 're-pointing a configured link updates what it reports', async () => {
		const { interpreter } = mountExospine();
		const link = interpreter.makeNode( 'RemoteLink', 'moved-link-903', [
			'gyroscope.p7',
		] );
		link.connect();
		link.attach( [ 'quartz.p3' ], 'grebe:stream' );
		await Promise.resolve();
		expect( link.arguments ).toEqual( [ 'quartz.p3' ] );
		expect( link.sseIn.arguments ).toEqual( [ 'quartz.p3' ] );
		expect( link.dumpConfig() ).toContain(
			'make_node RemoteLink moved-link-903 quartz.p3'
		);
	} );

	it( 'has no per-graph re-point methods; graphs attach instead', () => {
		const { link } = makeLink( 'kea.p4' );
		expect( link.setSubscribe ).toBeUndefined();
		expect( link.reconnect ).toBeUndefined();
		link.connect();
		expect( FakeEventSource.last.url ).toContain( 'subscribe=kea.p4' );
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
		// No seed of its own, so the seek it names is the tail sentinel.
		expect( link.sseIn.seekMap() ).toEqual( { 'raw-logs': SEEK_END } );
	} );

	it( 'opens every stream on /messages/stream; no link carries an endpoint', () => {
		const { link } = makeLink( 'sources/php' );
		link.connect();
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/messages/stream?subscribe=sources%2Fphp'
		);
		expect( 'endpoint' in link ).toBe( false );
		expect( 'endpoint' in link.sseIn ).toBe( false );
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
		m[
			VALUE
		] = `SESSION ${ HARNESS_SESSION } SLOT 7 SUBSCRIPTIONS raw-logs INTERVAL 2000`;

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

	it( 'delegates session() to its composed SseIn', () => {
		const { link } = makeLink();
		link.connect();
		dispatchConnected( link, { slot: 0 } );
		expect( link.session() ).toBe( HARNESS_SESSION );
		expect( link.pid ).toBeUndefined();
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
		dispatchConnected( link, { slot: 5 } );
		link.close();
		expect( hb.slot ).toBe( null );
		expect( FakeEventSource.last.closed ).toBe( true );
	} );

	it( 'closing an inactive link preserves the active sibling heartbeat', () => {
		const { link: first } = makeLink( 'completed.p11' );
		first.name = 'inactive-link-349';
		first.connect();
		dispatchConnected( first, { slot: 13 } );

		const { link: active } = makeLink( 'errors.p17' );
		active.name = 'active-link-947';
		active.connect();
		dispatchConnected( active, { slot: 47 } );
		const activeStream = FakeEventSource.last;

		first.close();

		expect( Core.node( names.HEARTBEAT ).slot ).toBe( 47 );
		expect( activeStream.closed ).toBe( false );
	} );

	it( 'closing the latest link restores the earlier live heartbeat slot', () => {
		const { link: first } = makeLink( 'completed.p13' );
		first.name = 'first-link-349';
		first.connect();
		dispatchConnected( first, { slot: 13 } );
		const firstStream = FakeEventSource.last;

		const { link: latest } = makeLink( 'errors.p47' );
		latest.name = 'latest-link-947';
		latest.connect();
		dispatchConnected( latest, { slot: 47 } );

		latest.close();

		expect( Core.node( names.HEARTBEAT ).slot ).toBe( 13 );
		expect( firstStream.closed ).toBe( false );
	} );

	it( 'session() is null before connect (no SseIn yet)', () => {
		const { link } = makeLink();
		expect( link.session() ).toBe( null );
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
		dispatchConnected( link, { slot: 3 } );
		// The CONNECTED payload, which carries no lease owner.
		expect( seen ).toEqual( [ 'SLOT 3' ] );
	} );

	it( 'defaults the shared `_http` client from the localized global when none is injected and args carry no baseUrl/nonce', () => {
		window.NewspackNodesData = {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'GLOBALNONCE',
		};
		try {
			const { interpreter } = mountExospine();
			const link = new RemoteLinkNode();
			link.name = 'dash-link';
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

describe( 'riders — one link carrying several graphs', () => {
	const flush = () => Promise.resolve();
	const record = ( from, id ) => {
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ FROM ] = from;
		m[ ID ] = id;
		m[ VALUE ] = `${ from } ${ id }\n`;
		return JSON.stringify( m );
	};
	const seeksOf = ( url ) =>
		JSON.parse( decodeURIComponent( url.split( 'positions=' )[ 1 ] ) );
	// The page's own link, as every stream graph on it rides.
	function makeShared() {
		const { stream: link } = mountExospine();
		const delivered = {};
		for ( const name of [
			'jobs:stream',
			'backlog:stream',
			'glob:stream',
		] ) {
			const n = new Node();
			n.name = name;
			n.fill = ( m ) => ( delivered[ name ] ||= [] ).push( m );
		}
		return { link, delivered };
	}

	it( 'opens ONE stream for every graph attached in one tick', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream', {
			'jobstats.p0': SEEK_START,
		} );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream', {
			'topicprobe.p0': SEEK_START,
		} );
		link.attach( [ 'errors.*' ], 'glob:stream' );
		expect( FakeEventSource.last ).toBeNull();
		await flush();
		expect( FakeEventSource.opened ).toBe( 1 );
		const url = FakeEventSource.last.url;
		expect( url ).toContain(
			`subscribe=${ encodeURIComponent(
				'errors.*,jobstats.p0,topicprobe.p0'
			) }`
		);
		expect( seeksOf( url ) ).toEqual( {
			'jobstats.p0': SEEK_START,
			'topicprobe.p0': SEEK_START,
		} );
	} );

	it( 'routes each record by stamp to the graph that carries it', async () => {
		const { link, delivered } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/job-worker.p1/jobstats', '3:0:40' )
		);
		FakeEventSource.last.dispatch(
			'msg',
			record( 'topicprobe.p0/job-worker.p1/topicprobe', '8:0:30' )
		);
		expect( delivered[ 'jobs:stream' ].map( ( m ) => m[ ID ] ) ).toEqual( [
			'3:0:40',
		] );
		expect( delivered[ 'backlog:stream' ].map( ( m ) => m[ ID ] ) ).toEqual(
			[ '8:0:30' ]
		);
	} );

	it( 'two graphs on one stamp with no seed both get each record once', async () => {
		const { link, delivered } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'jobstats.p0' ], 'backlog:stream' );
		await flush();
		expect( FakeEventSource.last.url ).toContain(
			'subscribe=jobstats.p0&'
		);
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0', '3:0:40' )
		);
		expect( delivered[ 'jobs:stream' ] ).toHaveLength( 1 );
		expect( delivered[ 'backlog:stream' ] ).toHaveLength( 1 );
	} );

	it( 'a glob graph and an exact graph overlapping both get the shared stamp', async () => {
		const { link, delivered } = makeShared();
		link.attach( [ 'errors.*' ], 'glob:stream' );
		link.attach( [ 'errors.p3' ], 'jobs:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'errors.p3/x', '1:0:9' )
		);
		FakeEventSource.last.dispatch(
			'msg',
			record( 'errors.p5/x', '2:0:9' )
		);
		expect( delivered[ 'glob:stream' ].map( ( m ) => m[ ID ] ) ).toEqual( [
			'1:0:9',
			'2:0:9',
		] );
		expect( delivered[ 'jobs:stream' ].map( ( m ) => m[ ID ] ) ).toEqual( [
			'1:0:9',
		] );
	} );

	it( 'hands a line opening with no stamp to every graph riding', async () => {
		const { link, delivered } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch( 'msg', record( '', '4:0:12' ) );
		for ( const target of [ 'jobs:stream', 'backlog:stream' ] ) {
			expect( delivered[ target ].map( ( m ) => m[ ID ] ) ).toEqual( [
				'4:0:12',
			] );
		}
	} );

	it( 'reads a `_stream` FROM as a stamp, which no graph carries', async () => {
		expectConsoleWarn( '_stream:sse-in: WARNING: no route for _stream' );
		const { link, delivered } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch( 'msg', record( '_stream', '5:0:12' ) );
		expect( delivered ).toEqual( {} );
	} );

	it( 'drops a stamped line no graph carries, saying so', async () => {
		expectConsoleWarn( '_stream:sse-in: WARNING: no route for kea.p7' );
		const { link, delivered } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		FakeEventSource.last.dispatch( 'msg', record( 'kea.p7/x', '6:0:3' ) );
		expect( delivered ).toEqual( {} );
	} );

	it( 'refuses a seek on a stamp another graph is streaming, naming both', () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.*' ], 'jobs:stream' );
		expect( () =>
			link.attach( [ 'jobstats.p0' ], 'backlog:stream', {
				'jobstats.p0': SEEK_START,
			} )
		).toThrow(
			'RemoteLink: backlog:stream cannot seek jobstats.p0, which jobs:stream is streaming'
		);
		expect( link.graphs.has( 'backlog:stream' ) ).toBe( false );
	} );

	it( 'detach during CONNECTING reopens once, without the detached graph', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		const connecting = FakeEventSource.last;
		expect( connecting.readyState ).toBe( FakeEventSource.CONNECTING );
		link.detach( 'backlog:stream' );
		await flush();
		expect( connecting.closed ).toBe( true );
		expect( FakeEventSource.opened ).toBe( 2 );
		expect( FakeEventSource.last.url ).toContain(
			'subscribe=jobstats.p0&'
		);
		expect( link.sseIn.setStateCache.RECONNECTING ).toBeUndefined();
	} );

	it( 'a re-attach that changes nothing keeps the open stream', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		const open = FakeEventSource.last;
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 1 );
		expect( open.closed ).toBe( false );
	} );

	it( 'a re-attach that changes nothing waits out a scheduled reopen', async () => {
		jest.useFakeTimers( { doNotFake: [ 'queueMicrotask' ] } );
		try {
			const { link } = makeShared();
			link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
			await flush();
			const refused = FakeEventSource.last;
			// The server closed it; the stream owns the reopen and backs off.
			refused.dispatch( 'error' );
			expect( refused.closed ).toBe( true );
			link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
			await flush();
			expect( FakeEventSource.opened ).toBe( 1 );
			jest.advanceTimersByTime( 2000 );
			expect( FakeEventSource.opened ).toBe( 2 );
			link.removeNode();
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'a re-attach in the same tick keeps the seek it has not stated yet', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream', {
			'jobstats.p0': { segment: 6, offset: 14 },
		} );
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': { segment: 6, offset: 14 },
		} );
	} );

	it( 'a re-attach under a new subscription reopens on it', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		link.attach( [ 'tablestats.p0' ], 'jobs:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 2 );
		expect( FakeEventSource.last.url ).toContain(
			'subscribe=tablestats.p0&'
		);
		expect( link.arguments ).toEqual( [ 'tablestats.p0' ] );
	} );

	it( 'a null seek tails that graph’s dirs while the others resume', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:120:40' )
		);
		FakeEventSource.last.dispatch(
			'msg',
			record( 'topicprobe.p0/x', '8:600:30' )
		);
		link.attach( [ 'jobstats.p0' ], 'jobs:stream', null );
		await flush();
		expect( FakeEventSource.opened ).toBe( 2 );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': SEEK_END,
			'topicprobe.p0': { segment: 8, offset: 630 },
		} );
	} );

	it( 'a graph detaching takes its seed along, so a later one tails', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream', {
			'jobstats.p0': SEEK_START,
		} );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		link.detach( 'jobs:stream' );
		link.attach( [ 'jobstats.p0' ], 'glob:stream' );
		await flush();
		// A replay the leaver asked for must not run on into the later graph.
		expect( FakeEventSource.opened ).toBe( 2 );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': SEEK_END,
			'topicprobe.p0': SEEK_END,
		} );
	} );

	it( 'a seek attached and detached in one tick is never asked for', async () => {
		const { link } = makeShared();
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		link.attach( [ 'jobstats.p0' ], 'jobs:stream', {
			'jobstats.p0': SEEK_START,
		} );
		link.detach( 'jobs:stream' );
		link.attach( [ 'jobstats.p0' ], 'glob:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 1 );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'topicprobe.p0': SEEK_END,
			'jobstats.p0': SEEK_END,
		} );
	} );

	it( 'the last detach closes the stream and its heartbeat lease', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		dispatchConnected( link, { slot: 6 } );
		const hb = Core.node( names.HEARTBEAT );
		expect( hb.slot ).toBe( 6 );
		const open = FakeEventSource.last;
		link.detach( 'jobs:stream' );
		await flush();
		expect( open.closed ).toBe( true );
		expect( hb.slot ).toBeNull();
		expect( link.graphs.size ).toBe( 0 );
		expect( FakeEventSource.opened ).toBe( 1 );
	} );

	const skipped = ( value ) => {
		const frame = newMessage();
		frame[ TYPE ] = TM_INFO;
		frame[ KEY ] = 'unparseable_lines';
		frame[ VALUE ] = value;
		FakeEventSource.last.dispatch(
			'unparseable_lines',
			JSON.stringify( frame )
		);
	};

	it( 'publishes each graph’s skipped lines on itself, by target', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		skipped( 'COUNT 11 COUNTS jobstats.p0=4,topicprobe.p0=7' );
		expect( link.unparseableByTarget ).toEqual( {
			'jobs:stream': 4,
			'backlog:stream': 7,
		} );
		expect( link.setStateCache.UNPARSEABLE_LINES ).toBe( 11 );
		for ( const target of [ 'jobs:stream', 'backlog:stream' ] ) {
			expect( Core.node( target ).setStateCache ).toEqual( {} );
		}
	} );

	it( 'a graph re-attached on another subscription takes that one’s share', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		skipped( 'COUNT 9 COUNTS jobstats.p0=4,topicprobe.p0=5' );
		link.attach( [ 'topicprobe.p0' ], 'jobs:stream' );
		await flush();
		expect( link.unparseableByTarget ).toEqual( {
			'jobs:stream': 5,
			'backlog:stream': 5,
		} );
	} );

	it( 'a graph attaching on a stamp already counted takes its share at once', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		skipped( 'COUNT 6 COUNTS jobstats.p0=6' );
		link.attach( [ 'jobstats.*' ], 'glob:stream' );
		await flush();
		expect( link.unparseableByTarget ).toEqual( {
			'jobs:stream': 6,
			'glob:stream': 6,
		} );
	} );

	it( 'a frame that moves no graph’s share publishes nothing', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		skipped( 'COUNT 3 COUNTS jobstats.p0=3' );
		const published = link.unparseableByTarget;
		skipped( 'COUNT 8 COUNTS kea.p7=8' );
		expect( link.unparseableByTarget ).toBe( published );
	} );

	it( 'a parked graph keeps its share while the others climb', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		skipped( 'COUNT 9 COUNTS jobstats.p0=4,topicprobe.p0=5' );
		link.park( 'jobs:stream' );
		await flush();
		skipped( 'COUNT 3 COUNTS topicprobe.p0=3' );
		expect( link.unparseableByTarget ).toEqual( {
			'jobs:stream': 4,
			'backlog:stream': 8,
		} );
	} );

	it( 'detaching a graph that never attached leaves the stream be', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		const open = FakeEventSource.last;
		link.detach( 'backlog:stream' );
		await flush();
		expect( open.closed ).toBe( false );
		expect( FakeEventSource.opened ).toBe( 1 );
	} );

	it( 'refuses a tail on a stamp another graph is streaming, naming both', () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		expect( () =>
			link.attach( [ 'jobstats.p0' ], 'backlog:stream', null )
		).toThrow(
			'RemoteLink: backlog:stream cannot seek jobstats.p0, which jobs:stream is streaming'
		);
		expect( link.graphs.has( 'backlog:stream' ) ).toBe( false );
	} );

	it( 'unmounting a parked graph the open stream does not carry keeps it open', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream', {
			'topicprobe.p0': { segment: 3, offset: 61 },
		} );
		await flush();
		link.park( 'backlog:stream' );
		await flush();
		const open = FakeEventSource.last;
		const opened = FakeEventSource.opened;
		link.detach( 'backlog:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( opened );
		expect( open.closed ).toBe( false );
	} );

	it( 'refuses a glob tail over a dir another graph seeded this tick', () => {
		const { link } = makeShared();
		link.attach( [ 'errors.p1' ], 'jobs:stream', { 'errors.p1': 0 } );
		expect( () =>
			link.attach( [ 'errors.*' ], 'glob:stream', null )
		).toThrow(
			'RemoteLink: glob:stream cannot seek errors.p1, which jobs:stream is streaming'
		);
	} );

	it( 'refuses a glob tail over a dir another graph seeded and opened', async () => {
		const { link } = makeShared();
		link.attach( [ 'errors.p4' ], 'jobs:stream', { 'errors.p4': 0 } );
		await flush();
		expect( () =>
			link.attach( [ 'errors.*' ], 'glob:stream', null )
		).toThrow(
			'RemoteLink: glob:stream cannot seek errors.p4, which jobs:stream is streaming'
		);
	} );

	it( 'refuses a glob tail over a dir another graph has read', async () => {
		const { link } = makeShared();
		link.attach( [ 'errors.p3' ], 'jobs:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'errors.p3/x', '7:210:15' )
		);
		expect( () =>
			link.attach( [ 'errors.*' ], 'glob:stream', null )
		).toThrow(
			'RemoteLink: glob:stream cannot seek errors.p3, which jobs:stream is streaming'
		);
	} );

	it( 'an unmounted graph’s read positions go with it, so a later one tails', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:120:40' )
		);
		link.detach( 'jobs:stream' );
		await flush();
		link.attach( [ 'jobstats.p0' ], 'glob:stream' );
		await flush();
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'topicprobe.p0': SEEK_END,
			'jobstats.p0': SEEK_END,
		} );
	} );

	it( 'a parked graph resumes where it stopped when it plays', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:120:40' )
		);
		link.park( 'jobs:stream' );
		await flush();
		expect( FakeEventSource.last.url ).toContain(
			'subscribe=topicprobe.p0&'
		);
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 3 );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'topicprobe.p0': SEEK_END,
			'jobstats.p0': { segment: 3, offset: 160 },
		} );
	} );

	// A seed is spent once the server answers it: the handshake states where
	// each reader opened, and that cursor outranks the seed from then on.
	it( 'a parked graph’s spent seed is not asked for again on play', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream', {
			'jobstats.p0': SEEK_START,
		} );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		const m = newMessage();
		m[ TYPE ] = TM_INFO;
		m[ KEY ] = 'connected';
		m[ VALUE ] =
			`SESSION ${ HARNESS_SESSION } SLOT 4 OWNER ${ LEASE_OWNER } ` +
			'SUBSCRIPTIONS jobstats.p0,topicprobe.p0 INTERVAL 2000 ' +
			'CURSORS jobstats.p0=6:0,topicprobe.p0=9:4471';
		FakeEventSource.last.dispatch( 'connected', JSON.stringify( m ) );
		link.park( 'jobs:stream' );
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 1 );
		expect( link.sseIn.seekMap() ).toEqual( {
			'jobstats.p0': { segment: 6, offset: 0 },
			'topicprobe.p0': { segment: 9, offset: 4471 },
		} );
	} );

	// @longform The chart asked to replay the whole log; the slot pool refused
	// the stream before its handshake. Dropping the seed on a pause in that
	// window downgraded the next open to a tail, so the chart came up holding
	// one live point.
	it( 'a graph paused before its stream answered replays its seek on play', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream', {
			'jobstats.p0': SEEK_START,
		} );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		link.park( 'jobs:stream' );
		await flush();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 3 );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': SEEK_START,
			'topicprobe.p0': SEEK_END,
		} );
	} );

	it( 'a parked stamp a live graph kept reading is not rewound on play', async () => {
		const { link, delivered } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'jobstats.p0' ], 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:120:40' )
		);
		link.park( 'jobs:stream' );
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:500:25' )
		);
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 1 );
		expect( link.sseIn.seekMap() ).toEqual( {
			'jobstats.p0': { segment: 3, offset: 525 },
		} );
		expect( delivered[ 'jobs:stream' ].map( ( m ) => m[ ID ] ) ).toEqual( [
			'3:120:40',
		] );
	} );

	it( 'another graph unmounting keeps a parked graph’s place', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'jobstats.p0' ], 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '5:80:12' )
		);
		link.park( 'jobs:stream' );
		link.detach( 'backlog:stream' );
		await flush();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': { segment: 5, offset: 92 },
		} );
	} );

	it( 'unmounting a parked graph forgets its place', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '9:44:6' )
		);
		link.park( 'jobs:stream' );
		link.detach( 'jobs:stream' );
		link.attach( [ 'jobstats.p0' ], 'glob:stream' );
		await flush();
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'topicprobe.p0': SEEK_END,
			'jobstats.p0': SEEK_END,
		} );
	} );

	it( 'refuses a seek on a stamp a parked graph holds, naming both', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		link.park( 'jobs:stream' );
		expect( () =>
			link.attach( [ 'jobstats.p0' ], 'backlog:stream', {
				'jobstats.p0': { segment: 2, offset: 81 },
			} )
		).toThrow(
			'RemoteLink: backlog:stream cannot seek jobstats.p0, which jobs:stream is streaming'
		);
	} );

	it( 're-attaching on another subscription forgets the old one’s place', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream', {
			'jobstats.p0': { segment: 4, offset: 77 },
		} );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '4:77:33' )
		);
		link.attach( [ 'tablestats.p0' ], 'jobs:stream' );
		await flush();
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'tablestats.p0': SEEK_END,
		} );
		expect( link.sseIn.lastPositions ).toEqual( {} );
		// Back on the old stamp, neither its seed nor its read comes back.
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': SEEK_END,
		} );
	} );

	it( 'reattaching in another order keeps a stream on the same set', async () => {
		const { link } = makeShared();
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		await flush();
		link.detach( 'backlog:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 1 );
	} );

	it( 'unmounting a graph forgets its stamps’ skipped lines', async () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.attach( [ 'topicprobe.p0' ], 'backlog:stream' );
		await flush();
		const frame = newMessage();
		frame[ TYPE ] = TM_INFO;
		frame[ KEY ] = 'unparseable_lines';
		frame[ VALUE ] = 'COUNT 13 COUNTS jobstats.p0=6,topicprobe.p0=7';
		FakeEventSource.last.dispatch(
			'unparseable_lines',
			JSON.stringify( frame )
		);
		link.detach( 'jobs:stream' );
		await flush();
		expect( link.sseIn.unparseableByStamp ).toEqual( {
			'topicprobe.p0': 7,
		} );
		expect( link.unparseableByTarget ).toEqual( {
			'backlog:stream': 7,
		} );
	} );

	it( 'reads a graph’s subscription and pause off `graphs`, keyed by its target', () => {
		const { link } = makeShared();
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.park( 'jobs:stream' );
		expect( link.graphs.get( 'jobs:stream' ) ).toMatchObject( {
			subscribe: [ 'jobstats.p0' ],
			parked: true,
		} );
	} );

	it( 'removeNode drops a restart queued before it', async () => {
		const { link } = makeShared();
		let closes = 0;
		link.onClose = () => closes++;
		link.attach( [ 'jobstats.p0' ], 'jobs:stream' );
		link.removeNode();
		await flush();
		expect( FakeEventSource.last ).toBeNull();
		expect( closes ).toBe( 1 );
	} );
} );
