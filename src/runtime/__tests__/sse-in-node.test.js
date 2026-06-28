/**
 * SseInNode tests — the SSE receive-ingress node (formerly the SseConnector,
 * now merged in: SseInNode extends Node directly). It opens an EventSource,
 * snoops the `connected` handshake string for `pid()` + `sessionSlot`, runs the
 * heartbeat watchdog / reconnect logic, and forwards each parsed positional
 * Message into its sink. Composed UNNAMED by RemoteLink; receive-only (inbound
 * frames route via the EventSource listener → `super.fill`).
 *
 * Lifecycle + errors surface via set_state STRING payloads (CONNECTING →
 * CONNECTED → DISCONNECTED / RECONNECTING / ERROR); every error path also
 * `printLessOften`s. The `connected` envelope is the flat `PID n SLOT n
 * SUBSCRIPTIONS csv INTERVAL n` string (no partition).
 */

import { SseInNode } from '../sse-in-node';
import { IoTelemetry, byteLength } from '../io-telemetry';
import { Core } from '../core';
import {
	newMessage,
	TYPE,
	FROM,
	ID,
	KEY,
	VALUE,
	TM_INFO,
	TM_BYTESTREAM,
	TM_ERROR,
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

// Build a configured SseIn via the no-arg ctor + arguments= setter. The
// `subscribe` token is the comma-joined topic list; `routed` captures forwards.
function makeSseIn( { subscribe = [ 'x' ], baseUrl = '/', nonce = 'n' } = {} ) {
	const sse = new SseInNode();
	sse.arguments = `${ subscribe.join( ',' ) } ${ baseUrl } ${ nonce }`;
	const routed = [];
	sse.sink = { fill: ( m ) => routed.push( [ ...m ] ) };
	return { sse, routed };
}

// The flat `connected` envelope string the server now sends (TM_INFO values are
// strings); SseIn splits it chunk-by-2 into sessionPid / sessionSlot.
const connectedRaw = ( { pid = 7777, slot = 3 } = {} ) =>
	`PID ${ pid } SLOT ${ slot } SUBSCRIPTIONS x INTERVAL 2000`;
function connectedFrame( opts ) {
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] = connectedRaw( opts );
	return JSON.stringify( m );
}

test( 'start opens an EventSource with the right URL', () => {
	const { sse } = makeSseIn( {
		subscribe: [ 'firehose', 'errors' ],
		baseUrl: 'https://example.test/wp-json/',
		nonce: 'NONCE',
	} );
	sse.start();
	expect( FakeEventSource.last.url ).toBe(
		'https://example.test/wp-json/newspack-nodes/v1/messages/stream?subscribe=firehose%2Cerrors&_wpnonce=NONCE'
	);
} );

test( 'records bytesRead + largestMsgSent for each received frame', () => {
	const { sse } = makeSseIn();
	sse.start();
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ KEY ] = 'k';
	m[ VALUE ] = 'hello';
	const data = JSON.stringify( m );
	FakeEventSource.last.dispatch( 'msg', data );
	expect( sse.bytesRead ).toBe( byteLength( data ) );
	expect( sse.largestMsgSent ).toBe( byteLength( data ) );
} );

test( 'start omits the positions param when none is set (default tail-seek)', () => {
	const { sse } = makeSseIn();
	sse.start();
	expect( FakeEventSource.last.url ).not.toContain( 'positions=' );
} );

test( 'start appends positions as an encoded JSON blob when set', () => {
	// The dashboards seed a per-subscription start/end (or {seg,off}) so the
	// server's open_subscription seeks there instead of tailing the end.
	const { sse } = makeSseIn( {
		subscribe: [ 'topicprobe.p0' ],
		baseUrl: '/',
		nonce: 'n',
	} );
	// Flat { <concrete-dir>: pos } seed — the dir name is the unique key.
	const positions = { 'topicprobe.p0': 'start' };
	sse.positions = positions;
	sse.start();
	expect( FakeEventSource.last.url ).toContain(
		`&positions=${ encodeURIComponent( JSON.stringify( positions ) ) }`
	);
} );

