/**
 * RemoteLinkNode tests — the full-duplex "be the browser" SSE+HTTP channel base.
 *
 * A single node that composes the three children every SSE dashboard + the
 * console worker-pivot used to wire by hand: a SseIn (inbound stream), an HttpOut
 * (outbound commands), and a Heartbeat (slot keepalive), plus the
 * `connected → slot` bridge between them. Dashboards make ONE RemoteLink instead
 * of three nodes; RemoteIpc extends it with the worker-relay send + single-conn
 * steal. Mirrors the PHP Remote_Source patron (which owns SSE_In + HTTP_Out); the
 * durable offsetlog stays a PHP-only `Remote_Source extends Remote_Link` concern.
 */

import { RemoteLinkNode } from '../remote-link';
import { SseInNode } from '../sse-in-node';
import { HttpOutNode } from '../http-out-node';
import { HeartbeatNode } from '../heartbeat-node';
import { CommandInterpreterNode } from '../command-interpreter-node';
import { Core } from '../core';
import { mountExospine } from '../exospine';
import { newMessage, TYPE, FROM, TO, VALUE, TM_COMMAND } from '../message';

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

describe( 'RemoteLinkNode', () => {
	it( 'composes + registers three named children on connect', () => {
		const { link } = makeLink();
		link.connect();
		expect( Core.node( 'dash:link:sse-in' ) ).toBeInstanceOf( SseInNode );
		expect( Core.node( 'dash:link:http' ) ).toBeInstanceOf( HttpOutNode );
		expect( Core.node( 'dash:link:heartbeat' ) ).toBeInstanceOf(
			HeartbeatNode
		);
	} );

	it( 'subscribes its SseIn to the configured topic, forwarding to the link sink/target', () => {
		const { link } = makeLink( 'errors' );
		link.connect();
		const sse = Core.node( 'dash:link:sse-in' );
		expect( sse.subscribe ).toEqual( [ 'errors' ] );
		expect( sse.sink ).toBe( link.sink );
		expect( sse.target ).toBe( 'dash:view' );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=errors' );
	} );

	it( 'points its Heartbeat at the workers CI via its own HttpOut', () => {
		const { link } = makeLink();
		link.connect();
		expect( Core.node( 'dash:link:heartbeat' ).target ).toBe(
			'dash:link:http/workers'
		);
	} );

	it( 'bridges the SseIn connected slot into its Heartbeat', () => {
		const { link } = makeLink();
		link.connect();
		Core.node( 'dash:link:sse-in' ).setState( 'connected', {
			pid: 7,
			slot: 3,
			partition: 1,
		} );
		expect( Core.node( 'dash:link:heartbeat' ).slot ).toBe( 3 );
		expect( Core.node( 'dash:link:heartbeat' ).partition ).toBe( 1 );
	} );

	it( 'delegates pid() to its composed SseIn', () => {
		const { link } = makeLink();
		link.connect();
		Core.node( 'dash:link:sse-in' ).setState( 'connected', {
			pid: 4242,
			slot: 0,
		} );
		expect( link.pid() ).toBe( 4242 );
	} );

	it( 'routes send() out through its own HttpOut with the address intact', () => {
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

	it( 'clears the Heartbeat slot on close', () => {
		const { link } = makeLink();
		link.connect();
		const hb = Core.node( 'dash:link:heartbeat' );
		hb.setSlot( 5, 0 );
		link.close();
		expect( hb.slot ).toBe( null );
		expect( FakeEventSource.last.closed ).toBe( true );
	} );

	it( 'pid() is null before connect (no SseIn yet)', () => {
		const { link } = makeLink();
		expect( link.pid() ).toBe( null );
	} );

	it( 'ensureChildren is idempotent — a second connect reuses the children', () => {
		const { link } = makeLink();
		link.connect();
		const sse = Core.node( 'dash:link:sse-in' );
		link.connect(); // must not throw a name collision
		expect( Core.node( 'dash:link:sse-in' ) ).toBe( sse );
	} );

	it( 'removeNode tears down all three children', () => {
		const { link } = makeLink();
		link.connect();
		link.removeNode();
		expect( Core.node( 'dash:link:sse-in' ) ).toBe( null );
		expect( Core.node( 'dash:link:http' ) ).toBe( null );
		expect( Core.node( 'dash:link:heartbeat' ) ).toBe( null );
	} );

	it( 'removeNode closes the live EventSource (teardown is self-sufficient)', () => {
		const { link } = makeLink();
		link.connect();
		const es = FakeEventSource.last;
		link.removeNode();
		expect( es.closed ).toBe( true );
	} );
} );
