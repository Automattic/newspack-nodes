/**
 * SseInNode tests — the SSE receive-ingress node (formerly the SseConnector,
 * now merged in: SseInNode extends Node directly). It opens an EventSource,
 * snoops the `connected` handshake string for `pid()` + the complete slot
 * lease, runs the heartbeat watchdog / reconnect logic, and forwards each
 * parsed positional Message into its sink. Composed by RemoteLink as its
 * patron-owned `<patron>:sse-in`;
 * receive-only (inbound frames route via the EventSource listener →
 * `super.fill`).
 *
 * Lifecycle + errors surface via set_state STRING payloads (CONNECTING →
 * CONNECTED → DISCONNECTED / RECONNECTING / ERROR); every error path also
 * `printLessOften`s. The `connected` envelope is the flat `PID n SLOT n OWNER
 * n SUBSCRIPTIONS csv INTERVAL n` string (no partition).
 */

import { SseInNode, SEEK_START, SEEK_END } from '../sse-in-node';
import { IoTelemetry, byteLength } from '../io-telemetry';
import { Core } from '../core';
import { RouterNode } from '../router-node';
import names from '../reserved-node-names.json';
import apiFetch from '@wordpress/api-fetch';
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
	TO,
	TM_STRUCT,
	TM_COMMAND,
	TM_RESPONSE,
} from '../message';

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
		// As a real one: CONNECTING until the handshake. dispatch() completes
		// it, and a test asserting a half-open stream sets OPEN itself.
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
		// Delivering anything means the connection is established.
		this.readyState = FakeEventSource.OPEN;
		( this.listeners[ name ] || [] ).forEach( ( cb ) => cb( { data } ) );
	}
	// Drive es.onerror with a readyState (CLOSED=gave up; CONNECTING=retry).
	dispatchError( readyState ) {
		this.readyState = readyState;
		( this.listeners.error || [] ).forEach( ( cb ) => cb( {} ) );
	}
}
FakeEventSource.CONNECTING = 0;
FakeEventSource.OPEN = 1;
FakeEventSource.CLOSED = 2;

// A started node holds a real 2s watchdog; one left open outlives its test and
// reconnects inside a later fake-timer test, whose advanced clock reads as
// silence. The harness owns teardown so no test can leak one.
const live = [];
function newSseIn() {
	const sse = new SseInNode();
	live.push( sse );
	return sse;
}

beforeEach( () => {
	Core.reset();
	global.EventSource = FakeEventSource;
} );

afterEach( () => {
	// Real first: useRealTimers discards fake-scheduled watchdogs, and only the
	// real clearInterval can cancel a real one.
	jest.useRealTimers();
	live.splice( 0 ).forEach( ( sse ) => sse.close() );
} );

test( "the server's retry event sets the reopen delay we schedule", () => {
	jest.useFakeTimers();
	const { sse } = makeSseIn();
	sse.start();
	const first = FakeEventSource.last;
	const m = newMessage();
	m[ VALUE ] = '7000';
	first.dispatch( 'retry', JSON.stringify( m ) );

	// Server-initiated close: the browser would auto-retry; we own it now.
	first.dispatchError( FakeEventSource.CONNECTING );
	expect( FakeEventSource.last ).toBe( first );

	jest.advanceTimersByTime( 6999 );
	expect( FakeEventSource.last ).toBe( first );
	jest.advanceTimersByTime( 2 );
	expect( FakeEventSource.last ).not.toBe( first );
} );

test( 'a server close no longer leaves the browser to reconnect', () => {
	jest.useFakeTimers();
	const { sse } = makeSseIn();
	sse.start();
	const first = FakeEventSource.last;
	first.dispatchError( FakeEventSource.CONNECTING );

	// Closing it is what stops the browser's own retry from racing ours.
	expect( first.readyState ).toBe( FakeEventSource.CLOSED );
} );

test( 'a visible event directly reopens a stream whose hidden event was frozen', () => {
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		value: 'visible',
	} );
	const { sse } = makeSseIn( { subscribe: [ 'completed.p17' ] } );
	sse.start();
	const first = FakeEventSource.last;
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'completed.p17/request-builder';
	m[ ID ] = '23:9311:113';
	m[ VALUE ] = 'frozen-tab-cursor';
	first.dispatch( 'msg', JSON.stringify( m ) );

	// The browser froze before delivering/committing the hidden transition.
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		value: 'hidden',
	} );
	Object.defineProperty( document, 'visibilityState', {
		configurable: true,
		value: 'visible',
	} );
	document.dispatchEvent( new Event( 'visibilitychange' ) );

	const second = FakeEventSource.last;
	expect( first.closed ).toBe( true );
	expect( second ).not.toBe( first );
	const positions = JSON.parse(
		decodeURIComponent( second.url.split( 'positions=' )[ 1 ] )
	);
	expect( positions ).toEqual( {
		'completed.p17': { segment: 23, offset: 9424 },
	} );
	sse.close();
} );

