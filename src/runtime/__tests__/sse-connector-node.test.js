import { SseConnectorNode } from '../sse-connector-node';
import { Node } from '../node';
import { Core } from '../core';
import {
	TYPE,
	KEY,
	VALUE,
	TM_INFO,
	TM_BYTESTREAM,
	newMessage,
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

// Build a configured SseConnector via the no-arg ctor + arguments= setter
// (Task 10 migration). The `subscribe` token is the comma-joined topic list.
function makeConnector( {
	subscribe = [ 'x' ],
	baseUrl = '/',
	nonce = 'n',
} = {} ) {
	const s = new SseConnectorNode();
	s.arguments = `${ subscribe.join( ',' ) } ${ baseUrl } ${ nonce }`;
	// The connector forwards every parsed frame, so it always has a sink in
	// production; default to a no-op (the forwarding test overrides it).
	s.sink = { fill: () => {} };
	return s;
}

test( 'start opens an EventSource with the right URL', () => {
	const s = makeConnector( {
		subscribe: [ 'firehose', 'errors' ],
		baseUrl: 'https://example.test/wp-json/',
		nonce: 'NONCE',
	} );
	s.start();
	expect( FakeEventSource.last.url ).toBe(
		'https://example.test/wp-json/newspack-nodes/v1/messages/stream?subscribe=firehose%2Cerrors&_wpnonce=NONCE'
	);
} );

test( 'start omits the positions param when none is set (default tail-seek)', () => {
	const s = makeConnector();
	s.start();
	expect( FakeEventSource.last.url ).not.toContain( 'positions=' );
} );

test( 'start appends positions as an encoded JSON blob when set', () => {
	// The dashboards seed a per-subscription start/end (or {seg,off}) so the
	// server's open_subscription seeks there instead of tailing the end.
	const s = makeConnector( {
		subscribe: [ 'topicprobe.p0' ],
		baseUrl: '/',
		nonce: 'n',
	} );
	const positions = { 'topicprobe.p0': { 0: 'start' } };
	s.positions = positions;
	s.start();
	expect( FakeEventSource.last.url ).toContain(
		`&positions=${ encodeURIComponent( JSON.stringify( positions ) ) }`
	);
} );

test( 'an empty positions object is not appended (it would just tail-seek anyway)', () => {
	const s = makeConnector();
	s.positions = {};
	s.start();
	expect( FakeEventSource.last.url ).not.toContain( 'positions=' );
} );

test( 'msg event with TM_INFO + KEY=connected stores pid via setState', () => {
	const s = makeConnector();
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

	const s = makeConnector();
	s.sink = sink;
	s.start();

	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ VALUE ] = 'data line';
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ VALUE ] ).toBe( 'data line' );
} );

test( 'a malformed typeless frame is dropped at ingress and warns (no router noise on disconnect)', () => {
	// During a container restart the stream can flush a partial/empty frame;
	// unpack() turns anything non-canonical into a pristine, typeless Message.
	// Every real frame carries a type flag, so a typeless one is malformed —
	// drop it at the boundary (a forward only earns a router "message not
	// addressed - TYPE_UNKNOWN" drop) and make noise so the bug is visible.
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const s = makeConnector();
	s.sink = sink;
	s.start();

	FakeEventSource.last.dispatch( 'msg', '' ); // empty frame
	FakeEventSource.last.dispatch( 'msg', 'not json at all' ); // garbage
	FakeEventSource.last.dispatch( 'msg', '[]' ); // short array → newMessage()

	expect( got ).toEqual( [] );
	expect( warn ).toHaveBeenCalledWith(
		'SseConnectorNode: dropped a malformed typeless SSE frame'
	);
	warn.mockRestore();
} );

test( 'a late msg frame after close() is dropped (stale stream never forwards)', () => {
	// On teardown the graph nodes are removed; a frame the closed EventSource
	// still delivers (a late callback, or a test double that keeps listeners)
	// must not reach the torn-down sink — fill() throws on a null sink.
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const s = makeConnector();
	s.sink = sink;
	s.start();
	const source = FakeEventSource.last;
	s.close();

	const m = newMessage();
	m[ VALUE ] = 'late line';
	expect( () => source.dispatch( 'msg', JSON.stringify( m ) ) ).not.toThrow();
	expect( got ).toHaveLength( 0 );
} );