test( 'an empty positions object is not appended (it would just tail-seek anyway)', () => {
	const { sse } = makeSseIn();
	sse.positions = {};
	sse.start();
	expect( FakeEventSource.last.url ).not.toContain( 'positions=' );
} );

test( 'start() reports CONNECTING with the subscription csv', () => {
	const { sse } = makeSseIn( { subscribe: [ 'a', 'b' ] } );
	sse.start();
	expect( sse.setStateCache.CONNECTING ).toBe( 'a,b' );
} );

test( 'a connected handshake records the SSE connect time in IoTelemetry', () => {
	IoTelemetry.markSseDisconnected();
	const { sse } = makeSseIn();
	sse.start();
	FakeEventSource.last.dispatch( 'msg', connectedFrame() );
	expect( IoTelemetry.snapshot().sseConnectedAt ).not.toBeNull();
} );

test( 'an EventSource-closed disconnect clears the SSE connect time', () => {
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const { sse } = makeSseIn();
	sse.start();
	FakeEventSource.last.dispatch( 'msg', connectedFrame() );
	expect( IoTelemetry.snapshot().sseConnectedAt ).not.toBeNull();
	FakeEventSource.last.dispatchError( FakeEventSource.CLOSED );
	expect( IoTelemetry.snapshot().sseConnectedAt ).toBeNull();
	warn.mockRestore();
} );

test( 'a connected envelope parses pid + slot into plain fields', () => {
	const { sse } = makeSseIn();
	sse.start();
	FakeEventSource.last.dispatch(
		'msg',
		connectedFrame( { pid: 7777, slot: 3 } )
	);
	expect( sse.pid() ).toBe( 7777 );
	expect( sse.slot() ).toBe( 3 );
} );

test( 'the connected envelope is cached as the raw CONNECTED state string', () => {
	const { sse } = makeSseIn();
	sse.start();
	const raw = connectedRaw( { pid: 7777, slot: 3 } );
	FakeEventSource.last.dispatch(
		'msg',
		connectedFrame( { pid: 7777, slot: 3 } )
	);
	expect( sse.setStateCache.CONNECTED ).toBe( raw );
} );

test( 'a connected envelope with no PID sets ERROR state and warns', () => {
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const { sse } = makeSseIn();
	sse.start();
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] = 'SLOT 1 SUBSCRIPTIONS x INTERVAL 2000';
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	expect( sse.pid() ).toBeNull();
	expect( sse.setStateCache.ERROR ).toContain( 'missing PID' );
	// A malformed handshake must NOT report CONNECTED (don't clobber the ERROR).
	expect( sse.setStateCache.CONNECTED ).toBeUndefined();
	expect( warn ).toHaveBeenCalledWith(
		expect.stringContaining( 'connected envelope missing PID' )
	);
	warn.mockRestore();
} );

test( 'msg event forwards parsed message into sink', () => {
	const { sse, routed } = makeSseIn();
	sse.start();
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ VALUE ] = 'data line';
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	expect( routed ).toHaveLength( 1 );
	expect( routed[ 0 ][ VALUE ] ).toBe( 'data line' );
} );

test( 'a malformed typeless frame is dropped at ingress, sets ERROR, and warns', () => {
	// During a container restart the stream can flush a partial/empty frame;
	// unpack() turns anything non-canonical into a pristine, typeless Message.
	// Every real frame carries a type flag, so a typeless one is malformed —
	// drop it at the boundary and make noise so the bug is visible.
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const { sse, routed } = makeSseIn();
	sse.start();

	FakeEventSource.last.dispatch( 'msg', '' ); // empty frame
	FakeEventSource.last.dispatch( 'msg', 'not json at all' ); // garbage
	FakeEventSource.last.dispatch( 'msg', '[]' ); // short array → newMessage()

	expect( routed ).toEqual( [] );
	expect( sse.setStateCache.ERROR ).toBe( 'malformed typeless frame' );
	expect( warn ).toHaveBeenCalledWith(
		'ERROR: SseInNode: dropped a malformed typeless SSE frame'
	);
	warn.mockRestore();
} );

