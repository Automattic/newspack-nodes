/**
 * RemoteIpcNode tests — the per-worker interactive command channel.
 *
 * One RemoteIpc per active worker, named `{topology}.p{N}`. It EXTENDS RemoteLink
 * but overrides the child composition for the console: it owns an UNNAMED SseIn
 * (an internal per-worker stream — unregistered, so it never churns the canvas
 * layout) and SHARES the reserved-name `_http` (HttpOut) + `_heartbeat`
 * (Heartbeat) singletons with every other RemoteIpc (stable names; `/_http`
 * resolves). It adds the worker-relay send + the single live-connection steal.
 * A send boots/steals the single live EventSource (closing whichever RemoteIpc
 * held it), then routes `[connect_worker_input → topologies, command → {bare
 * reader}]` through the shared `_http` as ONE POST. The reply-node FROM wrap
 * (`_sse:{pid}/{node}`) — the server's HTTP_Filter wire contract — lives here.
 */

import { RemoteIpcNode } from '../remote-ipc-node';
import { RemoteLinkNode } from '../remote-link-node';
import { SseInNode } from '../sse-in-node';
import { HttpOutNode } from '../http-out-node';
import { HeartbeatNode } from '../heartbeat-node';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { mountExospine } from '../exospine';
import { Core } from '../core';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	KEY,
	VALUE,
	TM_COMMAND,
	TM_INFO,
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
	dispatch( name, data ) {
		( this.listeners[ name ] || [] ).forEach( ( cb ) => cb( { data } ) );
	}
}

let posted;

beforeEach( () => {
	Core.reset();
	global.EventSource = FakeEventSource;
	RemoteIpcNode.active = null;
	posted = [];
} );

// A RemoteIpc named for `reader`, wired to a shared exospine interpreter. Its
// sends route through the shared `_http` HttpOut, whose client is a capturing
// fake — sends land in the shared `posted`.
function makeRemoteIpc( reader, interpreter ) {
	const node = new RemoteIpcNode();
	node.name = reader;
	node.sink = interpreter;
	node.client = {
		postBatch: ( messages ) => {
			posted.push( ...messages );
			return Promise.resolve( [] );
		},
	};
	node.arguments = `${ reader } /wp-json/ NONCE`;
	return node;
}

// Drive a `connected` handshake frame through a node's own composed SseIn. The
// envelope is now the flat string the server sends (TM_INFO values are strings);
// SseIn splits it into sessionPid / sessionSlot and fires the CONNECTED bridge.
function dispatchConnected( node, { pid, slot } ) {
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] = `PID ${ pid } SLOT ${ slot } SUBSCRIPTIONS x INTERVAL 2000`;
	node.sseIn._es.dispatch( 'connected', JSON.stringify( m ) );
}

function command( { from = '', to = '' } = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = from;
	m[ TO ] = to;
	m[ VALUE ] = { name: 'ls', arguments: '' };
	return m;
}

describe( 'RemoteIpcNode', () => {
	it( 'is registered at the runtime level so the console resolves it via make_node', () => {
		expect( CommandInterpreterNode.includeNodes.RemoteIpc ).toBe(
			RemoteIpcNode
		);
	} );

	it( 'extends RemoteLink and owns an UNNAMED SseIn (not registered in Core)', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		expect( node ).toBeInstanceOf( RemoteLinkNode );
		node.fill( command() );
		expect( node.sseIn ).toBeInstanceOf( SseInNode );
		expect( node.sseIn.sink ).toBe( node.sink );
		// Unnamed: the old per-worker `{reader}:sse-in` node is gone.
		expect( Core.node( 'aggregator.p0:sse-in' ) ).toBe( null );
	} );

	it( 'shares the reserved `_http` + `_heartbeat` singletons across RemoteIpcs', () => {
		const { interpreter } = mountExospine();
		const a = makeRemoteIpc( 'aggregator.p0', interpreter );
		const b = makeRemoteIpc( 'combined.p0', interpreter );
		a.fill( command() );
		b.fill( command() );
		expect( Core.node( names.HTTP ) ).toBeInstanceOf( HttpOutNode );
		expect( Core.node( names.HEARTBEAT ) ).toBeInstanceOf( HeartbeatNode );
		// No per-worker child nodes (the churn the unnamed/shared design removes).
		expect( Core.node( 'aggregator.p0:http' ) ).toBe( null );
		expect( Core.node( 'combined.p0:heartbeat' ) ).toBe( null );
		expect( a.httpOut ).toBe( b.httpOut );
		expect( a.httpOut ).toBe( Core.node( names.HTTP ) );
		expect( a.heartbeat ).toBe( b.heartbeat );
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

	it( 'bundles connect_worker_input before the command, through the shared `_http`', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() );
		expect( posted ).toHaveLength( 2 );
		expect( posted[ 0 ][ VALUE ] ).toEqual( {
			name: 'connect_worker_input',
			arguments: 'aggregator.p0',
		} );
		expect( posted[ 0 ][ TO ] ).toBe( 'topologies' );
		// The mount command is minted by this node → stamps its own name as FROM.
		expect( posted[ 0 ][ FROM ] ).toBe( 'aggregator.p0' );
		expect( posted[ 1 ][ VALUE ] ).toEqual( { name: 'ls', arguments: '' } );
		expect( posted[ 1 ][ TO ] ).toBe( 'aggregator.p0' );
	} );

	it( 'bridges its SseIn connected slot into the shared `_heartbeat`', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() );
		dispatchConnected( node, { pid: 7, slot: 3 } );
		expect( Core.node( names.HEARTBEAT ).slot ).toBe( 3 );
	} );

	it( 'wraps a reply-node FROM into the private _sse:{pid} address (pid from its SseIn)', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() );
		dispatchConnected( node, { pid: 4242, slot: 1 } );
		posted.length = 0;
		node.fill( command( { from: names.OUTPUT } ) );
		expect( posted[ 1 ][ FROM ] ).toBe(
			`${ names.SSE }:4242/${ names.OUTPUT }`
		);
	} );

	it( 'delegates pid() to its composed SseIn', () => {
		const { interpreter } = mountExospine();
		const node = makeRemoteIpc( 'aggregator.p0', interpreter );
		node.fill( command() );
		dispatchConnected( node, { pid: 99, slot: 0 } );
		expect( node.pid() ).toBe( 99 );
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
		dispatchConnected( node, { pid: 4242, slot: 1 } );
		posted.length = 0;
		node.fill( command( { from: '_command_interpreter' } ) );
		expect( posted[ 1 ][ FROM ] ).toBe(
			`${ names.SSE }:4242/_command_interpreter`
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
		dispatchConnected( b, { pid: 1, slot: 5 } );
		// Removing the NON-active `a` must not clear b's live slot.
		a.removeNode();
		expect( Core.node( names.HEARTBEAT ).slot ).toBe( 5 );
	} );
} );
