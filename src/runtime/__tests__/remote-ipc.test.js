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
import { forgetSession } from '../command-auth';

const LEASE_OWNER = '9007199254740993';

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

// A RemoteIpc on a shared exospine; its sends route through the _http fake.
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
	node.arguments = [ reader ];
	return node;
}

// Drive a complete `connected` lease through the SseIn → CONNECTED bridge.
function dispatchConnected( node, { pid, slot, owner = LEASE_OWNER } ) {
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] =
		`PID ${ pid } SLOT ${ slot } OWNER ${ owner } ` +
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
		Core.node( names.HTTP ).client = {
			postBatch: ( messages ) => {
				posted.push( ...messages );
				return Promise.resolve( [] );
			},
		};
		dispatchConnected( reopened, { pid: 6262, slot: 13 } );
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
			`${ names.SSE }:6262/${ names.OUTPUT }`
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
		dispatchConnected( active, { pid: 947, slot: 47 } );
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