test( 'a TM_ERROR frame sets ERROR state, warns, and is still forwarded', () => {
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const { sse, routed } = makeSseIn();
	sse.start();
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM | TM_ERROR;
	m[ VALUE ] = 'boom';
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	expect( sse.setStateCache.ERROR ).toBe( 'boom' );
	expect( warn ).toHaveBeenCalledWith(
		'ERROR: SseInNode: stream error frame'
	);
	expect( routed ).toHaveLength( 1 ); // snooped, but still forwarded downstream
	warn.mockRestore();
} );

test( 'a late msg frame after close() is dropped (stale stream never forwards)', () => {
	// On teardown the graph nodes are removed; a frame the closed EventSource
	// still delivers must not reach the torn-down sink — fill() throws on a null sink.
	const { sse, routed } = makeSseIn();
	sse.start();
	const source = FakeEventSource.last;
	sse.close();

	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ VALUE ] = 'late line';
	expect( () => source.dispatch( 'msg', JSON.stringify( m ) ) ).not.toThrow();
	expect( routed ).toHaveLength( 0 );
} );

// --- Connection liveness (drives every SSE dashboard's "Xs ago") ---------
// SseIn is the one node that sees EVERY inbound frame — data rows AND the
// server's idle heartbeats — so it owns "when did the stream last show life".

test( 'lastEventTime starts null (no frame seen yet)', () => {
	const { sse } = makeSseIn();
	expect( sse.lastEventTime ).toBeNull();
} );

test( 'a msg frame stamps lastEventTime', () => {
	const { sse } = makeSseIn();
	sse.start();
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ VALUE ] = 'data line';
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	expect( typeof sse.lastEventTime ).toBe( 'number' );
} );

test( 'a heartbeat event stamps lastEventTime even with no data frames', () => {
	const { sse } = makeSseIn();
	sse.start();
	FakeEventSource.last.dispatch( 'heartbeat', JSON.stringify( { ts: 1.5 } ) );
	expect( typeof sse.lastEventTime ).toBe( 'number' );
} );

test( 'close() clears lastEventTime (a closed/paused stream shows no staleness)', () => {
	const { sse } = makeSseIn();
	sse.start();
	FakeEventSource.last.dispatch( 'heartbeat', JSON.stringify( { ts: 1.5 } ) );
	expect( typeof sse.lastEventTime ).toBe( 'number' );
	sse.close();
	expect( sse.lastEventTime ).toBeNull();
} );

test( 'close() closes the EventSource', () => {
	const { sse } = makeSseIn();
	sse.start();
	sse.close();
	expect( FakeEventSource.last.closed ).toBe( true );
} );

test( 'close() forgets the session pid so a reopen does not report a stale one', () => {
	const { sse } = makeSseIn();
	sse.start();
	FakeEventSource.last.dispatch(
		'msg',
		connectedFrame( { pid: 4242, slot: 1 } )
	);
	expect( sse.pid() ).toBe( 4242 );
	sse.close();
	// After the stream closes (e.g. cd off a worker), the old session is gone —
	// a reopen must NOT report the prior pid until a fresh `connected` arrives.
	expect( sse.pid() ).toBeNull();
} );

test( 'start() called twice closes the first EventSource before opening the second', () => {
	const { sse } = makeSseIn();
	sse.start();
	const first = FakeEventSource.last;
	sse.start();
	const second = FakeEventSource.last;
	expect( first ).not.toBe( second );
	expect( first.closed ).toBe( true );
} );

// --- Heartbeat watchdog + onerror reconnect (half-open recovery) ----------
// The browser's EventSource auto-reconnect never fires for a HALF-OPEN socket
// (worker reaped without a clean FIN): heartbeats stop, lastEventTime freezes,
// the stream is dead forever. A heartbeat-driven watchdog forces a reconnect
// after total silence — but only AFTER a grace window.

