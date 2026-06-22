import { SseConnectorNode } from '../sse-connector-node';
import { Node } from '../node';
import { Core } from '../core';
import {
	TYPE,
	FROM,
	ID,
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
		this.readyState = FakeEventSource.CONNECTING;
		FakeEventSource.last = this;
	}
	addEventListener( name, cb ) {
		( this.listeners[ name ] ||= [] ).push( cb );
	}
	close() {
		this.closed = true;
		this.readyState = FakeEventSource.CLOSED;
	}
	dispatch( name, data ) {
		( this.listeners[ name ] || [] ).forEach( ( cb ) => cb( { data } ) );
	}
	// Drive es.onerror with a given readyState (browser CLOSED = gave up; CONNECTING = retrying).
	dispatchError( readyState ) {
		this.readyState = readyState;
		( this.listeners.error || [] ).forEach( ( cb ) => cb( {} ) );
	}
}
FakeEventSource.CONNECTING = 0;
FakeEventSource.OPEN = 1;
FakeEventSource.CLOSED = 2;

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

// --- Heartbeat watchdog + onerror reconnect (half-open recovery) ----------
// The browser's EventSource auto-reconnect never fires for a HALF-OPEN socket
// (worker reaped without a clean FIN): heartbeats stop, lastEventTime freezes,
// the stream is dead forever. A heartbeat-driven watchdog forces a reconnect
// after total silence — but only AFTER a grace window so a self-recovering
// EventSource isn't needlessly torn down.

test( 'watchdog forces close+reopen after total silence past FORCE_AFTER_MS', () => {
	jest.useFakeTimers();
	try {
		const s = makeConnector();
		s.start();
		const first = FakeEventSource.last;
		jest.advanceTimersByTime( 13000 ); // > 10s of silence, no frame ever arrived
		const second = FakeEventSource.last;
		expect( first.closed ).toBe( true );
		expect( second ).not.toBe( first );
	} finally {
		jest.useRealTimers();
	}
} );

test( 'a heartbeat during the grace window resets the clock — NO forced reconnect', () => {
	jest.useFakeTimers();
	try {
		const s = makeConnector();
		s.start();
		const first = FakeEventSource.last;
		jest.advanceTimersByTime( 7000 ); // past STALE (6s), inside grace, before FORCE (10s)
		first.dispatch( 'heartbeat', JSON.stringify( { ts: 1 } ) );
		jest.advanceTimersByTime( 5000 ); // total 12s, but only 5s since the beat
		expect( FakeEventSource.last ).toBe( first ); // never reconnected
		expect( first.closed ).toBeUndefined();
	} finally {
		jest.useRealTimers();
	}
} );

test( 'onerror with readyState CLOSED forces a reconnect (browser gave up retrying)', () => {
	jest.useFakeTimers();
	try {
		const s = makeConnector();
		s.start();
		const first = FakeEventSource.last;
		first.dispatchError( FakeEventSource.CLOSED );
		const second = FakeEventSource.last;
		expect( first.closed ).toBe( true );
		expect( second ).not.toBe( first );
	} finally {
		jest.useRealTimers();
	}
} );

test( 'onerror with readyState CONNECTING does NOT reconnect (browser is auto-retrying)', () => {
	jest.useFakeTimers();
	try {
		const s = makeConnector();
		s.start();
		const first = FakeEventSource.last;
		first.dispatchError( FakeEventSource.CONNECTING );
		expect( FakeEventSource.last ).toBe( first );
		expect( first.closed ).toBeUndefined();
	} finally {
		jest.useRealTimers();
	}
} );

test( 'close() stops the watchdog (no reconnect, no throw long after close)', () => {
	jest.useFakeTimers();
	try {
		const s = makeConnector();
		s.start();
		const first = FakeEventSource.last;
		s.close();
		expect( () => jest.advanceTimersByTime( 60000 ) ).not.toThrow();
		expect( FakeEventSource.last ).toBe( first ); // nothing reopened
	} finally {
		jest.useRealTimers();
	}
} );

test( 'a forced reconnect with nothing tracked tail-follows — it does NOT re-replay the original seed', () => {
	jest.useFakeTimers();
	try {
		const s = makeConnector();
		s.positions = { x: { 0: 'start' } };
		s.start();
		expect( FakeEventSource.last.url ).toContain( 'positions=' ); // initial replay
		// Stream goes silent (no frames seen → nothing to resume from); the watchdog
		// forces a reconnect past FORCE_AFTER_MS.
		jest.advanceTimersByTime( 13000 );
		// Reopens LIVE (tail), not another full replay of the original 'start' seed.
		expect( FakeEventSource.last.url ).not.toContain( 'positions=' );
	} finally {
		jest.useRealTimers();
	}
} );

test( 'tracks the seg:offset from each subscription frame, exposed via resumePositions()', () => {
	const s = makeConnector( { subscribe: [ 'completed' ] } );
	s.start();
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'completed.p0/request-builder';
	m[ ID ] = '4:623851';
	m[ VALUE ] = 'a line';
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	expect( s.resumePositions() ).toEqual( {
		completed: { 0: { seg: 4, off: 623851 } },
	} );
} );

test( 'a command-reply ID (not seg:offset) is not tracked as a position', () => {
	const s = makeConnector( { subscribe: [ 'completed' ] } );
	s.start();
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'completed.p0/x';
	m[ ID ] = 'byckewr4dozme4rx5j1erloi1tjvmo29';
	m[ VALUE ] = {};
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	expect( s.resumePositions() ).toBeNull();
} );

test( 'a forced reconnect RESUMES from the last tracked offset (no gap, no replay)', () => {
	jest.useFakeTimers();
	try {
		const s = makeConnector( { subscribe: [ 'completed' ] } );
		s.start();
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ FROM ] = 'completed.p1/x';
		m[ ID ] = '2:500';
		m[ VALUE ] = 'x';
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
		jest.advanceTimersByTime( 13000 ); // watchdog forces a reconnect
		const url = FakeEventSource.last.url;
		expect( url ).toContain( 'positions=' );
		const positions = JSON.parse(
			decodeURIComponent( url.split( 'positions=' )[ 1 ] )
		);
		expect( positions ).toEqual( {
			completed: { 1: { seg: 2, off: 500 } },
		} );
	} finally {
		jest.useRealTimers();
	}
} );

test( 'removeNode() stops the watchdog and closes the stream (no reconnect after removal)', () => {
	jest.useFakeTimers();
	try {
		const s = makeConnector();
		s.name = 'sse-test';
		s.start();
		const first = FakeEventSource.last;
		s.removeNode();
		expect( first.closed ).toBe( true );
		expect( () => jest.advanceTimersByTime( 20000 ) ).not.toThrow();
		expect( FakeEventSource.last ).toBe( first ); // nothing reopened post-removal
	} finally {
		jest.useRealTimers();
	}
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