test( 'a terminal EventSource failure refreshes the REST nonce before reopening', async () => {
	const previousEndpoint = apiFetch.nonceEndpoint;
	const previousMiddleware = apiFetch.nonceMiddleware;
	window.NewspackNodesData = {
		restUrl: 'https://example.test/wp-json/',
		nonce: 'STALE-NONCE-417',
	};
	apiFetch.nonceEndpoint =
		'https://example.test/wp-admin/admin-ajax.php?action=rest-nonce';
	apiFetch.nonceMiddleware = { nonce: 'STALE-NONCE-417' };
	global.fetch = jest.fn().mockResolvedValue( {
		ok: true,
		text: () => Promise.resolve( 'FRESH-NONCE-863' ),
	} );
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const sse = newSseIn();
	sse.arguments = [ 'completed.p17' ];
	try {
		sse.start();
		const first = FakeEventSource.last;

		first.dispatchError( FakeEventSource.CLOSED );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

		expect( global.fetch ).toHaveBeenCalledWith(
			apiFetch.nonceEndpoint,
			expect.objectContaining( { credentials: 'include' } )
		);
		expect( first.closed ).toBe( true );
		expect( FakeEventSource.last ).not.toBe( first );
		expect( FakeEventSource.last.url ).toContain(
			'_wpnonce=FRESH-NONCE-863'
		);
		expect( window.NewspackNodesData.nonce ).toBe( 'FRESH-NONCE-863' );
		expect( apiFetch.nonceMiddleware.nonce ).toBe( 'FRESH-NONCE-863' );
	} finally {
		sse.close();
		warn.mockRestore();
		delete global.fetch;
		delete window.NewspackNodesData;
		apiFetch.nonceEndpoint = previousEndpoint;
		apiFetch.nonceMiddleware = previousMiddleware;
	}
} );

test( 'a renewed stream gets no second nonce renewal until it connects', async () => {
	const previousEndpoint = apiFetch.nonceEndpoint;
	const previousMiddleware = apiFetch.nonceMiddleware;
	window.NewspackNodesData = {
		restUrl: 'https://example.test/wp-json/',
		nonce: 'STALE-LOOP-NONCE-319',
	};
	apiFetch.nonceEndpoint =
		'https://example.test/wp-admin/admin-ajax.php?action=rest-nonce';
	apiFetch.nonceMiddleware = { nonce: 'STALE-LOOP-NONCE-319' };
	global.fetch = jest.fn().mockResolvedValue( {
		ok: true,
		text: () => Promise.resolve( 'FRESH-LOOP-NONCE-947' ),
	} );
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const sse = newSseIn();
	sse.arguments = [ 'completed.p29' ];

	try {
		sse.start();
		FakeEventSource.last.dispatchError( FakeEventSource.CLOSED );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		expect( global.fetch ).toHaveBeenCalledTimes( 1 );

		FakeEventSource.last.dispatchError( FakeEventSource.CLOSED );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		const throttledRetry = FakeEventSource.last;
		throttledRetry.dispatchError( FakeEventSource.CLOSED );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

		expect( global.fetch ).toHaveBeenCalledTimes( 1 );
		expect( FakeEventSource.last ).toBe( throttledRetry );
	} finally {
		sse.close();
		warn.mockRestore();
		delete global.fetch;
		delete window.NewspackNodesData;
		apiFetch.nonceEndpoint = previousEndpoint;
		apiFetch.nonceMiddleware = previousMiddleware;
	}
} );

test( 'an explicitly closed stream stays closed on the next visible event', () => {
	const { sse } = makeSseIn( { subscribe: [ 'errors.p11' ] } );
	sse.start();
	const first = FakeEventSource.last;
	sse.close();
	document.dispatchEvent( new Event( 'visibilitychange' ) );
	expect( first.closed ).toBe( true );
	expect( FakeEventSource.last ).toBe( first );
} );

// Build a configured SseIn. `subscribe` is the only positional argument; the
// transport coordinates (baseUrl + nonce) are set explicitly — they no longer
// ride the make_node args, they come from the localized global by default.
test( 'a grouped stamp keys resume positions by its full offsets/<dir> key', () => {
	const { sse } = makeSseIn( {
		subscribe: [ 'offsets/combined.firehose.p0' ],
	} );
	sse.start();
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'offsets/combined.firehose.p0/producer';
	m[ ID ] = '3:100:50';
	m[ VALUE ] = 'cursor frame';
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );

	expect( sse.resumePositions() ).toEqual( {
		'offsets/combined.firehose.p0': { segment: 3, offset: 150 },
	} );
} );

function makeSseIn( { subscribe = [ 'x' ], baseUrl = '/', nonce = 'n' } = {} ) {
	const sse = newSseIn();
	sse.arguments = [ subscribe.join( ',' ) ];
	sse.baseUrl = baseUrl;
	sse.nonce = nonce;
	const routed = [];
	sse.sink = { fill: ( m ) => routed.push( [ ...m ] ) };
	return { sse, routed };
}

// Mirrors sse-in-node's module-private INITIAL_BACKOFF_MS.
const DEFAULT_REOPEN_MS = 2000;

// Owner intentionally exceeds Number.MAX_SAFE_INTEGER: it must stay a string.
const LEASE_OWNER = '9007199254740993';
const SECOND_LEASE_OWNER = '9007199254740995';

// SseIn splits the flat `connected` string into pid + the complete slot lease.
const connectedRaw = ( {
	pid = 7777,
	slot = 3,
	owner = LEASE_OWNER,
	cursors = '',
} = {} ) =>
	`PID ${ pid } SLOT ${ slot } OWNER ${ owner } SUBSCRIPTIONS x INTERVAL 2000` +
	( cursors ? ` CURSORS ${ cursors }` : '' );
