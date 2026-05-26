/**
 * rawlogs/stream tests — the SSE-in node that owns the live connection for the
 * selected log. `subscribe(logKey)` (re)connects, each inbound `msg` envelope is
 * emitted to the sink, switching logs closes the old source and opens a new one.
 *
 * Two seams are exercised:
 *  - The INJECTED connector (`opts.connector`): a fake whose `connect()` records
 *    the subscription + the envelope handler so a test can deliver envelopes and
 *    assert close/open bookkeeping. Mirrors the sse_connector.test double.
 *  - The DEFAULT connector (no `opts.connector`): built on `global.EventSource`
 *    with the slot-heartbeat poke + reconnect backoff migrated from
 *    useMessageStream. Faked the same way useMessageStream.test fakes them.
 */

import {
	newMessage,
	TYPE,
	KEY,
	VALUE,
	TM_INFO,
	TM_STRUCT,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { createRawLogsStream } from '../rawLogsStream';

// getCommandClient is mocked so the default connector's slot heartbeat poke is
// observable without a CommandClient (matches useMessageStream.test.js).
jest.mock( '../../../shared/utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
const { getCommandClient } = require( '../../../shared/utils/commandClient' );

// setName registers in the per-process Core registry; clear it between tests so
// re-creating the same-named node doesn't collide (matches the sibling tests).
beforeEach( () => Core.reset() );

// A fake connector matching the seam the node depends on: connect( subscription,
// onEnvelope, onStatus ) opens a source (recording the subscription + handlers),
// close() tears it down. deliverMessage() invokes the recorded envelope handler as
// the wire would; emitStatus() invokes the recorded status handler (open/error).
function makeFakeConnector() {
	const fake = {
		closeCount: 0,
		lastSubscription: null,
		_onEnvelope: null,
		_onStatus: null,
		connect( subscription, onEnvelope, onStatus ) {
			this.lastSubscription = subscription;
			this._onEnvelope = onEnvelope;
			this._onStatus = onStatus;
		},
		close() {
			this.closeCount += 1;
			this._onEnvelope = null;
		},
		deliverMessage( envelope ) {
			if ( this._onEnvelope ) {
				this._onEnvelope( envelope );
			}
		},
		emitStatus( status ) {
			if ( this._onStatus ) {
				this._onStatus( status );
			}
		},
	};
	return fake;
}

describe( 'rawlogs/stream', () => {
	test( 'emits one message envelope per SSE msg event to its sink', () => {
		const got = [];
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs/stream', { connector: fake } );
		s.sink = { fill: ( m ) => got.push( m ) };
		s.subscribe( 'firehose' );
		const env = newMessage();
		env[ VALUE ] = 'a log line';
		fake.deliverMessage( env );
		expect( got ).toHaveLength( 1 );
		expect( got[ 0 ][ VALUE ] ).toBe( 'a log line' );
	} );

	test( 'subscribing to a new log closes the old source and opens a new one', () => {
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs/stream', { connector: fake } );
		s.subscribe( 'firehose' );
		s.subscribe( 'errors' );
		expect( fake.closeCount ).toBe( 1 ); // old closed
		expect( fake.lastSubscription ).toBe( 'errors' ); // new opened
	} );

	test( 'the first subscribe does not close anything (nothing open yet)', () => {
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs/stream', { connector: fake } );
		s.subscribe( 'firehose' );
		expect( fake.closeCount ).toBe( 0 );
		expect( fake.lastSubscription ).toBe( 'firehose' );
	} );

	test( 'close() tears down the connector', () => {
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs/stream', { connector: fake } );
		s.subscribe( 'firehose' );
		s.close();
		expect( fake.closeCount ).toBe( 1 );
	} );

	test( 'envelopes delivered before any subscribe are not emitted', () => {
		const got = [];
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs/stream', { connector: fake } );
		s.sink = { fill: ( m ) => got.push( m ) };
		fake.deliverMessage( newMessage() );
		expect( got ).toHaveLength( 0 );
	} );

	test( 'routes a connection-error status to controlSink as a control', () => {
		const controls = [];
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs/stream', { connector: fake } );
		s.controlSink = { fill: ( m ) => controls.push( m ) };
		s.subscribe( 'firehose' );
		fake.emitStatus( { connectionError: true } );
		expect( controls ).toHaveLength( 1 );
		expect( controls[ 0 ][ TYPE ] ).toBe( TM_STRUCT );
		expect( controls[ 0 ][ VALUE ] ).toEqual( {
			action: 'connection',
			connectionError: true,
		} );
	} );

	test( 'routes a connection-restored status to controlSink', () => {
		const controls = [];
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs/stream', { connector: fake } );
		s.controlSink = { fill: ( m ) => controls.push( m[ VALUE ] ) };
		s.subscribe( 'firehose' );
		fake.emitStatus( { connectionError: false } );
		expect( controls[ 0 ] ).toEqual( {
			action: 'connection',
			connectionError: false,
		} );
	} );

	test( 'connection status goes to controlSink, not the data sink', () => {
		const data = [];
		const controls = [];
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs/stream', { connector: fake } );
		s.sink = { fill: ( m ) => data.push( m ) };
		s.controlSink = { fill: ( m ) => controls.push( m ) };
		s.subscribe( 'firehose' );
		// An envelope still routes to the data sink.
		const env = newMessage();
		env[ VALUE ] = 'a log line';
		fake.deliverMessage( env );
		// A status routes only to controlSink.
		fake.emitStatus( { connectionError: true } );
		expect( data ).toHaveLength( 1 );
		expect( data[ 0 ][ VALUE ] ).toBe( 'a log line' );
		expect( controls ).toHaveLength( 1 );
		expect( controls[ 0 ][ VALUE ].action ).toBe( 'connection' );
	} );

	test( 'a status with no controlSink set is dropped (no throw)', () => {
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs/stream', { connector: fake } );
		s.subscribe( 'firehose' );
		expect( () =>
			fake.emitStatus( { connectionError: true } )
		).not.toThrow();
	} );

	test( 'names the node', () => {
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs/stream', { connector: fake } );
		expect( s.name ).toBe( 'rawlogs/stream' );
	} );
} );

// The DEFAULT connector (no injected connector): EventSource + heartbeat + backoff.
describe( 'rawlogs/stream default connector', () => {
	class FakeEventSource {
		constructor( url ) {
			this.url = url;
			this.listeners = {};
			this.closed = false;
			FakeEventSource.instances.push( this );
		}
		addEventListener( type, fn ) {
			( this.listeners[ type ] ||= [] ).push( fn );
		}
		dispatch( type, data ) {
			( this.listeners[ type ] || [] ).forEach( ( fn ) =>
				fn( {
					data:
						'string' === typeof data
							? data
							: JSON.stringify( data ),
				} )
			);
		}
		close() {
			this.closed = true;
		}
	}
	FakeEventSource.instances = [];
	FakeEventSource.last = () =>
		FakeEventSource.instances[ FakeEventSource.instances.length - 1 ];

	const originalEventSource = global.EventSource;
	const originalData = window.NewspackNodesData;
	let sendMock;

	beforeEach( () => {
		global.EventSource = FakeEventSource;
		window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'N' };
		FakeEventSource.instances = [];
		sendMock = jest.fn().mockResolvedValue( null );
		getCommandClient.mockReturnValue( { send: sendMock } );
		jest.useFakeTimers();
	} );

	afterEach( () => {
		jest.useRealTimers();
		global.EventSource = originalEventSource;
		window.NewspackNodesData = originalData;
	} );

	test( 'opens a real EventSource at /messages/stream for the subscription', () => {
		const s = createRawLogsStream( 'rawlogs/stream' );
		s.subscribe( 'firehose' );
		const es = FakeEventSource.last();
		expect( es.url ).toContain( 'newspack-nodes/v1/messages/stream' );
		expect( es.url ).toContain( 'subscribe=firehose' );
		expect( es.url ).toContain( '_wpnonce=N' );
	} );

	test( 'forwards each parsed msg envelope to the sink', () => {
		const got = [];
		const s = createRawLogsStream( 'rawlogs/stream' );
		s.sink = { fill: ( m ) => got.push( m ) };
		s.subscribe( 'firehose' );
		FakeEventSource.last().dispatch( 'msg', [
			1,
			0,
			'firehose.p0',
			'',
			'5:100',
			'',
			'data',
		] );
		expect( got ).toHaveLength( 1 );
		expect( got[ 0 ][ VALUE ] ).toBe( 'data' );
	} );

	test( 'switching logs closes the old EventSource and opens a new one', () => {
		const s = createRawLogsStream( 'rawlogs/stream' );
		s.subscribe( 'firehose' );
		const first = FakeEventSource.last();
		s.subscribe( 'errors' );
		expect( first.closed ).toBe( true );
		expect( FakeEventSource.last() ).not.toBe( first );
		expect( FakeEventSource.last().url ).toContain( 'subscribe=errors' );
	} );

	test( 'pokes the slot heartbeat after the connected envelope', () => {
		const s = createRawLogsStream( 'rawlogs/stream' );
		s.subscribe( 'firehose' );
		const m = newMessage();
		m[ TYPE ] = TM_INFO;
		m[ KEY ] = 'connected';
		m[ VALUE ] = { slot: 3 };
		FakeEventSource.last().dispatch( 'msg', JSON.stringify( m ) );
		jest.advanceTimersByTime( 5000 );
		expect( sendMock ).toHaveBeenCalledWith( {
			to: 'workers',
			verb: 'heartbeat',
			args: '3 10',
		} );
	} );

	test( 'reconnects with exponential backoff on error', () => {
		const s = createRawLogsStream( 'rawlogs/stream' );
		s.subscribe( 'firehose' );
		const first = FakeEventSource.last();
		first.onerror();
		expect( first.closed ).toBe( true );
		jest.advanceTimersByTime( 2000 );
		expect( FakeEventSource.instances.length ).toBeGreaterThan( 1 );
	} );

	test( 'reports connectionError:true to controlSink on the first error', () => {
		const controls = [];
		const s = createRawLogsStream( 'rawlogs/stream' );
		s.controlSink = { fill: ( m ) => controls.push( m[ VALUE ] ) };
		s.subscribe( 'firehose' );
		FakeEventSource.last().onerror();
		expect( controls ).toEqual( [
			{ action: 'connection', connectionError: true },
		] );
	} );

	test( 'reports connectionError:false to controlSink on open', () => {
		const controls = [];
		const s = createRawLogsStream( 'rawlogs/stream' );
		s.controlSink = { fill: ( m ) => controls.push( m[ VALUE ] ) };
		s.subscribe( 'firehose' );
		FakeEventSource.last().onopen();
		expect( controls ).toEqual( [
			{ action: 'connection', connectionError: false },
		] );
	} );

	test( 'reports connectionError exactly once per disconnect (reconnect-stack guard)', () => {
		const controls = [];
		const s = createRawLogsStream( 'rawlogs/stream' );
		s.controlSink = { fill: ( m ) => controls.push( m[ VALUE ] ) };
		s.subscribe( 'firehose' );
		const first = FakeEventSource.last();
		first.onerror(); // schedules a reconnect timer
		first.onerror(); // re-fires before reconnect: must be swallowed by the guard
		expect(
			controls.filter( ( c ) => c.connectionError === true )
		).toHaveLength( 1 );
	} );

	test( 'close() stops the heartbeat poke and the reconnect timer', () => {
		const s = createRawLogsStream( 'rawlogs/stream' );
		s.subscribe( 'firehose' );
		const m = newMessage();
		m[ TYPE ] = TM_INFO;
		m[ KEY ] = 'connected';
		m[ VALUE ] = { slot: 0 };
		FakeEventSource.last().dispatch( 'msg', JSON.stringify( m ) );
		s.close();
		const before = sendMock.mock.calls.length;
		jest.advanceTimersByTime( 10000 );
		expect( sendMock.mock.calls.length ).toBe( before );
	} );
} );
