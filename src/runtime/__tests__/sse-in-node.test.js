/**
 * SseInNode tests — the SSE receive-ingress node. It is the runtime SseConnector
 * (opens an EventSource, snoops the `connected` envelope for `pid()`) and forwards
 * each parsed positional Message into its sink. Composed UNNAMED by RemoteLink;
 * receive-only (no `fill()` override — inbound frames route via the connector's
 * own EventSource listener → `super.fill`).
 */

import { SseInNode } from '../sse-in-node';
import { SseConnectorNode } from '../sse-connector-node';
import { Node } from '../node';
import { Core } from '../core';
import {
	newMessage,
	TYPE,
	KEY,
	VALUE,
	TM_INFO,
	TM_BYTESTREAM,
} from '../message';

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
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
} );

function makeSseIn() {
	const sse = new SseInNode();
	sse.arguments = 'demo.p0 /wp-json/ NONCE';
	const router = new Node();
	const routed = [];
	router.fill = ( m ) => routed.push( m );
	sse.sink = router;
	return { sse, routed };
}

describe( 'SseInNode', () => {
	it( 'is a SseConnector (the runtime primitive keeps its name)', () => {
		const { sse } = makeSseIn();
		expect( sse ).toBeInstanceOf( SseConnectorNode );
	} );

	it( 'forwards each parsed SSE message into the sink (the router)', () => {
		const { sse, routed } = makeSseIn();
		sse.start();
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ VALUE ] = 'data line';
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
		expect( routed ).toHaveLength( 1 );
		expect( routed[ 0 ][ VALUE ] ).toBe( 'data line' );
	} );

	it( 'snoops the connected envelope so pid() reads it back', () => {
		const { sse } = makeSseIn();
		sse.start();
		const m = newMessage();
		m[ TYPE ] = TM_INFO;
		m[ KEY ] = 'connected';
		m[ VALUE ] = { pid: 4242, slot: 1 };
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
		expect( sse.pid() ).toBe( 4242 );
	} );

	it( 'opens the EventSource against /messages/stream with the subscription', () => {
		const { sse } = makeSseIn();
		sse.start();
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/messages/stream'
		);
		expect( FakeEventSource.last.url ).toContain( 'subscribe=demo.p0' );
	} );

	describe( 'no-arg ctor + schema-driven arguments', () => {
		it( 'constructs with no args (deps come via arguments=)', () => {
			const sse = new SseInNode();
			expect( sse.subscribe ).toEqual( [] );
			expect( sse.baseUrl ).toBe( '' );
			expect( sse.nonce ).toBe( '' );
		} );

		it( 'inherits the SseConnector schema (subscribe/baseUrl/nonce)', () => {
			const schema = SseInNode.nodeSchema();
			expect( schema.arguments.map( ( a ) => a.name ) ).toEqual( [
				'subscribe',
				'baseUrl',
				'nonce',
			] );
		} );

		// accepts_fill is a UI wireability hint: SseIn is a pure ingress source
		// composed by RemoteLink, not a drag-into target, so it's false.
		it( 'declares accepts_fill:false (pure ingress source)', () => {
			expect( SseInNode.nodeSchema().accepts_fill ).toBe( false );
		} );

		it( 'declares has_target:true (forwards received frames to its target)', () => {
			expect( SseInNode.nodeSchema().has_target ).toBe( true );
		} );

		it( 'describes itself as receive-only ingress', () => {
			const { description } = SseInNode.nodeSchema();
			expect( description ).toMatch( /receive/i );
			expect( description ).not.toMatch( /[Bb]idirectional/ );
		} );

		it( 'arguments= parses three tokens; subscribe becomes the comma-split array', () => {
			const sse = new SseInNode();
			sse.arguments = 'demo.p0,demo.p1 /wp-json/ NONCE';
			expect( sse.subscribe ).toEqual( [ 'demo.p0', 'demo.p1' ] );
			expect( sse.baseUrl ).toBe( '/wp-json/' );
			expect( sse.nonce ).toBe( 'NONCE' );
		} );

		it( 'arguments getter returns the raw string (dump_config round-trip)', () => {
			const sse = new SseInNode();
			sse.arguments = 'demo.p0 /wp-json/ NONCE';
			expect( sse.arguments ).toBe( 'demo.p0 /wp-json/ NONCE' );
		} );

		it( 'opens the EventSource using arguments-assigned config', () => {
			const sse = new SseInNode();
			sse.arguments = 'demo.p0 /wp-json/ NONCE';
			sse.start();
			expect( FakeEventSource.last.url ).toContain(
				'newspack-nodes/v1/messages/stream'
			);
			expect( FakeEventSource.last.url ).toContain( 'subscribe=demo.p0' );
		} );
	} );
} );