function connectedFrame( opts ) {
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] = connectedRaw( opts );
	return JSON.stringify( m );
}

test( 'a server we never reached backs off instead of reopening flat', () => {
	jest.useFakeTimers();
	const { sse } = makeSseIn();
	sse.start();

	// No `retry` event ever arrives — the endpoint is down or 429ing, so the
	// only schedule we have is our own, and it has to widen.
	let stream = FakeEventSource.last;
	stream.dispatchError( FakeEventSource.CONNECTING );
	jest.advanceTimersByTime( DEFAULT_REOPEN_MS );
	expect( FakeEventSource.last ).not.toBe( stream );

	stream = FakeEventSource.last;
	stream.dispatchError( FakeEventSource.CONNECTING );
	// Still closed at the first interval: the second wait is twice as long.
	jest.advanceTimersByTime( DEFAULT_REOPEN_MS );
	expect( FakeEventSource.last ).toBe( stream );
	jest.advanceTimersByTime( DEFAULT_REOPEN_MS );
	expect( FakeEventSource.last ).not.toBe( stream );
} );

test( 'an advertised interval is used as-is and never widened', () => {
	jest.useFakeTimers();
	const { sse } = makeSseIn();
	sse.start();
	const first = FakeEventSource.last;
	const m = newMessage();
	m[ VALUE ] = '5000';
	first.dispatch( 'retry', JSON.stringify( m ) );

	first.dispatchError( FakeEventSource.CONNECTING );
	jest.advanceTimersByTime( 5000 );
	const second = FakeEventSource.last;
	expect( second ).not.toBe( first );

	// A live server's cadence is its own; two failures must not double it.
	second.dispatch( 'retry', JSON.stringify( m ) );
	second.dispatchError( FakeEventSource.CONNECTING );
	jest.advanceTimersByTime( 5000 );
	expect( FakeEventSource.last ).not.toBe( second );
} );

test( 'the connected envelope seeds positions for a zero-message stream', () => {
	const { sse } = makeSseIn();
	sse.start();
	FakeEventSource.last.dispatch(
		'connected',
		connectedFrame( { cursors: 'firehose.p0=11647:1306456' } )
	);

	// Nothing was delivered, so the ID breadcrumb never fired — without the
	// envelope's seed the reopen would tail-seek and drop the gap.
	expect( sse.resumePositions() ).toEqual( {
		'firehose.p0': { segment: 11647, offset: 1306456 },
	} );
} );

test( 'a delivered record advances past the envelope seed', () => {
	const { sse } = makeSseIn();
	sse.start();
	const stream = FakeEventSource.last;
	stream.dispatch(
		'connected',
		connectedFrame( { cursors: 'firehose.p0=11647:100' } )
	);
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'firehose.p0';
	m[ ID ] = '11647:100:40';
	m[ VALUE ] = 'a line\n';
	stream.dispatch( 'msg', JSON.stringify( m ) );

	expect( sse.resumePositions() ).toEqual( {
		'firehose.p0': { segment: 11647, offset: 140 },
	} );
} );