test( 'watchdog forces close+reopen after total silence past FORCE_AFTER_MS', () => {
	jest.useFakeTimers();
	try {
		expectConsoleWarn(
			'ERROR: SseInNode: reconnecting - SSE silent past timeout'
		);
		const { sse } = makeSseIn();
		sse.start();
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
		const { sse } = makeSseIn();
		sse.start();
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

test( 'onerror with readyState CLOSED reports DISCONNECTED, warns, and forces a reconnect', () => {
	jest.useFakeTimers();
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	try {
		const { sse } = makeSseIn();
		sse.start();
		const first = FakeEventSource.last;
		first.dispatchError( FakeEventSource.CLOSED );
		const second = FakeEventSource.last;
		expect( sse.setStateCache.DISCONNECTED ).toBe( 'EventSource closed' );
		expect( warn ).toHaveBeenCalledWith(
			'ERROR: SseInNode: disconnected - EventSource closed by browser'
		);
		expect( first.closed ).toBe( true );
		expect( second ).not.toBe( first );
	} finally {
		jest.useRealTimers();
		warn.mockRestore();
	}
} );

test( 'onerror with readyState CONNECTING does NOT reconnect (browser is auto-retrying)', () => {
	jest.useFakeTimers();
	try {
		const { sse } = makeSseIn();
		sse.start();
		const first = FakeEventSource.last;
		first.dispatchError( FakeEventSource.CONNECTING );
		expect( FakeEventSource.last ).toBe( first );
		expect( first.closed ).toBeUndefined();
	} finally {
		jest.useRealTimers();
	}
} );

test( 'a forced reconnect reports RECONNECTING and warns', () => {
	jest.useFakeTimers();
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	try {
		const { sse } = makeSseIn();
		sse.start();
		jest.advanceTimersByTime( 13000 );
		expect( sse.setStateCache.RECONNECTING ).toBe( 'watchdog' );
		expect( warn ).toHaveBeenCalledWith(
			'ERROR: SseInNode: reconnecting - SSE silent past timeout'
		);
	} finally {
		jest.useRealTimers();
		warn.mockRestore();
	}
} );

test( 'close() stops the watchdog (no reconnect, no throw long after close)', () => {
	jest.useFakeTimers();
	try {
		const { sse } = makeSseIn();
		sse.start();
		const first = FakeEventSource.last;
		sse.close();
		expect( () => jest.advanceTimersByTime( 60000 ) ).not.toThrow();
		expect( FakeEventSource.last ).toBe( first ); // nothing reopened
	} finally {
		jest.useRealTimers();
	}
} );

test( 'a forced reconnect with nothing tracked tail-follows — it does NOT re-replay the original seed', () => {
	jest.useFakeTimers();
	try {
		expectConsoleWarn(
			'ERROR: SseInNode: reconnecting - SSE silent past timeout'
		);
		const { sse } = makeSseIn();
		sse.positions = { x: { 0: 'start' } };
		sse.start();
		expect( FakeEventSource.last.url ).toContain( 'positions=' ); // initial replay
		// Stream goes silent (no frames → nothing to resume from); watchdog forces a reconnect.
		jest.advanceTimersByTime( 13000 );
		// Reopens LIVE (tail), not another full replay of the original 'start' seed.
		expect( FakeEventSource.last.url ).not.toContain( 'positions=' );
	} finally {
		jest.useRealTimers();
	}
} );

test( 'tracks the seg:offset from each subscription frame, exposed via resumePositions()', () => {
	const { sse } = makeSseIn( { subscribe: [ 'completed' ] } );
	sse.start();
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'completed.p0/request-builder';
	m[ ID ] = '4:623851';
	m[ VALUE ] = 'a line';
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	// Keyed by the OPAQUE concrete-partition dir name (the FROM's first segment),
	// not a parsed integer — each directory is its own unique partition.
	expect( sse.resumePositions() ).toEqual( {
		'completed.p0': { seg: 4, off: 623851 },
	} );
} );

test( 'a command-reply ID (not seg:offset) is not tracked as a position', () => {
	const { sse } = makeSseIn( { subscribe: [ 'completed' ] } );
	sse.start();
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'completed.p0/x';
	m[ ID ] = 'byckewr4dozme4rx5j1erloi1tjvmo29';
	m[ VALUE ] = {};
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	expect( sse.resumePositions() ).toBeNull();
} );

test( 'a forced reconnect RESUMES from the last tracked offset (no gap, no replay)', () => {
	jest.useFakeTimers();
	try {
		expectConsoleWarn(
			'ERROR: SseInNode: reconnecting - SSE silent past timeout'
		);
		const { sse } = makeSseIn( { subscribe: [ 'completed' ] } );
		sse.start();
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
			'completed.p1': { seg: 2, off: 500 },
		} );
	} finally {
		jest.useRealTimers();
	}
} );

test( 'removeNode() stops the watchdog and closes the stream (no reconnect after removal)', () => {
	jest.useFakeTimers();
	try {
		const { sse } = makeSseIn();
		sse.name = 'sse-test';
		sse.start();
		const first = FakeEventSource.last;
		sse.removeNode();
		expect( first.closed ).toBe( true );
		expect( () => jest.advanceTimersByTime( 20000 ) ).not.toThrow();
		expect( FakeEventSource.last ).toBe( first ); // nothing reopened post-removal
	} finally {
		jest.useRealTimers();
	}
} );

describe( 'SseIn — no-arg ctor + schema-driven arguments', () => {
	test( 'constructs with no args and exposes safe-default config fields', () => {
		const sse = new SseInNode();
		expect( sse.subscribe ).toEqual( [] );
		expect( sse.baseUrl ).toBe( '' );
		expect( sse.nonce ).toBe( '' );
	} );

	test( 'declares a node schema with three positional arguments', () => {
		const schema = SseInNode.nodeSchema();
		expect( schema.arguments.map( ( a ) => a.name ) ).toEqual( [
			'subscribe',
			'baseUrl',
			'nonce',
		] );
	} );

	// accepts_fill is a UI wireability hint: SseIn is a pure ingress source
	// composed by RemoteLink, not a drag-into target, so it's false.
	test( 'declares accepts_fill:false (pure network-ingress source)', () => {
		expect( SseInNode.nodeSchema().accepts_fill ).toBe( false );
	} );

	test( 'declares has_target:true (forwards received frames to its target)', () => {
		expect( SseInNode.nodeSchema().has_target ).toBe( true );
	} );

	test( 'describes itself as receive-only ingress', () => {
		const { description } = SseInNode.nodeSchema();
		expect( description ).toMatch( /receive/i );
		expect( description ).not.toMatch( /[Bb]idirectional/ );
	} );

	test( 'arguments setter parses the three tokens and splits subscribe on commas', () => {
		const sse = new SseInNode();
		sse.arguments = 'firehose,errors https://example.test/wp-json/ NONCE';
		expect( sse.subscribe ).toEqual( [ 'firehose', 'errors' ] );
		expect( sse.baseUrl ).toBe( 'https://example.test/wp-json/' );
		expect( sse.nonce ).toBe( 'NONCE' );
	} );

	test( 'arguments getter returns the raw string for dump_config round-trip', () => {
		const sse = new SseInNode();
		sse.arguments = 'firehose,errors https://example.test/wp-json/ NONCE';
		expect( sse.arguments ).toBe(
			'firehose,errors https://example.test/wp-json/ NONCE'
		);
	} );

	test( 'a single-topic subscribe still parses as a one-element array', () => {
		const sse = new SseInNode();
		sse.arguments = 'firehose / N';
		expect( sse.subscribe ).toEqual( [ 'firehose' ] );
	} );

	test( 'start() opens an EventSource against the configured baseUrl + nonce', () => {
		const sse = new SseInNode();
		sse.arguments = 'firehose,errors https://example.test/wp-json/ NONCE';
		sse.start();
		expect( FakeEventSource.last.url ).toBe(
			'https://example.test/wp-json/newspack-nodes/v1/messages/stream?subscribe=firehose%2Cerrors&_wpnonce=NONCE'
		);
	} );
} );
