/**
 * RemoteIpcNode tests — the per-worker interactive command channel.
 *
 * One RemoteIpc per active worker, named `{topology}.p{N}`. It EXTENDS RemoteLink
 * (composing a SseIn + HttpOut + Heartbeat + the connected→slot bridge), adding
 * the worker-relay send + the single live-connection steal. A send boots/steals
 * the single live EventSource (closing whichever RemoteIpc held it — the same swap
 * the console does when the cwd changes worker), then routes `[connect_worker_input
 * → topologies, command → {bare reader}]` through its OWN HttpOut as ONE POST.
 * The reply-node FROM wrap (`_sse:{pid}/{node}`) — the server's HTTP_Filter wire
 * contract — lives here now.
 */

import { RemoteIpcNode } from '../remote-ipc';
import { RemoteLinkNode } from '../remote-link';
import { SseInNode } from '../sse-in-node';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { mountExospine } from '../exospine';
import { Core } from '../core';
import { newMessage, TYPE, FROM, TO, VALUE, TM_COMMAND } from '../message';
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

beforeEach( () => {
	Core.reset();
	global.EventSource = FakeEventSource;
	RemoteIpcNode.active = null;
} );

// A RemoteIpc named for `reader`, wired to the exospine interpreter (the real
// graph routes its sends through its OWN composed HttpOut, whose client is a
// capturing fake — sends land in `posted`).
function makeRemoteIpc( reader ) {
	const { interpreter } = mountExospine();
	const posted = [];
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
	return { node, posted };
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

	it( 'composes via RemoteLink (instanceof RemoteLinkNode, owns a SseIn)', () => {
		const { node } = makeRemoteIpc( 'aggregator.p0' );
		expect( node ).toBeInstanceOf( RemoteLinkNode );
		node.fill( command() );
		expect( node.sseIn ).toBeInstanceOf( SseInNode );
		expect( node.sseIn.sink ).toBe( node.sink );
	} );

	it( 'boots its SseIn on the first send, subscribed to its worker', () => {
		const { node } = makeRemoteIpc( 'aggregator.p0' );
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
		const a = makeRemoteIpc( 'aggregator.p0' );
		a.node.fill( command() );
		const aEs = FakeEventSource.last;
		const b = makeRemoteIpc( 'combined.p0' );
		b.node.fill( command() );
		expect( aEs.closed ).toBe( true );
		expect( RemoteIpcNode.active ).toBe( b.node );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=combined.p0' );
	} );

	it( 'bundles connect_worker_input before the command, through its own HttpOut', () => {
		const { node, posted } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command() );
		expect( posted ).toHaveLength( 2 );
		expect( posted[ 0 ][ VALUE ] ).toEqual( {
			name: 'connect_worker_input',
			arguments: 'aggregator.p0',
		} );
		expect( posted[ 0 ][ TO ] ).toBe( 'topologies' );
		expect( posted[ 1 ][ VALUE ] ).toEqual( { name: 'ls', arguments: '' } );
		expect( posted[ 1 ][ TO ] ).toBe( 'aggregator.p0' );
	} );

	it( 'wraps a reply-node FROM into the private _sse:{pid} pivot (pid from its SseIn)', () => {
		const { node, posted } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command() );
		node.sseIn.setState( 'connected', { pid: 4242, slot: 1 } );
		posted.length = 0;
		node.fill( command( { from: names.OUTPUT } ) );
		expect( posted[ 1 ][ FROM ] ).toBe(
			`${ names.SSE }:4242/${ names.OUTPUT }`
		);
	} );

	it( 'delegates pid() to its composed SseIn', () => {
		const { node } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command() );
		node.sseIn.setState( 'connected', { pid: 99, slot: 0 } );
		expect( node.pid() ).toBe( 99 );
	} );

	it( 'appends a sub-node remainder to the command TO (bare reader/sub)', () => {
		const { node, posted } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command( { to: 'request-builder' } ) );
		expect( posted[ 1 ][ TO ] ).toBe( 'aggregator.p0/request-builder' );
	} );

	it( 'leaves a non-reply FROM untouched (no pivot wrap)', () => {
		const { node, posted } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command( { from: '_command_interpreter' } ) );
		expect( posted[ 1 ][ FROM ] ).toBe( '_command_interpreter' );
	} );

	it( 're-fill on the live node does not reopen the stream (idempotent connect)', () => {
		const { node } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command() );
		const first = FakeEventSource.last;
		node.fill( command() );
		expect( FakeEventSource.last ).toBe( first );
	} );

	it( 'tears down its composed children + releases the active claim on removeNode', () => {
		const { node } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command() );
		expect( Core.node( 'aggregator.p0:sse-in' ) ).toBeInstanceOf(
			SseInNode
		);
		node.removeNode();
		expect( Core.node( 'aggregator.p0:sse-in' ) ).toBe( null );
		expect( RemoteIpcNode.active ).toBe( null );
	} );
} );