test( 'start opens an EventSource with the right URL', () => {
	const { sse } = makeSseIn( {
		subscribe: [ 'firehose', 'errors' ],
		baseUrl: 'https://example.test/wp-json/',
		nonce: 'NONCE',
	} );
	sse.start();
	expect( sse._es.url ).toBe(
		'https://example.test/wp-json/newspack-nodes/v1/messages/stream?subscribe=firehose%2Cerrors&_wpnonce=NONCE' +
			`&positions=${ encodeURIComponent(
				JSON.stringify( { firehose: SEEK_END, errors: SEEK_END } )
			) }`
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

// The seek this node asked for, read off the stream IT opened — not off the
// fake's static `last`, which is whatever object anyone constructed most
// recently and answers a `not.toContain` just as happily when nothing happened.
function seeksAsked( sse ) {
	const url = sse._es.url;
	expect( url ).toContain( 'positions=' );
	return JSON.parse( decodeURIComponent( url.split( 'positions=' )[ 1 ] ) );
}

// seekMap() is the whole decision, and it touches no transport — so these
// exercise it directly. Only the last test below involves an EventSource at
// all, and then only to confirm the map reaches the wire.
describe( 'seekMap — what this node asks each subscription for', () => {
	const mapFor = ( subscribe, positions = null ) => {
		const sse = newSseIn();
		sse.arguments = [ subscribe.join( ',' ) ];
		sse.positions = positions;
		return sse.seekMap();
	};

	it( 'names the tail for a subscription it has no position for', () => {
		// Same vocabulary as the PHP reader (Consumer_Node::SEEK_*): 0 start,
		// -1 end, -2 recent. Carrying "tail" by omitting the parameter is what
		// left a real {segment:0, offset:0} unable to mean the start of the log.
		expect( mapFor( [ 'x' ] ) ).toEqual( { x: SEEK_END } );
	} );

	it( 'passes a seeded sentinel through as the number it is', () => {
		expect(
			mapFor( [ 'settings.p0' ], { 'settings.p0': SEEK_START } )
		).toEqual( { 'settings.p0': 0 } );
	} );

	it( 'keeps a resumed start-of-log position instead of swallowing it', () => {
		expect(
			mapFor( [ 'firehose.p0' ], {
				'firehose.p0': { segment: 0, offset: 0 },
			} )
		).toEqual( { 'firehose.p0': { segment: 0, offset: 0 } } );
	} );

	it( 'leaves a glob to the server, which owns the concrete dir names', () => {
		expect( mapFor( [ 'firehose.*' ] ) ).toEqual( {} );
	} );

	it( 'states the tail only for the subscriptions still lacking one', () => {
		expect(
			mapFor( [ 'a.p0', 'b.p0' ], { 'a.p0': { segment: 2, offset: 7 } } )
		).toEqual( { 'a.p0': { segment: 2, offset: 7 }, 'b.p0': SEEK_END } );
	} );
} );

test( 'the seek map is what lands in the positions parameter', () => {
	const { sse } = makeSseIn( { subscribe: [ 'firehose.p0' ] } );
	sse.start();
	expect( seeksAsked( sse ) ).toEqual( sse.seekMap() );
} );

test( 'start appends positions as an encoded JSON blob when set', () => {
	// Dashboards seed a per-subscription start/end so the server seeks there.
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

test( 'an empty positions object still asks for the seek it means', () => {
	const { sse } = makeSseIn();
	sse.positions = {};
	sse.start();
	expect( seeksAsked( sse ) ).toEqual( { x: SEEK_END } );
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
	FakeEventSource.last.dispatch( 'connected', connectedFrame() );
	expect( IoTelemetry.snapshot().sseConnectedAt ).not.toBeNull();
} );

test( 'an EventSource-closed disconnect clears the SSE connect time', () => {
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const { sse } = makeSseIn();
	sse.start();
	FakeEventSource.last.dispatch( 'connected', connectedFrame() );
	expect( IoTelemetry.snapshot().sseConnectedAt ).not.toBeNull();
	FakeEventSource.last.dispatchError( FakeEventSource.CLOSED );
	expect( IoTelemetry.snapshot().sseConnectedAt ).toBeNull();
	warn.mockRestore();
} );

test( 'a connected envelope preserves a greater-than-2^53 lease owner byte-for-byte', () => {
	const { sse } = makeSseIn();
	sse.start();
	FakeEventSource.last.dispatch(
		'connected',
		connectedFrame( { pid: 7777, slot: 3, owner: LEASE_OWNER } )
	);
	expect( sse.pid() ).toBe( 7777 );
	expect( sse.slot() ).toBe( 3 );
	expect( sse.leaseOwner() ).toBe( LEASE_OWNER );
} );

/**
 * `SSE_In_Node` publishes `PID <pid> SLOT <slot>` and nothing else. The raw
 * envelope also carries OWNER — the lease token the heartbeat authenticates
 * with — and a state payload is traced to stderr, cached, and pushed to every
 * subscriber, so publishing it verbatim writes that token into the transcript
 * and the overlay's message ring on every reconnect.
 */
test( 'CONNECTED publishes the pid and slot only, never the lease owner', () => {
	const { sse } = makeSseIn();
	sse.start();
	FakeEventSource.last.dispatch(
		'connected',
		connectedFrame( { pid: 7777, slot: 3, owner: LEASE_OWNER } )
	);
	expect( sse.setStateCache.CONNECTED ).toBe( 'PID 7777 SLOT 3' );
	expect( sse.setStateCache.CONNECTED ).not.toContain( LEASE_OWNER );
	// Still snooped from the envelope — published is not the same as parsed.
	expect( sse.leaseOwner() ).toBe( LEASE_OWNER );
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
	m[ VALUE ] =
		`SLOT 1 OWNER ${ LEASE_OWNER } ` + 'SUBSCRIPTIONS x INTERVAL 2000';
	FakeEventSource.last.dispatch( 'connected', JSON.stringify( m ) );
	expect( sse.pid() ).toBeNull();
	expect( sse.setStateCache.ERROR ).toContain( 'missing PID' );
	// A malformed handshake must NOT report CONNECTED (keep the ERROR).
	expect( sse.setStateCache.CONNECTED ).toBeUndefined();
	expect( warn ).toHaveBeenCalledWith(
		expect.stringContaining( 'connected envelope missing PID' )
	);
	warn.mockRestore();
} );

test.each( [
	[ 'missing', 'PID 7777 SLOT 7 SUBSCRIPTIONS x INTERVAL 2000' ],
	[ 'zero', 'PID 7777 SLOT 7 OWNER 0 SUBSCRIPTIONS x INTERVAL 2000' ],
	[
		'negative',
		'PID 7777 SLOT 7 OWNER -42424243 SUBSCRIPTIONS x INTERVAL 2000',
	],
	[
		'leading-zero',
		'PID 7777 SLOT 7 OWNER 042424243 SUBSCRIPTIONS x INTERVAL 2000',
	],
	[
		'non-decimal',
		'PID 7777 SLOT 7 OWNER lease-42424243 SUBSCRIPTIONS x INTERVAL 2000',
	],
] )( 'a %s lease owner rejects the connected handshake', ( _case, raw ) => {
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const { sse } = makeSseIn();
	sse.start();
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] = raw;

	FakeEventSource.last.dispatch( 'connected', JSON.stringify( m ) );

	expect( sse.pid() ).toBeNull();
	expect( sse.slot() ).toBeNull();
	expect( sse.leaseOwner() ).toBeNull();
	expect( sse.setStateCache.CONNECTED ).toBeUndefined();
	expect( sse.setStateCache.ERROR ).toBe(
		'connected envelope missing or invalid OWNER'
	);
	expect( warn ).toHaveBeenCalledWith(
		'ERROR: SseInNode: connected envelope missing or invalid OWNER'
	);
	expect( warn.mock.calls.flat().join( ' ' ) ).not.toContain( raw );
	warn.mockRestore();
} );

test( 'a terminal disconnect retains its key/value reason over the generic close error', () => {
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const { sse } = makeSseIn();
	sse.start();
	const stream = FakeEventSource.last;
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'slot_lease_lost';
	m[ VALUE ] = 'SSE slot lease lost';

	stream.dispatch( 'disconnect', JSON.stringify( m ) );
	expect( sse.terminalDisconnect ).toEqual( {
		reason: 'slot_lease_lost',
		message: 'SSE slot lease lost',
	} );

	stream.dispatchError( FakeEventSource.CLOSED );

	expect( sse.setStateCache.DISCONNECTED ).toBe(
		'Server closed stream: SSE slot lease lost'
	);
	expect( warn ).toHaveBeenCalledWith(
		'ERROR: SseInNode: disconnected - Server closed stream: SSE slot lease lost'
	);
	expect( warn ).not.toHaveBeenCalledWith(
		expect.stringContaining( 'EventSource closed by browser' )
	);
	warn.mockRestore();
	sse.close();
} );

test( 'a terminal disconnect without a machine key is rejected', () => {
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const { sse } = makeSseIn();
	sse.start();
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ VALUE ] = 'Lease revoked by reviewer sentinel 7319';

	FakeEventSource.last.dispatch( 'disconnect', JSON.stringify( m ) );

	expect( sse.terminalDisconnect ).toBeNull();
	expect( sse.setStateCache.ERROR ).toBe( 'malformed disconnect envelope' );
	expect( warn ).toHaveBeenCalledWith(
		'ERROR: SseInNode: dropped a malformed disconnect envelope'
	);
	warn.mockRestore();
	sse.close();
} );

test( 'a valid in-place EventSource retry handshake clears the prior terminal reason', () => {
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const { sse } = makeSseIn();
	jest.useFakeTimers();
	try {
		sse.start();
		const stream = FakeEventSource.last;
		const terminal = newMessage();
		terminal[ TYPE ] = TM_INFO;
		terminal[ KEY ] = 'initial_lease_retired';
		terminal[ VALUE ] = 'Initial lease retired at owner handoff';
		stream.dispatch( 'disconnect', JSON.stringify( terminal ) );

		stream.dispatchError( FakeEventSource.CONNECTING );
		// The reopen is ours now, so the handshake lands on a FRESH stream.
		jest.advanceTimersByTime( DEFAULT_REOPEN_MS );
		const reopened = FakeEventSource.last;
		reopened.dispatch(
			'connected',
			connectedFrame( {
				pid: 8888,
				slot: 5,
				owner: SECOND_LEASE_OWNER,
			} )
		);
		const reusedStream = FakeEventSource.last !== stream;
		const terminalAfterHandshake = sse.terminalDisconnect;
		const callsBeforeFinalClose = warn.mock.calls.length;

		reopened.dispatchError( FakeEventSource.CLOSED );
		const finalCloseCalls = warn.mock.calls.slice( callsBeforeFinalClose );

		expect( reusedStream ).toBe( true );
		expect( terminalAfterHandshake ).toBeNull();
		expect( sse.setStateCache.DISCONNECTED ).toBe( 'EventSource closed' );
		expect( finalCloseCalls ).toContainEqual( [
			'ERROR: SseInNode: disconnected - EventSource closed by browser',
		] );
		expect( sse.setStateCache.DISCONNECTED ).not.toContain(
			'Initial lease retired'
		);
	} finally {
		sse.close();
		warn.mockRestore();
	}
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

test( 'an UNPARSEABLE frame is dropped at ingress, sets ERROR, and warns', () => {
	// unpack() hands back a fresh (untyped) message when the wire is garbage.
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const { sse, routed } = makeSseIn();
	sse.start();

	FakeEventSource.last.dispatch( 'msg', '' ); // empty frame
	FakeEventSource.last.dispatch( 'msg', 'not json at all' ); // garbage
	FakeEventSource.last.dispatch( 'msg', '[]' ); // short array → newMessage()

	expect( routed ).toEqual( [] );
	expect( sse.setStateCache.ERROR ).toBe( 'unparseable frame' );
	expect( warn ).toHaveBeenCalledWith(
		'ERROR: SseInNode: dropped an unparseable SSE frame'
	);
	warn.mockRestore();
} );

/**
 * Garbage on the wire and a well-formed frame nobody typed are DIFFERENT bugs.
 * Reporting both as one line is what left `_router: ... TYPE_UNKNOWN` unexplained
 * in the first place — the whole reason TM_UNTYPED exists.
 */
test( 'a TYPELESS frame reports differently from an unparseable one', () => {
	const warn = jest
		.spyOn( Core, 'printLessOften' )
		.mockImplementation( () => {} );
	const { sse, routed } = makeSseIn();
	sse.start();

	// Parses cleanly as a 7-field message — it simply has no TYPE.
	const typeless = newMessage();
	typeless[ TYPE ] = 0;
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( typeless ) );

	expect( routed ).toEqual( [] );
	expect( sse.setStateCache.ERROR ).toBe( 'typeless frame' );
	expect( warn ).toHaveBeenCalledWith(
		'ERROR: SseInNode: dropped a typeless SSE frame'
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
	expect( routed ).toHaveLength( 1 ); // snooped, but still forwarded
	warn.mockRestore();
} );

test( 'a late msg frame after close() is dropped (stale stream never forwards)', () => {
	// After teardown a late frame must not reach the torn-down sink.
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

// SseIn sees EVERY inbound frame (data + heartbeats), so it owns liveness.

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

test( 'close() clears the prior connection timestamp', () => {
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

test( 'close() forgets the complete session lease so a reopen cannot reuse it', () => {
	const { sse } = makeSseIn();
	sse.start();
	FakeEventSource.last.dispatch(
		'connected',
		connectedFrame( {
			pid: 4242,
			slot: 1,
			owner: LEASE_OWNER,
		} )
	);
	expect( sse.pid() ).toBe( 4242 );
	expect( sse.slot() ).toBe( 1 );
	expect( sse.leaseOwner() ).toBe( LEASE_OWNER );
	sse.close();
	// After the stream closes, a reopen must NOT report the prior lease.
	expect( sse.pid() ).toBeNull();
	expect( sse.slot() ).toBeNull();
	expect( sse.leaseOwner() ).toBeNull();
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

// A half-open socket never auto-reconnects; a heartbeat watchdog forces it.

// @longform
// The watchdog is a Timer now, not a hand-rolled setInterval: it arms through
// setTimer() and its body is fire(), so stopTimer/removeNode dispose it like
// every other timer in the graph. Unnamed, so setTimer takes an own slot —
// name the node and the same call hitchhikes the Router tick instead.
test( 'the watchdog arms through setTimer, and close() stops it', () => {
	jest.useFakeTimers();
	try {
		const { sse } = makeSseIn();
		sse.start();

		expect( sse.mode ).toBe( 'event_framework' );
		expect( sse.interval_ms ).toBe( 2000 );

		sse.close();

		expect( sse.mode ).toBe( 'inactive' );
	} finally {
		jest.useRealTimers();
	}
} );

// @longform
// Standing down while CONNECTING must be BOUNDED. A proxy that accepts the
// socket but never sends headers leaves the browser in CONNECTING firing no
// `error`, so an unbounded stand-down removes the only recovery there is and
// the tab sits dead until the browser's own network timeout, minutes later.
test( 'a stream wedged in CONNECTING is still force-reconnected eventually', () => {
	jest.useFakeTimers();
	try {
		expectConsoleWarn(
			'ERROR: SseInNode: reconnecting - SSE silent past timeout'
		);
		const { sse } = makeSseIn();
		sse.start();
		const opened = sse._es;
		sse.lastEventTime = Date.now() - 90000;
		sse._watchdogBase = Date.now() - 90000;
		opened.readyState = FakeEventSource.CONNECTING;

		sse.fire();

		expect( sse._es ).not.toBe( opened );
	} finally {
		jest.useRealTimers();
	}
} );

// @longform
// The server closes an idle stream and advertises `retry:`, so the browser sits
// in CONNECTING for that whole window. FORCE_AFTER_MS is 10s and the advertised
// gap is 15s, so the watchdog fired FIVE SECONDS before the browser's own
// reconnect — on every cycle — logging an error and doubling the backoff for a
// stream that was working exactly as designed. The watchdog exists for
// HALF-OPEN sockets (readyState OPEN, no data); a browser between connections
// is not that, which is what the `error` handler already assumes.
test( 'the watchdog stands down while the browser is reconnecting', () => {
	jest.useFakeTimers();
	try {
		const { sse } = makeSseIn();
		sse.start();
		const opened = sse._es;
		// Silent well past FORCE_AFTER_MS, but the browser owns the gap.
		sse.lastEventTime = Date.now() - 47000;
		sse._watchdogBase = Date.now() - 47000;
		opened.readyState = FakeEventSource.CONNECTING;

		sse.fire();

		// A forced reconnect replaces the EventSource; standing down keeps it.
		expect( sse._es ).toBe( opened );
	} finally {
		jest.useRealTimers();
	}
} );

// The base Timer.fire() emits a TM_BYTESTREAM timestamp down its sink. This
// node's sink is the DATA path, where that is indistinguishable from a record.
test( 'the watchdog tick emits nothing into the data sink', () => {
	jest.useFakeTimers();
	try {
		const { sse, routed } = makeSseIn();
		sse.start();
		routed.length = 0;

		// Ticks with the stream fresh: nothing to report, nothing to emit.
		sse.lastEventTime = Date.now();
		sse.fire();
		sse.fire();

		expect( routed ).toEqual( [] );
	} finally {
		jest.useRealTimers();
	}
} );

test( 'a command reply keeps its own TO; only records are re-homed', () => {
	// A subscription re-homes RECORDS to its target. A reply is already
	// addressed — the server sent it TO the node that minted the command
	// (ADR-7) — so clobbering its TO delivers it to the view instead.
	const { sse, routed } = makeSseIn();
	sse.target = 'stream-tee';
	sse.homeToTarget = true;
	sse.start();
	routed.length = 0;

	const record = newMessage();
	record[ TYPE ] = TM_STRUCT;
	record[ TO ] = '';
	record[ ID ] = '1:0:10';
	record[ VALUE ] = { x: 1 };

	const reply = newMessage();
	reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
	reply[ TO ] = 'status-receiver';
	reply[ VALUE ] = { name: 'log_status', payload: {} };

	FakeEventSource.last.dispatch( 'msg', JSON.stringify( record ) );
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( reply ) );

	expect( routed.map( ( m ) => m[ TO ] ) ).toEqual( [
		'stream-tee',
		'status-receiver',
	] );
} );

// The view used to carry a TM_COMMAND guard because replies reached it. This
// is the invariant that made that guard redundant, stated as a rule rather
// than as one case: NO reply is ever re-homed, whatever its payload holds.
test( 'no command reply is re-homed, whatever its VALUE looks like', () => {
	const { sse, routed } = makeSseIn();
	sse.target = 'stream-tee';
	sse.homeToTarget = true;
	sse.start();
	routed.length = 0;

	for ( const value of [
		{ name: 'list_logs', payload: [] },
		{ action: 'pause', paused: true },
		'a bare string',
	] ) {
		const reply = newMessage();
		reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		reply[ TO ] = 'status-receiver';
		reply[ VALUE ] = value;
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( reply ) );
	}

	expect( routed.map( ( m ) => m[ TO ] ) ).toEqual( [
		'status-receiver',
		'status-receiver',
		'status-receiver',
	] );
} );

test( 'reconnect backoff widens against a dead endpoint and resets on connect', () => {
	jest.useFakeTimers();
	try {
		expectConsoleWarn(
			'ERROR: SseInNode: reconnecting - SSE silent past timeout'
		);
		const { sse } = makeSseIn();
		sse.start();

		// A flat 2s retry is 30 requests/minute per tab, forever — and each
		// attempt takes an SSE slot from a pool capped at 10 per user/IP.
		const delays = [];
		for ( let i = 0; i < 5; i++ ) {
			jest.advanceTimersByTime( sse.reconnectDelayMs() );
			delays.push( sse.reconnectDelayMs() );
			sse._forceReconnect();
		}

		expect( delays[ 0 ] ).toBeLessThan( delays[ 1 ] );
		expect( delays[ 4 ] ).toBeGreaterThanOrEqual( delays[ 3 ] );
		expect( delays[ 4 ] ).toBeLessThanOrEqual( 30000 );

		// A successful handshake clears it, as the PHP half does.
		sse._applyConnected( connectedRaw() );
		expect( sse.reconnectDelayMs() ).toBe( delays[ 0 ] );
	} finally {
		jest.useRealTimers();
	}
} );

test( 'watchdog forces close+reopen after total silence past FORCE_AFTER_MS', () => {
	jest.useFakeTimers();
	try {
		expectConsoleWarn(
			'ERROR: SseInNode: reconnecting - SSE silent past timeout'
		);
		const { sse } = makeSseIn();
		sse.start();
		const first = FakeEventSource.last;
		first.readyState = FakeEventSource.OPEN; // established, then went silent
		jest.advanceTimersByTime( 13000 ); // > 10s silence, no frame arrived
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
		jest.advanceTimersByTime( 7000 ); // past STALE (6s), before FORCE (10s)
		first.dispatch( 'heartbeat', JSON.stringify( { ts: 1 } ) );
		jest.advanceTimersByTime( 5000 ); // total 12s, only 5s since the beat
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

test( 'onerror with readyState CONNECTING closes and schedules OUR reopen', () => {
	jest.useFakeTimers();
	try {
		const { sse } = makeSseIn();
		sse.start();
		const first = FakeEventSource.last;
		// The browser would reopen this one itself; we take that over so both
		// halves of the link keep to the server's advertised cadence.
		first.dispatchError( FakeEventSource.CONNECTING );
		expect( first.readyState ).toBe( FakeEventSource.CLOSED );
		expect( FakeEventSource.last ).toBe( first );

		jest.advanceTimersByTime( DEFAULT_REOPEN_MS );
		expect( FakeEventSource.last ).not.toBe( first );
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
		FakeEventSource.last.readyState = FakeEventSource.OPEN;
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
		expect( sse.seekMap() ).toEqual( { x: { 0: 'start' } } ); // replay
		// The fake's job is the STIMULUS: a stream that goes silent long enough
		// for the watchdog to force a reconnect. What it recorded is not the
		// question — what this node asks for next is.
		sse._es.readyState = FakeEventSource.OPEN;
		jest.advanceTimersByTime( 13000 );
		// Reopens LIVE — it ASKS for the tail, rather than replaying the seed.
		expect( sse.seekMap() ).toEqual( { x: SEEK_END } );
	} finally {
		jest.useRealTimers();
	}
} );

test( 'tracks segment:offset:length from each frame, resuming at offset+length', () => {
	const { sse } = makeSseIn( { subscribe: [ 'completed' ] } );
	sse.start();
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'completed.p0/request-builder';
	m[ ID ] = '4:623851:120';
	m[ VALUE ] = 'a line';
	FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
	// Keyed by the opaque partition dir name; offset = record offset + length.
	expect( sse.resumePositions() ).toEqual( {
		'completed.p0': { segment: 4, offset: 623851 + 120 },
	} );
} );

test( 'a command-reply ID (not a breadcrumb) is not tracked as a position', () => {
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
		// Subscribe by the CONCRETE dir: a non-glob subscription is its own dir
		// name server-side, so a stamp of `completed.p1` under a `completed`
		// subscription is a shape the resolver cannot produce.
		const { sse } = makeSseIn( { subscribe: [ 'completed.p1' ] } );
		sse.start();
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ FROM ] = 'completed.p1/x';
		m[ ID ] = '2:500:100';
		m[ VALUE ] = 'x';
		FakeEventSource.last.dispatch( 'msg', JSON.stringify( m ) );
		jest.advanceTimersByTime( 13000 ); // watchdog forces a reconnect
		// The frame it consumed is what moved the cursor, so ask the node.
		expect( sse.seekMap() ).toEqual( {
			'completed.p1': { segment: 2, offset: 500 + 100 },
		} );
	} finally {
		jest.useRealTimers();
	}
} );

test( 'removeNode() stops the watchdog and closes the stream (no reconnect after removal)', () => {
	jest.useFakeTimers();
	try {
		// A NAMED SseIn is an addressable graph node, so setTimer hitchhikes
		// the Router tick rather than taking a slot of its own.
		const router = new RouterNode();
		router.name = names.ROUTER;
		const { sse } = makeSseIn();
		sse.name = 'sse-test';
		sse.start();
		expect( sse.mode ).toBe( 'router' );
		const first = FakeEventSource.last;
		sse.removeNode();
		expect( first.closed ).toBe( true );
		expect( () => jest.advanceTimersByTime( 20000 ) ).not.toThrow();
		expect( FakeEventSource.last ).toBe( first ); // nothing reopened
	} finally {
		jest.useRealTimers();
	}
} );

describe( 'SseIn — no-arg ctor + schema-driven arguments', () => {
	afterEach( () => {
		delete window.NewspackNodesData;
	} );

	test( 'constructs with no args and exposes safe-default config fields', () => {
		const sse = new SseInNode();
		expect( sse.subscribe ).toEqual( [] );
		// No explicit override + no global → the safe REST default / empty nonce.
		expect( sse.baseUrl ).toBe( '/wp-json/' );
		expect( sse.nonce ).toBe( '' );
	} );

	// subscribe is the ONLY positional arg — the transport coordinates
	// (baseUrl + nonce) are request-scoped, sourced from the localized global.
	test( 'declares a node schema with just the subscribe positional argument', () => {
		const schema = SseInNode.nodeSchema();
		expect( schema.arguments.map( ( a ) => a.name ) ).toEqual( [
			'subscribe',
		] );
	} );

	test( 'lives in the I/O palette category (draggable network-ingress source)', () => {
		expect( SseInNode.nodeSchema().category ).toBe( 'I/O' );
	} );

	// accepts_fill=false: SseIn is a pure ingress source, not a drag target.
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

	test( 'arguments setter parses subscribe and splits it on commas', () => {
		const sse = new SseInNode();
		sse.arguments = [ 'firehose,errors' ];
		expect( sse.subscribe ).toEqual( [ 'firehose', 'errors' ] );
	} );

	test( 'baseUrl + nonce default to the localized global at read time', () => {
		window.NewspackNodesData = {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'GNONCE',
		};
		const sse = new SseInNode();
		sse.arguments = [ 'firehose' ];
		expect( sse.baseUrl ).toBe( 'https://example.test/wp-json/' );
		expect( sse.nonce ).toBe( 'GNONCE' );
	} );

	test( 'an explicit baseUrl / nonce overrides the global', () => {
		window.NewspackNodesData = {
			restUrl: 'https://global/wp-json/',
			nonce: 'GLOBAL',
		};
		const sse = new SseInNode();
		sse.baseUrl = 'https://explicit/wp-json/';
		sse.nonce = 'EXPLICIT';
		expect( sse.baseUrl ).toBe( 'https://explicit/wp-json/' );
		expect( sse.nonce ).toBe( 'EXPLICIT' );
	} );

	test( 'a single-topic subscribe still parses as a one-element array', () => {
		const sse = new SseInNode();
		sse.arguments = [ 'firehose' ];
		expect( sse.subscribe ).toEqual( [ 'firehose' ] );
	} );

	test( 'start() sources baseUrl + nonce from the global when unset (palette-drop path)', () => {
		window.NewspackNodesData = {
			restUrl: 'https://example.test/wp-json/',
			nonce: 'NONCE',
		};
		// A bare palette-drop configures only subscribe; no nonce is threaded in.
		const sse = newSseIn();
		sse.arguments = [ 'firehose,errors' ];
		sse.start();
		expect( sse._es.url ).toBe(
			'https://example.test/wp-json/newspack-nodes/v1/messages/stream?subscribe=firehose%2Cerrors&_wpnonce=NONCE' +
				`&positions=${ encodeURIComponent(
					JSON.stringify( { firehose: SEEK_END, errors: SEEK_END } )
				) }`
		);
	} );
} );
