/**
 * rawlogs:stream tests — the SSE-in node that owns the live connection for the
 * selected log. `subscribe(logKey)` (re)connects; each inbound `msg` envelope
 * AND each connection-status change is emitted through the node's `sink` (the
 * exospine CI) stamped `TO = target` (the route). There is NO controlSink — the
 * route node does the data/control split (see rawLogsRoute.test). Switching logs
 * closes the old source and opens a new one.
 *
 * Two seams are exercised:
 *  - The INJECTED connector (`opts.connector`): a fake whose `connect()` records
 *    the subscription + the envelope/status handlers so a test can deliver them.
 *  - The DEFAULT connector (no `opts.connector`): built on `global.EventSource`
 *    with the slot-heartbeat poke + reconnect backoff migrated from
 *    useMessageStream. Faked the same way useMessageStream.test fakes them.
 */

import {
	newMessage,
	TYPE,
	TO,
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

// Build a stream wired the way the exospine hook wires it: sink captures emitted
// messages, target points at the route. Returns { s, got }.
function streamWithCapture( fake ) {
	const got = [];
	const s = createRawLogsStream( 'rawlogs:stream', { connector: fake } );
	s.sink = { fill: ( m ) => got.push( m ) };
	s.target = 'rawlogs:route';
	return { s, got };
}

describe( 'rawlogs:stream', () => {
	test( 'emits one envelope per SSE msg event to its sink, stamped TO the route', () => {
		const fake = makeFakeConnector();
		const { s, got } = streamWithCapture( fake );
		s.subscribe( 'firehose' );
		const env = newMessage();
		env[ VALUE ] = 'a log line';
		fake.deliverMessage( env );
		expect( got ).toHaveLength( 1 );
		expect( got[ 0 ][ VALUE ] ).toBe( 'a log line' );
		expect( got[ 0 ][ TO ] ).toBe( 'rawlogs:route' );
	} );

	test( 'subscribing to a new log closes the old source and opens a new one', () => {
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs:stream', { connector: fake } );
		s.subscribe( 'firehose' );
		s.subscribe( 'errors' );
		expect( fake.closeCount ).toBe( 1 ); // old closed
		expect( fake.lastSubscription ).toBe( 'errors' ); // new opened
	} );

	test( 'the first subscribe does not close anything (nothing open yet)', () => {
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs:stream', { connector: fake } );
		s.subscribe( 'firehose' );
		expect( fake.closeCount ).toBe( 0 );
		expect( fake.lastSubscription ).toBe( 'firehose' );
	} );

	test( 'close() tears down the connector', () => {
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs:stream', { connector: fake } );
		s.subscribe( 'firehose' );
		s.close();
		expect( fake.closeCount ).toBe( 1 );
	} );

	test( 'envelopes delivered before any subscribe are not emitted', () => {
		const fake = makeFakeConnector();
		const { got } = streamWithCapture( fake );
		fake.deliverMessage( newMessage() );
		expect( got ).toHaveLength( 0 );
	} );

	test( 'a connection-error status is emitted to the sink as a control, stamped TO the route', () => {
		const fake = makeFakeConnector();
		const { s, got } = streamWithCapture( fake );
		s.subscribe( 'firehose' );
		fake.emitStatus( { connectionError: true } );
		expect( got ).toHaveLength( 1 );
		expect( got[ 0 ][ TYPE ] ).toBe( TM_STRUCT );
		expect( got[ 0 ][ TO ] ).toBe( 'rawlogs:route' );
		// The route classifies on this stream-set KEY, never on VALUE content.
		expect( got[ 0 ][ KEY ] ).toBe( 'connection' );
		expect( got[ 0 ][ VALUE ] ).toEqual( {
			action: 'connection',
			connectionError: true,
		} );
	} );

	test( 'a connection-restored status is emitted to the sink as a control', () => {
		const fake = makeFakeConnector();
		const { s, got } = streamWithCapture( fake );
		s.subscribe( 'firehose' );
		fake.emitStatus( { connectionError: false } );
		expect( got[ 0 ][ VALUE ] ).toEqual( {
			action: 'connection',
			connectionError: false,
		} );
	} );

	test( 'data envelopes and status both go to the one sink (the route splits them)', () => {
		const fake = makeFakeConnector();
		const { s, got } = streamWithCapture( fake );
		s.subscribe( 'firehose' );
		const env = newMessage();
		env[ VALUE ] = 'a log line';
		fake.deliverMessage( env );
		fake.emitStatus( { connectionError: true } );
		expect( got ).toHaveLength( 2 );
		expect( got[ 0 ][ VALUE ] ).toBe( 'a log line' );
		expect( got[ 1 ][ VALUE ].action ).toBe( 'connection' );
		// Both stamped TO the route; the route node does the classification.
		expect( got.every( ( m ) => m[ TO ] === 'rawlogs:route' ) ).toBe(
			true
		);
	} );

	test( 'a status with no sink set is dropped (no throw)', () => {
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs:stream', { connector: fake } );
		s.subscribe( 'firehose' );
		expect( () =>
			fake.emitStatus( { connectionError: true } )
		).not.toThrow();
	} );

	test( 'names the node', () => {
		const fake = makeFakeConnector();
		const s = createRawLogsStream( 'rawlogs:stream', { connector: fake } );
		expect( s.name ).toBe( 'rawlogs:stream' );
	} );
} );

// The DEFAULT connector (no injected connector): EventSource + heartbeat + backoff.
describe( 'rawlogs:stream default connector', () => {
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
		const s = createRawLogsStream( 'rawlogs:stream' );
		s.subscribe( 'firehose' );
		const es = FakeEventSource.last();
		expect( es.url ).toContain( 'newspack-nodes/v1/messages/stream' );
		expect( es.url ).toContain( 'subscribe=firehose' );
		expect( es.url ).toContain( '_wpnonce=N' );
	} );

	test( 'forwards each parsed msg envelope to the sink stamped TO the route', () => {
		const got = [];
		const s = createRawLogsStream( 'rawlogs:stream' );
		s.sink = { fill: ( m ) => got.push( m ) };
		s.target = 'rawlogs:route';
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
		expect( got[ 0 ][ TO ] ).toBe( 'rawlogs:route' );
	} );

	test( 'switching logs closes the old EventSource and opens a new one', () => {
		const s = createRawLogsStream( 'rawlogs:stream' );
		s.subscribe( 'firehose' );
		const first = FakeEventSource.last();
		s.subscribe( 'errors' );
		expect( first.closed ).toBe( true );
		expect( FakeEventSource.last() ).not.toBe( first );
		expect( FakeEventSource.last().url ).toContain( 'subscribe=errors' );
	} );

	test( 'pokes the slot heartbeat after the connected envelope', () => {
		const s = createRawLogsStream( 'rawlogs:stream' );
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
		const s = createRawLogsStream( 'rawlogs:stream' );
		s.subscribe( 'firehose' );
		const first = FakeEventSource.last();
		first.onerror();
		expect( first.closed ).toBe( true );
		jest.advanceTimersByTime( 2000 );
		expect( FakeEventSource.instances.length ).toBeGreaterThan( 1 );
	} );

	test( 'reports connectionError:true to the sink on the first error', () => {
		const controls = [];
		const s = createRawLogsStream( 'rawlogs:stream' );
		s.sink = { fill: ( m ) => controls.push( m[ VALUE ] ) };
		s.target = 'rawlogs:route';
		s.subscribe( 'firehose' );
		FakeEventSource.last().onerror();
		expect( controls ).toEqual( [
			{ action: 'connection', connectionError: true },
		] );
	} );

	test( 'reports connectionError:false to the sink on open', () => {
		const controls = [];
		const s = createRawLogsStream( 'rawlogs:stream' );
		s.sink = { fill: ( m ) => controls.push( m[ VALUE ] ) };
		s.target = 'rawlogs:route';
		s.subscribe( 'firehose' );
		FakeEventSource.last().onopen();
		expect( controls ).toEqual( [
			{ action: 'connection', connectionError: false },
		] );
	} );

	test( 'reports connectionError exactly once per disconnect (reconnect-stack guard)', () => {
		const controls = [];
		const s = createRawLogsStream( 'rawlogs:stream' );
		s.sink = { fill: ( m ) => controls.push( m[ VALUE ] ) };
		s.target = 'rawlogs:route';
		s.subscribe( 'firehose' );
		const first = FakeEventSource.last();
		first.onerror(); // schedules a reconnect timer
		first.onerror(); // re-fires before reconnect: must be swallowed by the guard
		expect(
			controls.filter( ( c ) => c.connectionError === true )
		).toHaveLength( 1 );
	} );

	test( 'close() stops the heartbeat poke and the reconnect timer', () => {
		const s = createRawLogsStream( 'rawlogs:stream' );
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
