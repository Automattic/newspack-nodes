/**
 * RemoteLinkNode tests — the full-duplex "be the browser" SSE+HTTP channel base.
 *
 * One node that composes a per-link `<name>:sse-in` (registered so `trace` can
 * reach it, patron-owned so the canvas skips it) and SHARES the
 * reserved-name `_http` (HttpOut) + `_heartbeat` (Heartbeat) singletons, plus the
 * `connected → slot` bridge. A dashboard makes ONE RemoteLink; RemoteIpc extends
 * it with the worker-relay send + single-connection steal. Mirrors the PHP
 * Remote_Source patron; the durable offsetlog stays a PHP-only concern of its
 * readers.
 */

import { RemoteLinkNode } from '../remote-link-node';
import { Node } from '../node';
import { TeeNode } from '../tee-node';
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
	TM_RESPONSE,
	TM_STRUCT,
	TM_ERROR,
} from '../message';
import { ShellNode } from '../shell-node';
import names from '../reserved-node-names.json';
import brokerSchemas from '../../../tests/fixtures/broker-schemas.json';
import sourceCommands from '../../../tests/fixtures/broker-sources.json';

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

	it( 'a view adding sources supplies it, and `arguments` then reports it', async () => {
		const { interpreter } = mountExospine();
		const link = interpreter.makeNode( 'RemoteLink', 'late-link-812' );
		link.addSource( 'quartz.p7', 'grebe:stream' );
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
		link.addSource( 'quartz.p3', 'grebe:stream' );
		await Promise.resolve();
		expect( link.arguments ).toEqual( [ 'quartz.p3' ] );
		expect( link.sseIn.arguments ).toEqual( [ 'quartz.p3' ] );
		expect( link.dumpConfig() ).toContain(
			'make_node RemoteLink moved-link-903 quartz.p3'
		);
	} );

	it( 'a link with no sources delivers each record by its TO, its target filling an empty one', () => {
		const { link } = makeLink( 'kea.p4' );
		const got = {};
		for ( const name of [ 'dash:view', 'tern:view' ] ) {
			const n = new Node();
			n.name = name;
			n.fill = ( m ) => ( got[ name ] ||= [] ).push( m[ ID ] );
		}
		link.connect();
		for ( const [ to, id ] of [
			[ '', '1:0:5' ],
			[ 'tern:view', '1:5:5' ],
		] ) {
			const m = newMessage();
			m[ TYPE ] = TM_BYTESTREAM;
			m[ FROM ] = 'kea.p4';
			m[ TO ] = to;
			m[ ID ] = id;
			FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
		}
		expect( got ).toEqual( {
			'dash:view': [ '1:0:5' ],
			'tern:view': [ '1:5:5' ],
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
		// No seed of its own, so the seek it names is the tail sentinel.
		expect( link.sseIn.seekMap() ).toEqual( { 'raw-logs': SEEK_END } );
	} );

	it( 'opens every stream on /messages/stream; no link carries an endpoint', () => {
		const { link } = makeLink( 'sources:php' );
		link.connect();
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/messages/stream?subscribe=sources%3Aphp'
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

describe( 'sources — the routes one link carries', () => {
	const flush = () => Promise.resolve();
	const typeLine = ( shell, line ) => {
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ VALUE ] = line;
		shell.fill( m );
	};
	// A load-mode Shell: a refused line throws rather than replying.
	const typistOn = ( interpreter ) => {
		const shell = new ShellNode();
		shell.sink = interpreter;
		shell.wantReply( false );
		return shell;
	};
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
	const subscribed = () =>
		new URL( FakeEventSource.last.url, 'https://x.test' ).searchParams.get(
			'subscribe'
		);
	const ids = ( messages ) => ( messages ?? [] ).map( ( m ) => m[ ID ] );
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
	// The page's own link, with three views to route to.
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

	it( 'opens ONE stream on the union of its sources’ stamps', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream', {
			'jobstats.p0': SEEK_START,
		} );
		link.addSource( 'topicprobe.p0', 'backlog:stream', {
			'topicprobe.p0': SEEK_START,
		} );
		link.addSource( 'errors.*', 'glob:stream' );
		expect( FakeEventSource.last ).toBeNull();
		await flush();
		expect( FakeEventSource.opened ).toBe( 1 );
		expect( subscribed() ).toBe( 'errors.*,jobstats.p0,topicprobe.p0' );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': SEEK_START,
			'topicprobe.p0': SEEK_START,
		} );
		expect( link.sources ).toEqual( [
			{ stamp: 'jobstats.p0', target: 'jobs:stream' },
			{ stamp: 'topicprobe.p0', target: 'backlog:stream' },
			{ stamp: 'errors.*', target: 'glob:stream' },
		] );
	} );

	it( 'hands each record to its stamp’s Tee, which feeds that stamp’s views only', async () => {
		const { link, delivered } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/job-worker.p1/jobstats', '3:0:40' )
		);
		FakeEventSource.last.dispatch(
			'msg',
			record( 'topicprobe.p0/job-worker.p1/topicprobe', '8:0:30' )
		);
		expect( ids( delivered[ 'jobs:stream' ] ) ).toEqual( [ '3:0:40' ] );
		expect( ids( delivered[ 'backlog:stream' ] ) ).toEqual( [ '8:0:30' ] );
		const tee = Core.node( '_stream:jobstats.p0' );
		expect( tee ).toBeInstanceOf( TeeNode );
		expect( tee.patron ).toBe( link );
		expect( tee.sink ).toBe( link.sink );
		expect( tee.target ).toEqual( [ 'jobs:stream' ] );
	} );

	it( 'delivers a record whatever TO it was stored with', async () => {
		const { link, delivered } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		const m = newMessage();
		m[ TYPE ] = TM_STRUCT;
		m[ FROM ] = 'jobstats.p0';
		m[ TO ] = 'stale-route-5512';
		m[ ID ] = '3:44:9';
		m[ VALUE ] = { seen: 'stored-to-5512' };
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
		expect( ids( delivered[ 'jobs:stream' ] ) ).toEqual( [ '3:44:9' ] );
	} );

	it( 'two views on one stamp share its one Tee, and ls -al shows both targets', async () => {
		const { link, delivered } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'jobstats.p0', 'backlog:stream' );
		await flush();
		expect( subscribed() ).toBe( 'jobstats.p0' );
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0', '3:0:40' )
		);
		expect( ids( delivered[ 'jobs:stream' ] ) ).toEqual( [ '3:0:40' ] );
		expect( ids( delivered[ 'backlog:stream' ] ) ).toEqual( [ '3:0:40' ] );
		expect( Core.node( '_stream:jobstats.p0' ).target ).toEqual( [
			'jobs:stream',
			'backlog:stream',
		] );
		const listing = Core.node( names.COMMAND_INTERPRETER ).dispatch( 'ls', [
			'-al',
			'^_stream:jobstats',
		] );
		expect( listing ).toMatch(
			/_stream:jobstats\.p0\s.*-> jobs:stream, backlog:stream/
		);
	} );

	it( 'a glob source builds a Tee per stamp on first sight', async () => {
		const { link, delivered } = makeShared();
		link.addSource( 'errors.*', 'glob:stream' );
		link.addSource( 'errors.p3', 'jobs:stream' );
		await flush();
		expect( Core.node( '_stream:errors.p3' ) ).toBeNull();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'errors.p3/x', '1:0:9' )
		);
		FakeEventSource.last.dispatch(
			'msg',
			record( 'errors.p5/x', '2:0:9' )
		);
		expect( Core.node( '_stream:errors.p3' ).target ).toEqual( [
			'glob:stream',
			'jobs:stream',
		] );
		expect( Core.node( '_stream:errors.p5' ).target ).toEqual( [
			'glob:stream',
		] );
		expect( ids( delivered[ 'glob:stream' ] ) ).toEqual( [
			'1:0:9',
			'2:0:9',
		] );
		expect( ids( delivered[ 'jobs:stream' ] ) ).toEqual( [ '1:0:9' ] );
	} );

	it( 'drops a record no source claims, saying so, and builds no Tee', async () => {
		expectConsoleWarn(
			'_stream: WARNING: no source claims the stamp - TM_BYTESTREAM from: kea.p7/x'
		);
		const { link, delivered } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		FakeEventSource.last.dispatch( 'msg', record( 'kea.p7/x', '6:0:3' ) );
		expect( delivered ).toEqual( {} );
		expect( Core.node( '_stream:kea.p7' ) ).toBeNull();
	} );

	it( 'drops a record whose FROM names no stamp', async () => {
		expectConsoleWarn(
			'_stream: WARNING: no source claims the stamp - TM_BYTESTREAM'
		);
		const { link, delivered } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		FakeEventSource.last.dispatch( 'msg', record( '', '4:0:12' ) );
		expect( delivered ).toEqual( {} );
	} );

	it( 'drops a broker reader’s stamp, which no glob claims', async () => {
		expectConsoleWarn(
			'_stream: WARNING: no source claims the stamp - TM_BYTESTREAM from: offsets:hub.tw0:firehose.p0/x'
		);
		const { link, delivered } = makeShared();
		link.addSource( 'o*', 'glob:stream' );
		await flush();
		expect( () =>
			FakeEventSource.last.dispatch(
				'msg',
				record( 'offsets:hub.tw0:firehose.p0/x', '2:0:4' )
			)
		).not.toThrow();
		expect( delivered ).toEqual( {} );
	} );

	it( 'drops a glob stamp whose Tee would take the SseIn’s slot', async () => {
		expectConsoleWarn(
			'_stream: WARNING: the stamp names the slot the SseIn holds - TM_BYTESTREAM from: sse-in'
		);
		const { link, delivered } = makeShared();
		link.addSource( 'sse*', 'glob:stream' );
		await flush();
		expect( () =>
			FakeEventSource.last.dispatch( 'msg', record( 'sse-in', '2:0:4' ) )
		).not.toThrow();
		expect( delivered ).toEqual( {} );
		expect( Core.node( '_stream:sse-in' ) ).toBe( link.sseIn );
	} );

	it( 'a command reply keeps the TO the server addressed', async () => {
		const { link, delivered } = makeShared();
		const replies = [];
		const receiver = new Node();
		receiver.name = 'status-receiver-6620';
		receiver.fill = ( m ) => replies.push( m[ VALUE ] );
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		const reply = newMessage();
		reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		reply[ FROM ] = 'jobstats.p0';
		reply[ TO ] = 'status-receiver-6620';
		reply[ VALUE ] = { name: 'dump_log', payload: { size: 7731 } };
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( reply ) );
		expect( replies ).toEqual( [
			{ name: 'dump_log', payload: { size: 7731 } },
		] );
		expect( delivered ).toEqual( {} );
	} );

	it( 'removing one view’s source drops only its edge; the other keeps streaming', async () => {
		const { link, delivered } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'jobstats.p0', 'backlog:stream' );
		await flush();
		const open = FakeEventSource.last;
		open.dispatch( 'msg', record( 'jobstats.p0/x', '3:120:40' ) );
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		open.dispatch( 'msg', record( 'jobstats.p0/x', '3:160:25' ) );
		expect( FakeEventSource.opened ).toBe( 1 );
		expect( open.closed ).toBe( false );
		expect( Core.node( '_stream:jobstats.p0' ).target ).toEqual( [
			'backlog:stream',
		] );
		expect( ids( delivered[ 'jobs:stream' ] ) ).toEqual( [ '3:120:40' ] );
		expect( ids( delivered[ 'backlog:stream' ] ) ).toEqual( [
			'3:120:40',
			'3:160:25',
		] );
	} );

	it( 'removing a stamp’s last source unsubscribes it, keeps its place and retracts its Tee', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:120:40' )
		);
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		expect( subscribed() ).toBe( 'topicprobe.p0' );
		expect( Core.node( '_stream:jobstats.p0' ) ).toBeNull();
		expect( link.sseIn.lastPositions[ 'jobstats.p0' ] ).toEqual( {
			segment: 3,
			offset: 160,
		} );
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 3 );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'topicprobe.p0': SEEK_END,
			'jobstats.p0': { segment: 3, offset: 160 },
		} );
	} );

	it( 'a record after its last source went, before the reopen, is dropped', async () => {
		expectConsoleWarn(
			'_stream: WARNING: no source claims the stamp - TM_BYTESTREAM from: jobstats.p0/x'
		);
		const { link, delivered } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		await flush();
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:200:10' )
		);
		expect( delivered ).toEqual( {} );
	} );

	it( 'the last removed source closes the stream and its heartbeat lease', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		dispatchConnected( link, { slot: 6 } );
		const hb = Core.node( names.HEARTBEAT );
		expect( hb.slot ).toBe( 6 );
		const open = FakeEventSource.last;
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		expect( open.closed ).toBe( true );
		expect( hb.slot ).toBeNull();
		expect( link.sources ).toEqual( [] );
		expect( FakeEventSource.opened ).toBe( 1 );
	} );

	it( 'refuses a seek on a stamp another view’s source claims, naming both, and adds nothing', () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.*', 'jobs:stream' );
		expect( () =>
			link.addSource( 'jobstats.p0', 'backlog:stream', {
				'jobstats.p0': SEEK_START,
			} )
		).toThrow(
			'RemoteLink: backlog:stream cannot seek jobstats.p0, which jobs:stream is streaming'
		);
		expect( link.sources ).toEqual( [
			{ stamp: 'jobstats.*', target: 'jobs:stream' },
		] );
	} );

	it( 'refuses a tail on a stamp another view’s source claims', () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		expect( () =>
			link.addSource( 'jobstats.p0', 'backlog:stream', null )
		).toThrow(
			'RemoteLink: backlog:stream cannot seek jobstats.p0, which jobs:stream is streaming'
		);
	} );

	it( 'refuses a glob tail over a dir another view seeded this tick', () => {
		const { link } = makeShared();
		link.addSource( 'errors.p1', 'jobs:stream', { 'errors.p1': 0 } );
		expect( () =>
			link.addSource( 'errors.*', 'glob:stream', null )
		).toThrow(
			'RemoteLink: glob:stream cannot seek errors.p1, which jobs:stream is streaming'
		);
	} );

	it( 'refuses a glob tail over a dir another view has read', async () => {
		const { link } = makeShared();
		link.addSource( 'errors.p3', 'jobs:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'errors.p3/x', '7:210:15' )
		);
		expect( () =>
			link.addSource( 'errors.*', 'glob:stream', null )
		).toThrow(
			'RemoteLink: glob:stream cannot seek errors.p3, which jobs:stream is streaming'
		);
	} );

	it( 'one drop line covers every unclaimed stamp in its window', async () => {
		expectConsoleWarn(
			'_stream: WARNING: no source claims the stamp - TM_BYTESTREAM from: kea.p7/x'
		);
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		FakeEventSource.last.dispatch( 'msg', record( 'kea.p7/x', '6:0:3' ) );
		FakeEventSource.last.dispatch( 'msg', record( 'kea.p8/x', '6:3:3' ) );
		expect(
			Core.recentLog.filter( ( line ) =>
				line.includes( 'no source claims the stamp' )
			)
		).toHaveLength( 1 );
	} );

	it( 'a directed TM_ERROR or TM_RESPONSE goes out by its TO', async () => {
		const { link, delivered } = makeShared();
		const got = [];
		const receiver = new Node();
		receiver.name = 'fetch-receiver-7731';
		receiver.fill = ( m ) => got.push( m[ VALUE ] );
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		for ( const [ type, value ] of [
			[ TM_ERROR, 'NOT_AVAILABLE bounce-4402' ],
			[ TM_RESPONSE, 'response-4403' ],
		] ) {
			const m = newMessage();
			m[ TYPE ] = type;
			m[ FROM ] = 'jobstats.p0';
			m[ TO ] = 'fetch-receiver-7731';
			m[ VALUE ] = value;
			FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
		}
		expect( got ).toEqual( [
			'NOT_AVAILABLE bounce-4402',
			'response-4403',
		] );
		expect( delivered ).toEqual( {} );
	} );

	it( 'an undirected TM_ERROR on a claimed stamp goes through its Tee', async () => {
		const { link, delivered } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		const m = newMessage();
		m[ TYPE ] = TM_ERROR;
		m[ FROM ] = 'jobstats.p0';
		m[ ID ] = '3:0:8';
		m[ VALUE ] = 'stream error 5530';
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
		expect( ids( delivered[ 'jobs:stream' ] ) ).toEqual( [ '3:0:8' ] );
	} );

	it( 'parking a stamp’s last source unsubscribes it and retracts its Tee, keeping its claim', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:120:40' )
		);
		link.parkSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		expect( subscribed() ).toBe( 'topicprobe.p0' );
		expect( Core.node( '_stream:jobstats.p0' ) ).toBeNull();
		expect( link.sources ).toEqual( [
			{ stamp: 'topicprobe.p0', target: 'backlog:stream' },
		] );
		expect( link.parked ).toEqual( [
			{ stamp: 'jobstats.p0', target: 'jobs:stream' },
		] );
	} );

	it( 'a parked source feeds no edge while its stamp’s other view streams on', async () => {
		const { link, delivered } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'jobstats.p0', 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:0:40' )
		);
		link.parkSource( 'jobstats.p0', 'jobs:stream' );
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:40:12' )
		);
		expect( Core.node( '_stream:jobstats.p0' ).target ).toEqual( [
			'backlog:stream',
		] );
		expect( ids( delivered[ 'jobs:stream' ] ) ).toEqual( [ '3:0:40' ] );
		expect( ids( delivered[ 'backlog:stream' ] ) ).toEqual( [
			'3:0:40',
			'3:40:12',
		] );
	} );

	it( 'refuses a seek on a stamp a paused view claims, naming it', () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'jobstats.p0', 'backlog:stream' );
		link.parkSource( 'jobstats.p0', 'jobs:stream' );
		expect( () =>
			link.addSource( 'jobstats.p0', 'backlog:stream', {
				'jobstats.p0': { segment: 4, offset: 96 },
			} )
		).toThrow(
			'RemoteLink: backlog:stream cannot seek jobstats.p0, which jobs:stream is streaming'
		);
	} );

	it( 'a paused view keeps its place when the other view on its stamp leaves, and resumes there', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'jobstats.p0', 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:120:40' )
		);
		link.parkSource( 'jobstats.p0', 'jobs:stream' );
		link.removeSource( 'jobstats.p0', 'backlog:stream' );
		link.forget( [ 'jobstats.p0' ] );
		await flush();
		expect( link.sseIn.lastPositions[ 'jobstats.p0' ] ).toEqual( {
			segment: 3,
			offset: 160,
		} );
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		expect( link.parked ).toEqual( [] );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': { segment: 3, offset: 160 },
		} );
	} );

	it( 'removing a parked source gives up its claim', () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.parkSource( 'jobstats.p0', 'jobs:stream' );
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		expect( link.parked ).toEqual( [] );
		expect( () =>
			link.addSource( 'jobstats.p0', 'backlog:stream', {
				'jobstats.p0': SEEK_START,
			} )
		).not.toThrow();
	} );

	it( 'a view may seek a stamp whose other view removed its source', () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		expect( () =>
			link.addSource( 'jobstats.p0', 'backlog:stream', {
				'jobstats.p0': { segment: 2, offset: 81 },
			} )
		).not.toThrow();
	} );

	it( 'a null seek tails that view’s dirs while the others resume', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:120:40' )
		);
		FakeEventSource.last.dispatch(
			'msg',
			record( 'topicprobe.p0/x', '8:600:30' )
		);
		link.addSource( 'jobstats.p0', 'jobs:stream', null );
		await flush();
		expect( FakeEventSource.opened ).toBe( 2 );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': SEEK_END,
			'topicprobe.p0': { segment: 8, offset: 630 },
		} );
	} );

	it( 'a seek added and removed in one tick is never asked for', async () => {
		const { link } = makeShared();
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		link.addSource( 'jobstats.p0', 'jobs:stream', {
			'jobstats.p0': SEEK_START,
		} );
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		link.forget( [ 'jobstats.p0' ] );
		link.addSource( 'jobstats.p0', 'glob:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 1 );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'topicprobe.p0': SEEK_END,
			'jobstats.p0': SEEK_END,
		} );
	} );

	it( 're-adding the same sources keeps the open stream', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		const open = FakeEventSource.last;
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 1 );
		expect( open.closed ).toBe( false );
		expect( link.sources ).toEqual( [
			{ stamp: 'jobstats.p0', target: 'jobs:stream' },
		] );
	} );

	it( 're-adding the same sources waits out a scheduled reopen', async () => {
		jest.useFakeTimers( { doNotFake: [ 'queueMicrotask' ] } );
		try {
			const { link } = makeShared();
			link.addSource( 'jobstats.p0', 'jobs:stream' );
			await flush();
			const refused = FakeEventSource.last;
			refused.dispatch( 'error' );
			expect( refused.closed ).toBe( true );
			link.addSource( 'jobstats.p0', 'jobs:stream' );
			await flush();
			expect( FakeEventSource.opened ).toBe( 1 );
			jest.advanceTimersByTime( 2000 );
			expect( FakeEventSource.opened ).toBe( 2 );
			link.removeNode();
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 're-adding in the same tick keeps the seek it has not stated yet', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream', {
			'jobstats.p0': { segment: 6, offset: 14 },
		} );
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': { segment: 6, offset: 14 },
		} );
	} );

	it( 'a seed the handshake spent is not asked for again when its source returns', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream', {
			'jobstats.p0': SEEK_START,
		} );
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		await flush();
		const m = newMessage();
		m[ TYPE ] = TM_INFO;
		m[ KEY ] = 'connected';
		m[ VALUE ] =
			`SESSION ${ HARNESS_SESSION } SLOT 4 OWNER ${ LEASE_OWNER } ` +
			'SUBSCRIPTIONS jobstats.p0,topicprobe.p0 INTERVAL 2000 ' +
			'CURSORS jobstats.p0=6:0,topicprobe.p0=9:4471';
		FakeEventSource.last.dispatch( 'connected', JSON.stringify( m ) );
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 1 );
		expect( link.sseIn.seekMap() ).toEqual( {
			'jobstats.p0': { segment: 6, offset: 0 },
			'topicprobe.p0': { segment: 9, offset: 4471 },
		} );
	} );

	it( 'a view removed before its stream answered replays its seek when it returns', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream', {
			'jobstats.p0': SEEK_START,
		} );
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		await flush();
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 3 );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': SEEK_START,
			'topicprobe.p0': SEEK_END,
		} );
	} );

	it( 'forget drops the place and count of a dir no source claims, so a later view tails', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '3:120:40' )
		);
		skipped( 'COUNT 13 COUNTS jobstats.p0=6,topicprobe.p0=7' );
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		link.forget( [ 'jobstats.p0' ] );
		await flush();
		expect( link.unparseableByStamp ).toEqual( { 'topicprobe.p0': 7 } );
		link.addSource( 'jobstats.p0', 'glob:stream' );
		await flush();
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'topicprobe.p0': SEEK_END,
			'jobstats.p0': SEEK_END,
		} );
	} );

	it( 'forget keeps a dir another source still claims, and the stream riding it', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'jobstats.p0', 'backlog:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0/x', '5:80:12' )
		);
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		link.forget( [ 'jobstats.p0' ] );
		await flush();
		expect( FakeEventSource.opened ).toBe( 1 );
		expect( link.sseIn.lastPositions[ 'jobstats.p0' ] ).toEqual( {
			segment: 5,
			offset: 92,
		} );
	} );

	it( 'forgetting a place the open stream carries reopens even on the same set', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream', {
			'jobstats.p0': SEEK_START,
		} );
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		await flush();
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		link.forget( [ 'jobstats.p0' ] );
		link.addSource( 'jobstats.p0', 'glob:stream' );
		await flush();
		expect( FakeEventSource.opened ).toBe( 2 );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': SEEK_END,
			'topicprobe.p0': SEEK_END,
		} );
	} );

	it( 'publishes its stream’s skipped lines by stamp', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		skipped( 'COUNT 11 COUNTS jobstats.p0=4,kea.p7=7' );
		expect( link.unparseableByStamp ).toEqual( {
			'jobstats.p0': 4,
			'kea.p7': 7,
		} );
		expect( link.setStateCache.UNPARSEABLE_LINES ).toBe( 11 );
		expect( Core.node( 'jobs:stream' ).setStateCache ).toEqual( {} );
	} );

	it( 'a stamp whose sources all went keeps its count while the others climb', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		await flush();
		skipped( 'COUNT 9 COUNTS jobstats.p0=4,topicprobe.p0=5' );
		link.removeSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		skipped( 'COUNT 3 COUNTS topicprobe.p0=3' );
		expect( link.unparseableByStamp ).toEqual( {
			'jobstats.p0': 4,
			'topicprobe.p0': 8,
		} );
	} );

	it( 'publishes a fresh map on every frame, so a reader re-renders', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		skipped( 'COUNT 3 COUNTS jobstats.p0=3' );
		const published = link.unparseableByStamp;
		skipped( 'COUNT 8 COUNTS kea.p7=8' );
		expect( link.unparseableByStamp ).not.toBe( published );
		expect( link.unparseableByStamp ).toEqual( {
			'jobstats.p0': 3,
			'kea.p7': 8,
		} );
	} );

	it( 'removing sources it does not carry leaves the stream be', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		const open = FakeEventSource.last;
		link.removeSource( 'jobstats.p0', 'backlog:stream' );
		await flush();
		expect( open.closed ).toBe( false );
		expect( FakeEventSource.opened ).toBe( 1 );
	} );

	it( 'refuses a source missing its stamp or its target', () => {
		const { link } = makeShared();
		expect( () => link.addSource( 'jobstats.p0', '' ) ).toThrow(
			"RemoteLink: add_source needs a stamp and a target, got 'jobstats.p0' ''"
		);
		expect( () => link.addSource( '', 'jobs:stream' ) ).toThrow(
			"RemoteLink: add_source needs a stamp and a target, got '' 'jobs:stream'"
		);
		expect( link.sources ).toEqual( [] );
	} );

	it( 'carries a broker reader’s stamp as a source', async () => {
		const { link, delivered } = makeShared();
		link.addSource( 'offsets:hub.tw0:firehose.p0', 'jobs:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'offsets:hub.tw0:firehose.p0/sources:php/x', '2:0:4' )
		);
		expect( ids( delivered[ 'jobs:stream' ] ) ).toEqual( [ '2:0:4' ] );
		expect(
			Core.node( '_stream:offsets:hub.tw0:firehose.p0' ).target
		).toEqual( [ 'jobs:stream' ] );
	} );

	it( 'refuses a source whose Tee would take the SseIn’s slot', () => {
		const { link } = makeShared();
		expect( () => link.addSource( 'sse-in', 'jobs:stream' ) ).toThrow(
			"RemoteLink: a source's Tee names the slot its SseIn holds: 'sse-in'"
		);
		expect( link.sources ).toEqual( [] );
	} );

	it( 'states one view’s seek over its two sources once', async () => {
		const { link } = makeShared();
		const reseek = jest.spyOn( SseInNode.prototype, 'reseek' );
		const seed = {
			'jobstats.p0': { segment: 4, offset: 9 },
			'topicprobe.p0': { segment: 7, offset: 2 },
		};
		link.addSource( 'jobstats.p0', 'jobs:stream', seed );
		link.addSource( 'topicprobe.p0', 'jobs:stream', seed );
		await flush();
		expect( reseek.mock.calls ).toEqual( [
			[ [ 'jobstats.p0', 'topicprobe.p0' ], seed ],
		] );
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( seed );
		reseek.mockRestore();
	} );

	it( 'a source added without a seek drops its view’s seek that names it not', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream', {
			'jobstats.p0': { segment: 5, offset: 33 },
		} );
		link.addSource( 'topicprobe.p0', 'jobs:stream' );
		await flush();
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': SEEK_END,
			'topicprobe.p0': SEEK_END,
		} );
	} );

	it( 'removing one of a view’s sources keeps its seek while it holds another', async () => {
		const { link } = makeShared();
		const seed = { 'jobstats.p0': { segment: 2, offset: 70 } };
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		link.addSource( 'jobstats.p0', 'jobs:stream', seed );
		link.addSource( 'errors.p1', 'jobs:stream', seed );
		link.removeSource( 'errors.p1', 'jobs:stream' );
		await flush();
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': { segment: 2, offset: 70 },
			'topicprobe.p0': SEEK_END,
		} );
	} );

	it( 'parking a view’s last source drops the seek it has not stated', async () => {
		const { link } = makeShared();
		link.addSource( 'topicprobe.p0', 'backlog:stream' );
		link.addSource( 'jobstats.p0', 'jobs:stream', {
			'jobstats.p0': { segment: 8, offset: 3 },
		} );
		link.parkSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		expect( seeksOf( FakeEventSource.last.url ) ).toEqual( {
			'jobstats.p0': SEEK_END,
			'topicprobe.p0': SEEK_END,
		} );
	} );

	it( 'checkSource refuses what addSource refuses, and changes nothing', () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.parkSource( 'jobstats.p0', 'jobs:stream' );
		link.addSource( 'heron.p2', 'backlog:stream' );
		const sources = [ ...link.sources ];
		const parked = [ ...link.parked ];

		expect( () =>
			link.checkSource( 'jobstats.p0', 'glob:stream', null )
		).toThrow(
			'RemoteLink: glob:stream cannot seek jobstats.p0, which jobs:stream is streaming'
		);
		expect( () => link.checkSource( 'sse-in', 'glob:stream' ) ).toThrow(
			"RemoteLink: a source's Tee names the slot its SseIn holds: 'sse-in'"
		);
		expect( () =>
			link.checkSource( 'egret.p4', 'glob:stream', {
				'egret.p4': { segment: 1, offset: 6 },
			} )
		).not.toThrow();
		expect( link.sources ).toEqual( sources );
		expect( link.parked ).toEqual( parked );
		expect( link._seeks.size ).toBe( 0 );
	} );

	it( 'a cmd on the link’s :config routes that stamp’s records to its target', async () => {
		const { stream: link, interpreter } = mountExospine();
		const got = [];
		const heron = new Node();
		heron.name = 'heron-6612:stream';
		heron.fill = ( m ) => got.push( m );
		const shell = typistOn( interpreter );

		typeLine(
			shell,
			'cmd _stream:config add_source egret.p4 heron-6612:stream'
		);
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'egret.p4/x', '6:0:12' )
		);

		expect( link.sources ).toEqual( [
			{ stamp: 'egret.p4', target: 'heron-6612:stream' },
		] );
		expect( ids( got ) ).toEqual( [ '6:0:12' ] );
	} );

	it( 'a cmd remove_source stops that stamp’s records reaching its target', async () => {
		expectConsoleWarn(
			'_stream: WARNING: no source claims the stamp - TM_BYTESTREAM from: egret.p4/x'
		);
		const { stream: link, interpreter } = mountExospine();
		const got = [];
		const heron = new Node();
		heron.name = 'heron-6612:stream';
		heron.fill = ( m ) => got.push( m );
		const shell = typistOn( interpreter );
		typeLine(
			shell,
			'cmd _stream:config add_source egret.p4 heron-6612:stream'
		);
		typeLine(
			shell,
			'cmd _stream:config add_source --local_node=heron-6612:stream --remote_log=ibis.p2'
		);
		await flush();

		typeLine(
			shell,
			'cmd _stream:config remove_source egret.p4 --local_node=heron-6612:stream'
		);
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'egret.p4/x', '6:0:12' )
		);
		FakeEventSource.last.dispatch( 'msg', record( 'ibis.p2/x', '3:0:8' ) );

		expect( link.sources ).toEqual( [
			{ stamp: 'ibis.p2', target: 'heron-6612:stream' },
		] );
		expect( subscribed() ).toBe( 'ibis.p2' );
		expect( ids( got ) ).toEqual( [ '3:0:8' ] );
	} );

	it( 'the :config answers add_source and remove_source, binding their arguments', () => {
		const { stream: link } = mountExospine();
		const config = Core.node( '_stream:config' );

		expect( config ).toBeInstanceOf( CommandInterpreterNode );
		expect( config.patron ).toBe( link );
		expect( Object.keys( config.commands() ) ).toEqual( [
			'add_source',
			'remove_source',
		] );
		expect( config.dispatch( 'add_source', [ 'kea.p*', 'herd-52' ] ) ).toBe(
			'ok'
		);
		expect(
			config.dispatch( 'add_source', [
				'--local_node=herd-52',
				'--remote_log=kea.p3',
			] )
		).toBe( 'ok' );
		expect( link.sources ).toEqual( [
			{ stamp: 'kea.p*', target: 'herd-52' },
			{ stamp: 'kea.p3', target: 'herd-52' },
		] );
		expect( () => config.dispatch( 'add_source', [ 'kea.p3' ] ) ).toThrow(
			'missing required argument: local_node'
		);
		expect( () =>
			config.dispatch( 'remove_source', [ 'kea.p*', 'herd-52', 'x' ] )
		).toThrow( 'too many arguments: 3 given, 2 accepted' );
		expect(
			config.dispatch( 'remove_source', [
				'kea.p*',
				'--local_node=herd-52',
			] )
		).toBe( 'ok' );
		expect( link.sources ).toEqual( [
			{ stamp: 'kea.p3', target: 'herd-52' },
		] );
	} );

	it( 'a cmd add_source refuses a second target for a declared stamp', async () => {
		const { stream: link, interpreter } = mountExospine();
		const shell = typistOn( interpreter );
		typeLine(
			shell,
			'cmd _stream:config add_source egret.p4 heron-6612:stream'
		);
		typeLine(
			shell,
			'cmd _stream:config add_source egret.p4 heron-6612:stream'
		);

		expect( () =>
			typeLine(
				shell,
				'cmd _stream:config add_source egret.p4 kite-2290:stream'
			)
		).toThrow(
			"add_source 'egret.p4' already goes to 'heron-6612:stream', not 'kite-2290:stream'"
		);
		link.parkSource( 'egret.p4', 'heron-6612:stream' );
		expect( () =>
			typeLine(
				shell,
				'cmd _stream:config add_source egret.p4 kite-2290:stream'
			)
		).toThrow( "already goes to 'heron-6612:stream'" );
		typeLine(
			shell,
			'cmd _stream:config add_source egret.p4 heron-6612:stream'
		);
		await flush();
		expect( link.sources ).toEqual( [] );
		expect( link.parked ).toEqual( [
			{ stamp: 'egret.p4', target: 'heron-6612:stream' },
		] );
	} );

	it( 'the addSource method fans a stamp out to every view the cmd would refuse', () => {
		const { stream: link } = mountExospine();
		link.addSource( 'egret.p4', 'heron-6612:stream' );
		link.addSource( 'egret.p4', 'kite-2290:stream' );

		expect( link.sources ).toEqual( [
			{ stamp: 'egret.p4', target: 'heron-6612:stream' },
			{ stamp: 'egret.p4', target: 'kite-2290:stream' },
		] );
		expect( () =>
			Core.node( '_stream:config' ).dispatch( 'add_source', [
				'egret.p4',
				'plover-31:stream',
			] )
		).toThrow(
			"already goes to 'heron-6612:stream', not 'plover-31:stream'"
		);
	} );

	it( 'a cmd remove_source refuses a source the link does not declare', () => {
		const { stream: link, interpreter } = mountExospine();
		const shell = typistOn( interpreter );
		link.addSource( 'egret.p4', 'heron-6612:stream' );

		expect( () =>
			typeLine(
				shell,
				'cmd _stream:config remove_source egret.p4 kite-2290:stream'
			)
		).toThrow(
			"remove_source 'egret.p4' 'kite-2290:stream' names no source this node declares"
		);
		link.parkSource( 'egret.p4', 'heron-6612:stream' );
		typeLine(
			shell,
			'cmd _stream:config remove_source egret.p4 heron-6612:stream'
		);
		expect( link.parked ).toEqual( [] );
	} );

	it.each(
		sourceCommands.filter(
			( [ , commands ] ) =>
				! JSON.stringify( commands ).includes( '{partition}' )
		)
	)(
		'a :config folds the commands as the PHP broker does: %s',
		( label, commands, expected ) => {
			const link = new CommandInterpreterNode().makeNode(
				'RemoteLink',
				'okapi-link-5501'
			);
			let answer;
			try {
				// The link answers its two source verbs alone.
				for ( const [ verb, tokens ] of commands.filter( ( [ v ] ) =>
					[ 'add_source', 'remove_source' ].includes( v )
				) ) {
					link.interpreter.dispatch( verb, tokens );
				}
				answer = link.sources.map( ( s ) => s.target );
			} catch ( e ) {
				answer = { refused: e.message };
			}
			link.removeNode();

			expect( answer ).toEqual( expected );
		}
	);

	it( 'a :config refuses {partition}, which no browser binds', () => {
		const link = new CommandInterpreterNode().makeNode(
			'RemoteLink',
			'okapi-link-5502'
		);

		expect( () =>
			link.interpreter.dispatch( 'add_source', [
				'egret.p{partition}',
				'heron-31',
			] )
		).toThrow(
			"add_source 'egret.p{partition}' 'heron-31' names {partition}, but no partition is bound"
		);
		link.removeNode();
	} );

	it( 'declares add_source and remove_source as the PHP broker does', () => {
		const shape = ( verb ) => ( {
			name: verb.name,
			multiple: verb.multiple,
			args: verb.args.map( ( { name, type, required } ) => ( {
				name,
				type,
				required,
			} ) ),
		} );
		const php = brokerSchemas.find(
			( c ) => 'Remote_Source' === c.shell_name
		).commands;

		expect( RemoteLinkNode.nodeSchema().commands.map( shape ) ).toEqual(
			php.map( shape )
		);
	} );

	it( 'wires a :config in its node’s own table, never in Core', () => {
		const tables = new NodeRegistry();
		const interpreter = new CommandInterpreterNode();
		interpreter.childRegistry = tables;
		const link = interpreter.makeNode( 'RemoteLink', 'tern-link-3304' );

		expect( tables.node( 'tern-link-3304:config' ).patron ).toBe( link );
		expect( Core.node( 'tern-link-3304:config' ) ).toBeNull();
	} );

	it( 'make_node RemoteLink wires its :config, and a teardown takes it', () => {
		const { interpreter } = mountExospine();
		const link = interpreter.makeNode( 'RemoteLink', 'kite-link-7712' );

		expect( Core.node( 'kite-link-7712:config' ).patron ).toBe( link );
		expect( Core.node( 'kite-link-7712:config' ).sink ).toBe( interpreter );
		link.removeNode();
		expect( Core.node( 'kite-link-7712:config' ) ).toBeNull();
	} );

	it( 'removeNode retracts every Tee, so a fresh link builds them again', async () => {
		const { link } = makeShared();
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0', '3:0:40' )
		);
		link.removeNode();
		expect( Core.node( '_stream:jobstats.p0' ) ).toBeNull();
		const fresh = new RemoteLinkNode();
		fresh.name = names.STREAM;
		fresh.sink = Core.node( names.COMMAND_INTERPRETER );
		fresh.addSource( 'jobstats.p0', 'jobs:stream' );
		await flush();
		FakeEventSource.last.dispatch(
			'msg',
			record( 'jobstats.p0', '3:40:12' )
		);
		expect( Core.node( '_stream:jobstats.p0' ).patron ).toBe( fresh );
	} );

	it( 'removeNode drops a restart queued before it', async () => {
		const { link } = makeShared();
		let closes = 0;
		link.onClose = () => closes++;
		link.addSource( 'jobstats.p0', 'jobs:stream' );
		link.removeNode();
		await flush();
		expect( FakeEventSource.last ).toBeNull();
		expect( closes ).toBe( 1 );
	} );
} );
