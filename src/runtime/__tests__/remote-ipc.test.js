/**
 * RemoteIpcNode tests — the per-worker interactive command channel.
 *
 * One RemoteIpc per active worker, named `{topology}.p{N}`. Mirroring the PHP
 * Remote_Source_Node, it is a PATRON: it owns (composes) an SseIn for receive and
 * routes its sends through the shared `_http` boundary — it is NOT itself a
 * connector subclass. It absorbs the two halves of the old worker-pivot send
 * path: SseIn's outgoing reply-FROM wrap (`_sse:{pid}/{node}`) and HttpOut's
 * `connect_worker_input` bundling. A send boots/steals the single live
 * EventSource (closing whichever RemoteIpc held it — the same swap the console
 * does when the cwd changes worker), then routes `[connect_worker_input →
 * topologies, command → {reader}]` through `_http` as ONE POST.
 */

import { RemoteIpcNode } from '../remote-ipc';
import { SseInNode } from '../sse-in-node';
import { Node } from '../node';
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

// A RemoteIpc named for `reader`, wired to a capturing sink (stands in for the
// interpreter/router the real graph routes its `_http/…` sends through).
function makeRemoteIpc( reader ) {
	const node = new RemoteIpcNode();
	node.name = reader;
	node.arguments = `${ reader } /wp-json/ NONCE`;
	const routed = [];
	const sink = new Node();
	sink.fill = ( m ) => routed.push( m );
	node.sink = sink;
	return { node, routed };
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
	it( 'composes a SseIn for receive (patron, not a connector subclass)', () => {
		const { node } = makeRemoteIpc( 'aggregator.p0' );
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

	it( 'bundles connect_worker_input before the command, routed through _http', () => {
		const { node, routed } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command() );
		expect( routed ).toHaveLength( 2 );
		expect( routed[ 0 ][ VALUE ] ).toEqual( {
			name: 'connect_worker_input',
			arguments: 'aggregator.p0',
		} );
		expect( routed[ 0 ][ TO ] ).toBe( `${ names.HTTP }/topologies` );
		expect( routed[ 1 ][ VALUE ] ).toEqual( { name: 'ls', arguments: '' } );
		expect( routed[ 1 ][ TO ] ).toBe( `${ names.HTTP }/aggregator.p0` );
	} );

	it( 'wraps a reply-node FROM into the private _sse:{pid} pivot (pid from its SseIn)', () => {
		const { node, routed } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command() );
		node.sseIn.setState( 'connected', { pid: 4242, slot: 1 } );
		routed.length = 0;
		node.fill( command( { from: names.OUTPUT } ) );
		expect( routed[ 1 ][ FROM ] ).toBe(
			`${ names.SSE }:4242/${ names.OUTPUT }`
		);
	} );

	it( 'delegates pid() to its composed SseIn', () => {
		const { node } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command() );
		node.sseIn.setState( 'connected', { pid: 99, slot: 0 } );
		expect( node.pid() ).toBe( 99 );
	} );

	it( 'appends a sub-node remainder to the command TO', () => {
		const { node, routed } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command( { to: 'request-builder' } ) );
		expect( routed[ 1 ][ TO ] ).toBe(
			`${ names.HTTP }/aggregator.p0/request-builder`
		);
	} );

	it( 'leaves a non-reply FROM untouched (no pivot wrap)', () => {
		const { node, routed } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command( { from: '_command_interpreter' } ) );
		expect( routed[ 1 ][ FROM ] ).toBe( '_command_interpreter' );
	} );

	it( 're-fill on the live node does not reopen the stream (idempotent connect)', () => {
		const { node } = makeRemoteIpc( 'aggregator.p0' );
		node.fill( command() );
		const first = FakeEventSource.last;
		node.fill( command() );
		expect( FakeEventSource.last ).toBe( first );
	} );

	it( 'tears down its composed SseIn + releases the active claim on removeNode', () => {
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
