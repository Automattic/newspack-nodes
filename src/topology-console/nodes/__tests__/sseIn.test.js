/**
 * SseIn node tests — the `_sse` console node. It is the runtime SseConnector
 * named for the console graph: opens an EventSource, snoops the `connected`
 * envelope for `pid()`, and fills each parsed positional Message into its sink
 * (`_router`, NOT the Dumper). A thin subclass so the published runtime keeps
 * its generic SseConnector primitive.
 */

import { SseIn } from '../sseIn';
import { SseConnector } from '../../../runtime/sse_connector';
import { Node } from '../../../runtime/node';
import {
	newMessage,
	TYPE,
	KEY,
	VALUE,
	TM_INFO,
} from '../../../runtime/message';

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
	global.EventSource = FakeEventSource;
} );

function makeSseIn() {
	const sse = new SseIn( {
		subscribe: [ 'demo.p0' ],
		interval: 5000,
		baseUrl: '/wp-json/',
		nonce: 'NONCE',
	} );
	const router = new Node();
	const routed = [];
	router.fill = ( m ) => routed.push( m );
	sse.sink = router;
	return { sse, routed };
}

describe( 'SseIn', () => {
	it( 'is a SseConnector (the runtime primitive keeps its name)', () => {
		const { sse } = makeSseIn();
		expect( sse ).toBeInstanceOf( SseConnector );
	} );

	it( 'forwards each parsed SSE message into the sink (the router)', () => {
		const { sse, routed } = makeSseIn();
		sse.start();
		const m = newMessage();
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
} );
