/**
 * RemoteIpcNode tests — the per-worker interactive command channel.
 *
 * One RemoteIpc per active worker, named `{topology}.p{N}`. It EXTENDS RemoteLink
 * but overrides the child composition for the console: it owns a per-worker
 * `<name>:sse-in` (registered so `trace` can reach it, patron-owned so the
 * canvas skips it) and SHARES the reserved-name `_http` (HttpOut) + `_heartbeat`
 * (Heartbeat) singletons with every other RemoteIpc (stable names; `/_http`
 * resolves). It adds the worker-relay send + the single live-connection steal.
 * A send boots/steals the single live EventSource (closing whichever RemoteIpc
 * held it), then routes `[connect_worker_input → topologies, command → {bare
 * reader}]` through the shared `_http` as ONE POST. The reply-node FROM wrap
 * (`_sse:{session}/{node}`) — the server's HTTP_Filter wire contract — lives here.
 */

import { RemoteIpcNode } from '../remote-ipc-node';
import { RemoteLinkNode } from '../remote-link-node';
import { SseInNode } from '../sse-in-node';
import { HttpOutNode } from '../http-out-node';
import { HeartbeatNode } from '../heartbeat-node';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { mountExospine } from '../exospine';
import { Core } from '../core';
import { Node } from '../node';
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
	TM_REQUEST,
	TM_BYTESTREAM,
} from '../message';
import names from '../reserved-node-names.json';
import { __setAuthFetch, ensureSession, forgetSession } from '../command-auth';

const LEASE_OWNER = '9007199254740993';

// The handle jest.setup.js issues every test's command session under.
const HARNESS_SESSION = 'e2e11111e2e22222e2e33333e2e44444';

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
	dispatch( name, data ) {
		( this.listeners[ name ] || [] ).forEach( ( cb ) => cb( { data } ) );
	}
}

let posted;

beforeEach( () => {
	Core.reset();
	global.EventSource = FakeEventSource;
	FakeEventSource.last = null;
	RemoteIpcNode.active = null;
	posted = [];
} );

// Every POST this suite makes lands in `posted`.
const capturingClient = () => ( {
	postBatch: ( messages ) => {
		posted.push( ...messages );
		return Promise.resolve( [] );
	},
} );

// How many worker mounts have gone out so far.
const mounts = () =>
	posted.filter( ( m ) => m[ VALUE ]?.name === 'connect_worker_input' )
		.length;

// A RemoteIpc on a shared exospine; its sends route through the _http fake.
function makeRemoteIpc( reader, interpreter ) {
	const node = new RemoteIpcNode();
	node.name = reader;
	node.sink = interpreter;
	node.client = capturingClient();
	node.arguments = [ reader ];
	return node;
}

// Drive a complete `connected` lease through the SseIn → CONNECTED bridge.
function dispatchConnected( node, { slot, owner = LEASE_OWNER } ) {
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] =
		`SESSION ${ HARNESS_SESSION } SLOT ${ slot } OWNER ${ owner } ` +
		'SUBSCRIPTIONS x INTERVAL 2000';
	node.sseIn._es.dispatch( 'connected', JSON.stringify( m ) );
}

function command( { from = '', to = '' } = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = from;
	m[ TO ] = to;
	m[ VALUE ] = { name: 'ls', arguments: [] };
	return m;
}

