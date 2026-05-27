import { SseConnector } from '../sse_connector';
import { Node } from '../node';
import { Core } from '../core';
import { TYPE, KEY, VALUE, TM_INFO, newMessage } from '../message';

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

test( 'start opens an EventSource with the right URL', () => {
	const s = new SseConnector( {
		subscribe: [ 'firehose', 'errors' ],
		baseUrl: 'https://example.test/wp-json/',
		nonce: 'NONCE',
	} );
	s.start();
	expect( FakeEventSource.last.url ).toBe(
		'https://example.test/wp-json/newspack-nodes/v1/messages/stream?subscribe=firehose%2Cerrors&_wpnonce=NONCE'
	);
} );

test( 'msg event with TM_INFO + KEY=connected stores pid via setState', () => {
	const s = new SseConnector( {
		subscribe: [ 'x' ],
		baseUrl: '/',
		nonce: 'n',
	} );
	s.start();
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] = { pid: 7777, slot: 3, subscriptions: [ 'x' ] };
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	expect( s.pid() ).toBe( 7777 );
} );

test( 'msg event forwards parsed message into sink', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const s = new SseConnector( {
		subscribe: [ 'x' ],
		baseUrl: '/',
		nonce: 'n',
	} );
	s.sink = sink;
	s.start();

	const m = newMessage();
	m[ VALUE ] = 'data line';
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ VALUE ] ).toBe( 'data line' );
} );

test( 'close() closes the EventSource', () => {
	const s = new SseConnector( {
		subscribe: [ 'x' ],
		baseUrl: '/',
		nonce: 'n',
	} );
	s.start();
	s.close();
	expect( FakeEventSource.last.closed ).toBe( true );
} );

test( 'close() forgets the session pid so a reopen does not report a stale one', () => {
	const s = new SseConnector( {
		subscribe: [ 'x' ],
		baseUrl: '/',
		nonce: 'n',
	} );
	s.start();
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] = { pid: 4242, slot: 1 };
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	expect( s.pid() ).toBe( 4242 );
	s.close();
	// After the stream closes (e.g. cd off a worker), the old session is gone —
	// a reopen must NOT report the prior pid until a fresh `connected` arrives.
	expect( s.pid() ).toBeNull();
} );

test( 'start() called twice closes the first EventSource before opening the second', () => {
	const s = new SseConnector( {
		subscribe: [ 'x' ],
		baseUrl: '/',
		nonce: 'n',
	} );
	s.start();
	const first = FakeEventSource.last;
	s.start();
	const second = FakeEventSource.last;
	expect( first ).not.toBe( second );
	expect( first.closed ).toBe( true );
} );
