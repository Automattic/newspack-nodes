import { Core } from '../core';
import { IoTelemetry, byteLength } from '../io-telemetry';
import { SseInNode } from '../sse-in-node';
import { commandTransport } from '../command-transport';
import {
	TYPE,
	KEY,
	VALUE,
	pack,
	newMessage,
	TM_BYTESTREAM,
	TM_INFO,
	TM_ERROR,
	TM_RESPONSE,
	TM_COMMAND,
	TO,
} from '../message';

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
		this.readyState = 0;
		FakeEventSource.last = this;
	}
	addEventListener( name, cb ) {
		( this.listeners[ name ] ||= [] ).push( cb );
	}
	close() {
		this.readyState = 2;
	}
	dispatch( name, data ) {
		( this.listeners[ name ] || [] ).forEach( ( cb ) => cb( { data } ) );
	}
}

beforeEach( () => {
	Core.reset();
	IoTelemetry.reset();
	global.EventSource = FakeEventSource;
} );

// A started node holds a real 2s watchdog; the harness owns teardown so none
// outlives its test.
const live = [];
afterEach( () => live.splice( 0 ).forEach( ( s ) => s.close() ) );

function makeConnector() {
	const s = new SseInNode();
	s.arguments = [ 'x' ];
	s.sink = { fill: () => {} };
	live.push( s );
	return s;
}

describe( 'SseIn feeds IoTelemetry "in"', () => {
	test( 'a routed frame records its byte length as one inbound message', () => {
		const s = makeConnector();
		s.start();
		const frame = pack( [ TM_BYTESTREAM, 1, 'p.p0', '', '0:0', '', 'hi' ] );
		FakeEventSource.last.dispatch( 'msg', frame );
		const snap = IoTelemetry.snapshot();
		expect( snap.msgsIn ).toBe( 1 );
		expect( snap.bytesIn ).toBe( byteLength( frame ) );
		expect( snap.errors ).toBe( 0 );
	} );

	test( 'a TM_ERROR frame counts as inbound, not as a telemetry error', () => {
		// The error counter is fed by Core's stderr chain; SseIn reports a
		// stream error through set_state instead, so nothing logs it here.
		const s = makeConnector();
		s.start();
		const frame = pack( [ TM_ERROR, 1, 'p.p0', '', '0:1', '', 'boom' ] );
		FakeEventSource.last.dispatch( 'msg', frame );
		const snap = IoTelemetry.snapshot();
		expect( snap.msgsIn ).toBe( 1 );
		expect( snap.errors ).toBe( 0 );
	} );

	test( 'the connected snoop envelope is not counted (metadata, not a frame)', () => {
		const s = makeConnector();
		s.start();
		const env = newMessage();
		env[ TYPE ] = TM_INFO;
		env[ KEY ] = 'connected';
		env[ VALUE ] =
			'PID 7 SLOT 0 OWNER 9007199254740993 ' +
			'SUBSCRIPTIONS x INTERVAL 2000';
		FakeEventSource.last.dispatch( 'connected', pack( env ) );
		expect( IoTelemetry.snapshot().msgsIn ).toBe( 0 );
	} );

	test( 'heartbeats are not counted', () => {
		const s = makeConnector();
		s.start();
		FakeEventSource.last.dispatch( 'heartbeat', '' );
		expect( IoTelemetry.snapshot().msgsIn ).toBe( 0 );
	} );
} );

// The command shape HttpOut hands the transport (it mints; this is a stand-in).
const command = ( to, verb ) => {
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ TO ] = to;
	m[ VALUE ] = { name: verb, arguments: [] };
	return m;
};

describe( 'the command transport feeds IoTelemetry "out" and "in"', () => {
	function mockFetch( replies ) {
		const body = replies.map( ( m ) => pack( m ) ).join( '\n' );
		global.fetch = jest
			.fn()
			.mockResolvedValue( { text: async () => body } );
		return body;
	}

	test( 'postBatch records the request body bytes + count out, reply bytes + count in', async () => {
		const reply = [
			TM_RESPONSE,
			1,
			'',
			'',
			'cmd-1',
			'',
			{ name: 'ok', payload: {} },
		];
		const respBody = mockFetch( [ reply ] );
		const client = commandTransport( { baseUrl: '/', nonce: 'N' } );
		const out1 = command( 'a', 'x' );
		const out2 = command( 'b', 'y' );
		const reqBody = [ out1, out2 ].map( ( m ) => pack( m ) ).join( '\n' );

		await client.postBatch( [ out1, out2 ] );

		const snap = IoTelemetry.snapshot();
		expect( snap.msgsOut ).toBe( 2 );
		expect( snap.bytesOut ).toBe( byteLength( reqBody ) );
		expect( snap.msgsIn ).toBe( 1 );
		expect( snap.bytesIn ).toBe( byteLength( respBody ) );
	} );

	test( 'a bare-202 (empty body) reply records zero inbound', async () => {
		global.fetch = jest.fn().mockResolvedValue( { text: async () => '' } );
		const client = commandTransport( { baseUrl: '/', nonce: 'N' } );
		await client.postBatch( [ command( 'a', 'x' ) ] );
		const snap = IoTelemetry.snapshot();
		expect( snap.msgsOut ).toBe( 1 );
		expect( snap.msgsIn ).toBe( 0 );
		expect( snap.bytesIn ).toBe( 0 );
	} );

	/**
	 * The BYTES and the COUNTS are the transport's, because it is the thing
	 * that reads the wire. The error TALLY is not: HttpOut owns it, since it
	 * stamps the FROM the row names and it can tell a refusal the transport
	 * FABRICATED from an answer the server actually sent. See `the ERRORS
	 * tile` in http-out-node.test.js.
	 */
	test( 'a TM_ERROR reply is counted IN, and left for HttpOut to tally', async () => {
		const errReply = [ TM_ERROR, 1, '', '', 'cmd-2', '', 'nope' ];
		const respBody = mockFetch( [ errReply ] );
		const client = commandTransport( { baseUrl: '/', nonce: 'N' } );

		await client.postBatch( [ command( 'a', 'x' ) ] );

		const snap = IoTelemetry.snapshot();
		expect( snap.msgsIn ).toBe( 1 );
		expect( snap.bytesIn ).toBe( byteLength( respBody ) );
		expect( snap.errors ).toBe( 0 );
	} );
} );

describe( 'Core.stderr classifies WARNING:/ERROR: lines', () => {
	let warnSpy;
	beforeEach( () => {
		warnSpy = jest.spyOn( console, 'warn' ).mockImplementation( () => {} );
	} );
	afterEach( () => warnSpy.mockRestore() );

	test( 'a WARNING: line increments warnings only', () => {
		Core.stderr( 'WARNING: dropping messages' );
		const snap = IoTelemetry.snapshot();
		expect( snap.warnings ).toBe( 1 );
		expect( snap.errors ).toBe( 0 );
	} );

	test( 'an ERROR: line increments errors only', () => {
		Core.stderr( 'ERROR: something bad' );
		const snap = IoTelemetry.snapshot();
		expect( snap.errors ).toBe( 1 );
		expect( snap.warnings ).toBe( 0 );
	} );

	test( 'an ordinary line increments neither', () => {
		Core.stderr( 'just a note' );
		const snap = IoTelemetry.snapshot();
		expect( snap.warnings ).toBe( 0 );
		expect( snap.errors ).toBe( 0 );
	} );
} );