describe( 'RemoteIpcNode', () => {
	// RemoteIpc's ctor argument is its READER, not a subscription — so the
	// inherited re-point verbs must not write one over the worker address.
	it( 'setSubscribe leaves the reader it is addressed by alone', () => {
		const { interpreter } = mountExospine();
		const ipc = interpreter.makeNode( 'RemoteIpc', 'ipc-841', [
			'combined.p7',
		] );
		ipc.setSubscribe( [ 'firehose.p0' ] );
		expect( ipc.reader ).toBe( 'combined.p7' );
		expect( ipc.arguments ).toEqual( [ 'combined.p7' ] );
	} );

	// The Router brackets every tick in _http.lock()/flush() (router-node.js),
	// so N poller sends to one worker ride ONE POST — and each was dragging its
	// own identical mount.
	it( 'mounts the worker once per batch however many commands ride it', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator-hub.p0', interpreter );
		const http = Core.node( names.HTTP );

		http.lock();
		node.fill( command( { from: '_metadata' } ) );
		node.fill( command( { from: 'uptime' } ) );
		http.flush();

		expect( mounts() ).toBe( 1 );
		expect( posted ).toHaveLength( 3 );
	} );

	it( 'mounts the worker again in the next batch', () => {
		// The memo is keyed to the batch, not to the node: a later tick must
		// re-mount, or its command routes to a graph that never mounted one.
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator-hub.p0', interpreter );
		const http = Core.node( names.HTTP );

		http.lock();
		node.fill( command( { from: '_metadata' } ) );
		http.flush();
		http.lock();
		node.fill( command( { from: 'uptime' } ) );
		http.flush();

		expect( mounts() ).toBe( 2 );
	} );

	it( 'is registered at the runtime level so the console resolves it via make_node', () => {
		expect( CommandInterpreterNode.includeNodes.RemoteIpc ).toBe(
			RemoteIpcNode
		);
	} );

	it( 'extends RemoteLink and owns a patron-registered `<name>:sse-in`', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		expect( node ).toBeInstanceOf( RemoteLinkNode );
		node.fill( command() );
		expect( node.sseIn ).toBeInstanceOf( SseInNode );
		expect( node.sseIn.sink ).toBe( node.sink );
		expect( Core.node( 'aggregator.p0:sse-in' ) ).toBe( node.sseIn );
		expect( node.sseIn.patron ).toBe( node );
	} );

	it( 'takes its `:sse-in` out of the table on teardown, leaving the name free', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'indigo-ipc-731', interpreter );
		node.fill( command() );
		expect( Core.node( 'indigo-ipc-731:sse-in' ) ).not.toBe( null );
		node.removeNode();
		expect( Core.node( 'indigo-ipc-731:sse-in' ) ).toBe( null );
	} );

	it( 'a palette make preserves a distinct reader across dumpConfig replay and routes through it', () => {
		const { interpreter } = mountExospine();
		interpreter.dispatch( 'make_node', [
			'RemoteIpc',
			'violet-ipc-947',
			'combined.p7',
		] );
		interpreter.dispatch( 'connect_node', [
			'violet-ipc-947',
			'cerulean-replies-619',
		] );
		const first = Core.node( 'violet-ipc-947' );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=combined.p7' );
		const config = first.dumpConfig();
		expect( config ).toBe(
			'make_node RemoteIpc violet-ipc-947 combined.p7\n' +
				'connect_node violet-ipc-947 cerulean-replies-619\n'
		);
		first.removeNode();

		for ( const line of config.trim().split( '\n' ) ) {
			const [ verb, ...args ] = line.split( ' ' );
			interpreter.dispatch( verb, args );
		}
		const reopened = Core.node( 'violet-ipc-947' );
		Core.node( names.HTTP ).client = capturingClient();
		dispatchConnected( reopened, { slot: 13 } );
		reopened.fill( command( { from: names.OUTPUT } ) );

		expect( reopened.arguments ).toEqual( [ 'combined.p7' ] );
		expect( reopened.target ).toBe( 'cerulean-replies-619' );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=combined.p7' );
		expect( posted[ 0 ][ FROM ] ).toBe( 'violet-ipc-947' );
		expect( posted[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'connect_worker_input',
			arguments: [ 'combined.p7' ],
		} );
		expect( posted[ 1 ][ TO ] ).toBe( 'combined.p7' );
		expect( posted[ 1 ][ FROM ] ).toBe(
			`${ names.SSE }:${ HARNESS_SESSION }/${ names.OUTPUT }`
		);
	} );

	it( 'declares its required reader and address-channel canvas ports', () => {
		const schema = RemoteIpcNode.nodeSchema();
		expect( schema.arguments ).toEqual( [
			{
				name: 'reader',
				type: 'string',
				required: true,
				description: 'Remote worker reader, e.g. combined.p7.',
			},
		] );
		// The Router addresses it by name; canvas does not wire its fill directly.
		expect( schema.accepts_fill ).toBe( false );
		// Its edge opens/closes the inherited RemoteLink stream lifecycle.
		expect( schema.has_target ).toBe( true );
	} );

	it( 'fails make_node when the required reader is missing', () => {
		const { interpreter } = mountExospine();
		expect( () =>
			interpreter.makeNode( 'RemoteIpc', 'local-only-ipc-863' )
		).toThrow( 'Missing required argument: reader' );
		expect( Core.node( 'local-only-ipc-863' ) ).toBeNull();
	} );

	it( 'clearing arguments cannot retain a stale reader', () => {
		const { interpreter } = mountExospine();
		const node = interpreter.makeNode(
			'RemoteIpc',
			'stale-reader-ipc-349',
			[ 'jobintake.p17' ]
		);

		expect( () => {
			node.arguments = [];
		} ).toThrow( 'Missing required argument: reader' );
		expect( node.reader ).toBe( '' );
		expect( node.target ).toBe( '' );
		expect( node.sseIn ).toBeNull();
	} );

	it( 'shares the reserved `_http` + `_heartbeat` singletons across RemoteIpcs', () => {
		const { interpreter } = mountExospine();
		const a = makeRemoteIpc( 'aggregator.p0', interpreter );
		const b = makeRemoteIpc( 'combined.p0', interpreter );
		a.fill( command() );
		b.fill( command() );
		expect( Core.node( names.HTTP ) ).toBeInstanceOf( HttpOutNode );
		expect( Core.node( names.HEARTBEAT ) ).toBeInstanceOf( HeartbeatNode );
		// No per-worker child nodes (churn the shared design removes).
		expect( Core.node( 'aggregator.p0:http' ) ).toBe( null );
		expect( Core.node( 'combined.p0:heartbeat' ) ).toBe( null );
		// Both links send through the ONE `_http`; there is no per-link alias.
		expect( Core.node( names.HTTP ) ).not.toBeNull();
		expect( a.heartbeat ).toBe( b.heartbeat );
	} );

	/** command() returns null unauthenticated; the caller must not deref it. */
	it( 'is a no-op with no session, rather than throwing', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() ); // boot the link while authenticated
		const sentWhileAuthed = posted.length;
		forgetSession();

		expect( () => node.fill( command() ) ).not.toThrow();
		expect( posted.length ).toBe( sentWhileAuthed );
	} );

	it( 'leaves _http unlocked when an unauthenticated send bails', () => {
		// This node opened the lock, so it owes the flush even on the way out:
		// otherwise _http stays locked and every direct fill() buffers silently
		// until the next Router tick happens to flush it.
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() ); // boot the link while authenticated
		forgetSession();
		const http = Core.node( names.HTTP );
		expect( http.locked ).toBe( false );

		node.fill( command() );

		expect( http.locked ).toBe( false );
	} );

	it( 'does not mark the batch mounted when the mint fails', () => {
		// A mount that never reached the buffer must leave the batch unclaimed.
		// Otherwise the next send in it skips a mount that never went out, and
		// its command routes to a worker the server never attached.
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() ); // boot the link while authenticated
		const http = Core.node( names.HTTP );

		http.lock(); // the Router's bracket: outlives an individual send
		forgetSession();
		node.fill( command() ); // mint refused

		expect( http.onceInBatch( 'mount:aggregator.p0' ) ).toBe( true );
	} );

	it( 'mounts each reader in a batch that carries two different workers', () => {
		// The claim is keyed per reader, so distinct workers each still mount.
		const { interpreter } = mountExospine();
		const a = makeRemoteIpc( 'aggregator-hub.p0', interpreter );
		const b = makeRemoteIpc( 'combined.p3', interpreter );
		const http = Core.node( names.HTTP );

		http.lock();
		a.fill( command( { from: '_metadata' } ) );
		b.fill( command( { from: '_metadata' } ) );
		http.flush();

		const mounted = posted
			.filter( ( m ) => m[ VALUE ]?.name === 'connect_worker_input' )
			.map( ( m ) => m[ VALUE ].arguments[ 0 ] );
		expect( mounted ).toEqual( [ 'aggregator-hub.p0', 'combined.p3' ] );
	} );

	it( 'mounts again when _http itself is replaced', () => {
		// A rebuilt backbone is a new POST boundary, so the worker must remount.
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator-hub.p0', interpreter );
		node.fill( command( { from: '_metadata' } ) );
		const before = mounts();

		// Exactly what exospine teardown does before rebuilding the backbone.
		Core.node( names.HTTP ).removeNode();
		const fresh = new HttpOutNode();
		fresh.client = capturingClient();
		fresh.name = names.HTTP;
		node.fill( command( { from: '_metadata' } ) );

		expect( mounts() ).toBe( before + 1 );
	} );

	it( 'boots its SseIn on the first send, subscribed to its worker', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() );
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/messages/stream'
		);
		expect( FakeEventSource.last.url ).toContain(
			'subscribe=aggregator.p0'
		);
		expect( RemoteIpcNode.active ).toBe( node );
	} );

	it( 'steals the single live connection from the previous RemoteIpc', () => {
		const { interpreter } = mountExospine();
		const a = makeRemoteIpc( 'aggregator.p0', interpreter );
		a.fill( command() );
		const aEs = FakeEventSource.last;
		const b = makeRemoteIpc( 'combined.p0', interpreter );
		b.fill( command() );
		expect( aEs.closed ).toBe( true );
		expect( RemoteIpcNode.active ).toBe( b );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=combined.p0' );
	} );

	it( 'disconnecting an inactive channel preserves the active heartbeat owner', () => {
		const { interpreter } = mountExospine();
		const inactive = makeRemoteIpc( 'inactive-reader.p13', interpreter );
		inactive.fill( command() );
		const active = makeRemoteIpc( 'active-reader.p47', interpreter );
		active.fill( command() );
		dispatchConnected( active, { slot: 47 } );
		const activeStream = FakeEventSource.last;

		inactive.disconnectNode( 'unused-view-349' );

		expect( RemoteIpcNode.active ).toBe( active );
		expect( Core.node( names.HEARTBEAT ).slot ).toBe( 47 );
		expect( activeStream.closed ).toBe( false );
	} );

	it( 'bundles connect_worker_input before the command, through the shared `_http`', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() );
		expect( posted ).toHaveLength( 2 );
		expect( posted[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'connect_worker_input',
			arguments: [ 'aggregator.p0' ],
		} );
		expect( posted[ 0 ][ TO ] ).toBe( 'topologies' );
		// The mount command is minted here → stamps its own name as FROM.
		expect( posted[ 0 ][ FROM ] ).toBe( 'aggregator.p0' );
		expect( posted[ 1 ][ VALUE ] ).toMatchObject( {
			name: 'ls',
			arguments: [],
		} );
		expect( posted[ 1 ][ TO ] ).toBe( 'aggregator.p0' );
	} );

	it( 'bridges its SseIn connected slot into the shared `_heartbeat`', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() );
		dispatchConnected( node, { slot: 3 } );
		expect( Core.node( names.HEARTBEAT ).slot ).toBe( 3 );
	} );

	it( 'wraps a reply-node FROM into the session reply address, before any handshake', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command( { from: names.OUTPUT } ) );
		expect( posted[ 1 ][ FROM ] ).toBe(
			`${ names.SSE }:${ HARNESS_SESSION }/${ names.OUTPUT }`
		);
		expect( node.pid ).toBeUndefined();
	} );

	it( 'drops a command it cannot address while no session is live, naming why', () => {
		expectConsoleWarn(
			'aggregator.p0: WARNING: no command session to address its reply'
		);
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() ); // boot the link while authenticated
		const sent = posted.length;
		forgetSession();

		node.fill( command( { from: names.OUTPUT } ) );

		expect( posted ).toHaveLength( sent );
	} );

	it( 'heads an Inspector request with the session, and its reply reaches the console', () => {
		const { interpreter } = mountExospine();
		const replies = [];
		const output = new Node();
		output.name = names.OUTPUT;
		output.fill = ( m ) => replies.push( m[ VALUE ] );
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		const request = newMessage();
		request[ TYPE ] = TM_REQUEST;
		request[ FROM ] = names.OUTPUT;
		request[ TO ] = 'request-builder';
		request[ VALUE ] = 'GET_HEALTH';

		node.fill( request );

		const sent = posted.find( ( m ) => TM_REQUEST === m[ TYPE ] );
		expect( sent[ FROM ] ).toBe(
			`${ names.SSE }:${ HARNESS_SESSION }/${ names.OUTPUT }`
		);
		expect( sent[ TO ] ).toBe( 'aggregator.p0/request-builder' );
		dispatchConnected( node, { slot: 2 } );
		const reply = newMessage();
		reply[ TYPE ] = TM_INFO;
		reply[ FROM ] = 'aggregator.p0/request-builder';
		reply[ TO ] = names.OUTPUT;
		reply[ VALUE ] = 'health-reply-4471';
		node.sseIn._es.dispatch( 'msg', JSON.stringify( reply ) );

		expect( replies ).toContain( 'health-reply-4471' );
	} );

	it( 'heads an Inspector send with the session too', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		const send = newMessage();
		send[ TYPE ] = TM_BYTESTREAM;
		send[ FROM ] = names.OUTPUT;
		send[ TO ] = 'n1';
		send[ VALUE ] = 'payload-4471';

		node.fill( send );

		const sent = posted.find( ( m ) => TM_BYTESTREAM === m[ TYPE ] );
		expect( sent[ FROM ] ).toBe(
			`${ names.SSE }:${ HARNESS_SESSION }/${ names.OUTPUT }`
		);
	} );

	it( 'reopens a stream opened under no session once one exists, resuming where it read', async () => {
		forgetSession();
		__setAuthFetch( async () => null );
		await ensureSession();
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.connect();
		const sessionless = FakeEventSource.last;
		expect(
			new URL( sessionless.url, 'https://x.test' ).searchParams.has(
				'session'
			)
		).toBe( false );
		node.sseIn.lastPositions[ 'aggregator.p0' ] = {
			segment: 3,
			offset: 1717,
		};

		forgetSession(); // clears the backoff the refused /auth armed
		__setAuthFetch( async () => ( {
			handle: HARNESS_SESSION,
			secret: 'reauth-secret-4471',
			expires_in: 3600,
		} ) );
		await ensureSession();
		node.fill( command( { from: names.OUTPUT } ) );

		const reopened = new URL( FakeEventSource.last.url, 'https://x.test' );
		expect( FakeEventSource.last ).not.toBe( sessionless );
		expect( sessionless.closed ).toBe( true );
		expect( reopened.searchParams.get( 'session' ) ).toBe(
			HARNESS_SESSION
		);
		expect(
			JSON.parse( reopened.searchParams.get( 'positions' ) )
		).toEqual( {
			'aggregator.p0': { segment: 3, offset: 1717 },
		} );
	} );

	it( 'delivers the reply to a command sent before a reconnect', () => {
		const { interpreter } = mountExospine();
		const replies = [];
		const output = new Node();
		output.name = names.OUTPUT;
		output.fill = ( m ) => replies.push( m[ VALUE ] );
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.target = names.OUTPUT;
		node.fill( command( { from: names.OUTPUT } ) );
		const sentFrom = posted[ 1 ][ FROM ];
		dispatchConnected( node, { slot: 2 } );
		const record = newMessage();
		record[ TYPE ] = TM_INFO;
		record[ FROM ] = 'aggregator.p0';
		record[ TO ] = names.OUTPUT;
		record[ ID ] = '4:900:40';
		record[ VALUE ] = 'before-the-drop';
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( record ) );
		const dropped = FakeEventSource.last;

		node.sseIn._restart( 'watchdog' );

		const reopened = new URL( FakeEventSource.last.url, 'https://x.test' );
		expect( FakeEventSource.last ).not.toBe( dropped );
		expect( sentFrom ).toBe(
			`${ names.SSE }:${ HARNESS_SESSION }/${ names.OUTPUT }`
		);
		expect( reopened.searchParams.get( 'session' ) ).toBe(
			HARNESS_SESSION
		);
		expect(
			JSON.parse( reopened.searchParams.get( 'positions' ) )
		).toEqual( {
			'aggregator.p0': { segment: 4, offset: 940 },
		} );
		dispatchConnected( node, { slot: 2 } );
		const reply = newMessage();
		reply[ TYPE ] = TM_INFO;
		reply[ FROM ] = 'aggregator.p0';
		reply[ TO ] = names.OUTPUT;
		reply[ ID ] = '4:940:30';
		reply[ VALUE ] = 'reply-after-reconnect-4471';
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( reply ) );

		expect( replies ).toContain( 'reply-after-reconnect-4471' );
	} );

	it( 'appends a sub-node remainder to the command TO (bare reader/sub)', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command( { to: 'request-builder' } ) );
		expect( posted[ 1 ][ TO ] ).toBe( 'aggregator.p0/request-builder' );
	} );

	it( 'wraps ANY non-empty FROM into the reply address (every worker reply needs demux)', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() );
		dispatchConnected( node, { slot: 1 } );
		posted.length = 0;
		node.fill( command( { from: '_command_interpreter' } ) );
		expect( posted[ 1 ][ FROM ] ).toBe(
			`${ names.SSE }:${ HARNESS_SESSION }/_command_interpreter`
		);
	} );

	it( 'leaves an empty FROM unwrapped (no trailing-slash address)', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command( { from: '' } ) );
		expect( posted[ 1 ][ FROM ] ).toBe( '' );
	} );

	it( 're-fill on the live node does not reopen the stream (idempotent connect)', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() );
		const first = FakeEventSource.last;
		node.fill( command() );
		expect( FakeEventSource.last ).toBe( first );
	} );

	it( 'closes its stream + releases active on removeNode, leaving the shared singletons', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() );
		const es = FakeEventSource.last;
		node.removeNode();
		expect( es.closed ).toBe( true );
		expect( RemoteIpcNode.active ).toBe( null );
		// The shared boundary nodes are owned by the graph, not the link.
		expect( Core.node( names.HTTP ) ).toBeInstanceOf( HttpOutNode );
		expect( Core.node( names.HEARTBEAT ) ).toBeInstanceOf( HeartbeatNode );
		// The RemoteIpc itself is unregistered.
		expect( Core.node( 'aggregator.p0' ) ).toBe( null );
	} );

	it( 'clears the shared slot on removeNode only when it was the active link', () => {
		const { interpreter } = mountExospine();
		const a = makeRemoteIpc( 'aggregator.p0', interpreter );
		const b = makeRemoteIpc( 'combined.p0', interpreter );
		a.fill( command() );
		b.fill( command() ); // b steals active
		dispatchConnected( b, { slot: 5 } );
		// Removing the NON-active `a` must not clear b's live slot.
		a.removeNode();
		expect( Core.node( names.HEARTBEAT ).slot ).toBe( 5 );
	} );
} );