// --- Connection liveness (drives every SSE dashboard's "Xs ago") ---------
// The connector is the one node that sees EVERY inbound frame — data rows AND
// the server's idle heartbeats — so it owns "when did the stream last show
// life". Dashboards read this for their staleness indicator, which must reset
// on a heartbeat (a healthy-but-idle stream) and only climb on a real drop.

test( 'lastEventTime starts null (no frame seen yet)', () => {
	const s = makeConnector();
	expect( s.lastEventTime ).toBeNull();
} );

test( 'a msg frame stamps lastEventTime', () => {
	const s = makeConnector();
	s.start();
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ VALUE ] = 'data line';
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	expect( typeof s.lastEventTime ).toBe( 'number' );
} );

test( 'a heartbeat event stamps lastEventTime even with no data frames', () => {
	const s = makeConnector();
	s.start();
	FakeEventSource.last.dispatch( 'heartbeat', JSON.stringify( { ts: 1.5 } ) );
	expect( typeof s.lastEventTime ).toBe( 'number' );
} );

test( 'close() clears lastEventTime (a closed/paused stream shows no staleness)', () => {
	const s = makeConnector();
	s.start();
	FakeEventSource.last.dispatch( 'heartbeat', JSON.stringify( { ts: 1.5 } ) );
	expect( typeof s.lastEventTime ).toBe( 'number' );
	s.close();
	expect( s.lastEventTime ).toBeNull();
} );

test( 'close() closes the EventSource', () => {
	const s = makeConnector();
	s.start();
	s.close();
	expect( FakeEventSource.last.closed ).toBe( true );
} );

test( 'close() forgets the session pid so a reopen does not report a stale one', () => {
	const s = makeConnector();
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
	const s = makeConnector();
	s.start();
	const first = FakeEventSource.last;
	s.start();
	const second = FakeEventSource.last;
	expect( first ).not.toBe( second );
	expect( first.closed ).toBe( true );
} );

describe( 'SseConnector — no-arg ctor + schema-driven arguments', () => {
	test( 'constructs with no args and exposes safe-default config fields', () => {
		const s = new SseConnectorNode();
		expect( s.subscribe ).toEqual( [] );
		expect( s.baseUrl ).toBe( '' );
		expect( s.nonce ).toBe( '' );
	} );

	test( 'declares a node schema with three positional arguments', () => {
		const schema = SseConnectorNode.nodeSchema();
		expect( schema.arguments.map( ( a ) => a.name ) ).toEqual( [
			'subscribe',
			'baseUrl',
			'nonce',
		] );
	} );

	test( 'declares accepts_fill:false (pure network-ingress source)', () => {
		expect( SseConnectorNode.nodeSchema().accepts_fill ).toBe( false );
	} );

	test( 'arguments setter parses the three tokens and splits subscribe on commas', () => {
		const s = new SseConnectorNode();
		s.arguments = 'firehose,errors https://example.test/wp-json/ NONCE';
		expect( s.subscribe ).toEqual( [ 'firehose', 'errors' ] );
		expect( s.baseUrl ).toBe( 'https://example.test/wp-json/' );
		expect( s.nonce ).toBe( 'NONCE' );
	} );

	test( 'arguments getter returns the raw string for dump_config round-trip', () => {
		const s = new SseConnectorNode();
		s.arguments = 'firehose,errors https://example.test/wp-json/ NONCE';
		expect( s.arguments ).toBe(
			'firehose,errors https://example.test/wp-json/ NONCE'
		);
	} );

	test( 'a single-topic subscribe still parses as a one-element array', () => {
		const s = new SseConnectorNode();
		s.arguments = 'firehose / N';
		expect( s.subscribe ).toEqual( [ 'firehose' ] );
	} );

	test( 'start() opens an EventSource against the configured baseUrl + nonce', () => {
		const s = new SseConnectorNode();
		s.arguments = 'firehose,errors https://example.test/wp-json/ NONCE';
		s.start();
		expect( FakeEventSource.last.url ).toBe(
			'https://example.test/wp-json/newspack-nodes/v1/messages/stream?subscribe=firehose%2Cerrors&_wpnonce=NONCE'
		);
	} );
} );
