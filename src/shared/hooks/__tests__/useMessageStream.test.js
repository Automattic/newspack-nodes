/**
 * Tests for useMessageStream — SSE wiring + slot keep-alive + position
 * tracking + exponential backoff reconnect.
 *
 * EventSource is mocked so we can drive `msg` / `heartbeat` / `error`
 * deterministically. CommandClient is mocked to capture slot heartbeats.
 */

import { renderHook, act } from '@testing-library/react';
import useMessageStream from '../useMessageStream';

jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: jest.fn(),
} ) );
const { getCommandClient } = require( '../../utils/commandClient' );

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
		this.closed = false;
		FakeEventSource.instances.push( this );
	}
	addEventListener( type, fn ) {
		this.listeners[ type ] = this.listeners[ type ] || [];
		this.listeners[ type ].push( fn );
	}
	dispatch( type, data ) {
		( this.listeners[ type ] || [] ).forEach( ( fn ) =>
			fn( {
				data: typeof data === 'string' ? data : JSON.stringify( data ),
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

describe( 'useMessageStream', () => {
	let sendMock;
	const originalEventSource = window.EventSource;
	const originalData = window.NewspackNodesData;

	beforeEach( () => {
		window.EventSource = FakeEventSource;
		window.NewspackNodesData = {
			restUrl: '/wp-json/',
			nonce: 'N',
		};
		FakeEventSource.instances = [];
		sendMock = jest.fn().mockResolvedValue( null );
		getCommandClient.mockReturnValue( { send: sendMock } );
		jest.useFakeTimers();
	} );

	afterEach( () => {
		jest.useRealTimers();
		window.EventSource = originalEventSource;
		window.NewspackNodesData = originalData;
	} );

	it( 'starts with no error and null lastEventTime', () => {
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [ 'firehose' ] } )
		);
		expect( result.current.error ).toBeNull();
		expect( result.current.lastEventTime ).toBeNull();
	} );

	it( 'connect() opens an EventSource carrying subscribe + nonce', () => {
		const { result } = renderHook( () =>
			useMessageStream( {
				subscriptions: [ 'firehose', 'errors' ],
			} )
		);
		act( () => result.current.connect() );
		const es = FakeEventSource.last();
		expect( es.url ).toContain( 'subscribe=firehose%2Cerrors' );
		expect( es.url ).toContain( '_wpnonce=N' );
	} );

	it( 'reports config error and skips connecting when NewspackNodesData is absent', () => {
		delete window.NewspackNodesData;
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [ 'firehose' ] } )
		);
		act( () => result.current.connect() );
		expect( result.current.error ).toMatch( /not available/i );
		expect( FakeEventSource.instances ).toHaveLength( 0 );
	} );

	it( 'connect() with empty subscriptions is a no-op', () => {
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [] } )
		);
		act( () => result.current.connect() );
		expect( FakeEventSource.instances ).toHaveLength( 0 );
	} );

	it( 'invokes onMessage with the parsed envelope', () => {
		const onMessage = jest.fn();
		const { result } = renderHook( () =>
			useMessageStream( {
				subscriptions: [ 'firehose' ],
				onMessage,
			} )
		);
		act( () => result.current.connect() );
		// envelope = [TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE]
		act( () =>
			FakeEventSource.last().dispatch( 'msg', [
				1,
				1234,
				'firehose.p0',
				'',
				'5:100',
				'',
				'data',
			] )
		);
		expect( onMessage ).toHaveBeenCalledTimes( 1 );
		expect( onMessage.mock.calls[ 0 ][ 0 ][ 6 ] ).toBe( 'data' );
		expect( onMessage.mock.calls[ 0 ][ 1 ] ).toEqual( { type: 1 } );
	} );

	it( 'updates lastEventTime on each msg/heartbeat', () => {
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [ 'firehose' ] } )
		);
		act( () => result.current.connect() );
		act( () => FakeEventSource.last().dispatch( 'heartbeat', '' ) );
		expect( typeof result.current.lastEventTime ).toBe( 'number' );
	} );

	it( 'silently drops envelopes that fail JSON.parse or are not arrays', () => {
		const onMessage = jest.fn();
		const { result } = renderHook( () =>
			useMessageStream( {
				subscriptions: [ 'firehose' ],
				onMessage,
			} )
		);
		act( () => result.current.connect() );
		act( () => FakeEventSource.last().dispatch( 'msg', 'not-json' ) );
		act( () => FakeEventSource.last().dispatch( 'msg', { not: 'array' } ) );
		expect( onMessage ).not.toHaveBeenCalled();
	} );

	it( 'starts a slot heartbeat after the connected envelope', () => {
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [ 'firehose' ] } )
		);
		act( () => result.current.connect() );
		act( () =>
			FakeEventSource.last().dispatch( 'msg', [
				64,
				0,
				'_sse_pool',
				'',
				'',
				'connected',
				{ slot: 3 },
			] )
		);
		// Heartbeat cadence is 5s.
		act( () => jest.advanceTimersByTime( 5000 ) );
		expect( sendMock ).toHaveBeenCalledWith( {
			to: 'workers',
			verb: 'heartbeat',
			payload: { slot: 3, ttl: 10 },
		} );
	} );

	it( 'tracks per-subscription per-partition positions from envelope FROM+ID', () => {
		// Custom subclass so we can read positionsRef indirectly: after
		// processing an envelope, a reconnect should carry `positions=...`
		// in the URL with the seg/off encoded.
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [ 'firehose' ] } )
		);
		act( () => result.current.connect() );
		act( () =>
			FakeEventSource.last().dispatch( 'msg', [
				1,
				0,
				'firehose.p2',
				'',
				'7:99',
				'',
				'x',
			] )
		);
		// Reconnect to surface the positions param.
		act( () => result.current.connect() );
		const reconnectUrl = FakeEventSource.last().url;
		const positions = decodeURIComponent(
			reconnectUrl.match( /positions=([^&]+)/ )[ 1 ]
		);
		expect( JSON.parse( positions ) ).toEqual( {
			firehose: { 2: { seg: 7, off: 99 } },
		} );
	} );

	it( 'discards stored positions when the subscription set changes', () => {
		const { result, rerender } = renderHook(
			( { subs } ) =>
				useMessageStream( {
					subscriptions: subs,
				} ),
			{ initialProps: { subs: [ 'firehose' ] } }
		);
		act( () => result.current.connect() );
		act( () =>
			FakeEventSource.last().dispatch( 'msg', [
				1,
				0,
				'firehose.p0',
				'',
				'1:1',
				'',
				'x',
			] )
		);
		// Reconfigure to a different subscription set, then reconnect.
		rerender( { subs: [ 'errors' ] } );
		act( () => result.current.connect() );
		const reconnectUrl = FakeEventSource.last().url;
		expect( reconnectUrl ).not.toContain( 'positions=' );
	} );

	it( 'reconnects with exponential backoff on onerror', () => {
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [ 'firehose' ] } )
		);
		act( () => result.current.connect() );
		const first = FakeEventSource.last();
		act( () => first.onerror() );
		expect( result.current.error ).toMatch( /Reconnecting/ );
		expect( first.closed ).toBe( true );
		// Advance by the first delay (2s) — should reconnect.
		act( () => jest.advanceTimersByTime( 2000 ) );
		expect( FakeEventSource.instances.length ).toBeGreaterThan( 1 );
	} );

	it( 'guards against stacked reconnects when onerror fires twice', () => {
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [ 'firehose' ] } )
		);
		act( () => result.current.connect() );
		const first = FakeEventSource.last();
		act( () => first.onerror() );
		act( () => first.onerror() ); // Second fire while a reconnect is queued.
		act( () => jest.advanceTimersByTime( 2000 ) );
		// Only one reconnect should have fired (so two total ES instances).
		expect( FakeEventSource.instances.length ).toBe( 2 );
	} );

	it( 'close() tears down the source, slot interval, and reconnect timer', () => {
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [ 'firehose' ] } )
		);
		act( () => result.current.connect() );
		act( () =>
			FakeEventSource.last().dispatch( 'msg', [
				64,
				0,
				'_sse_pool',
				'',
				'',
				'connected',
				{ slot: 0 },
			] )
		);
		const es = FakeEventSource.last();
		act( () => result.current.close() );
		expect( es.closed ).toBe( true );
		// Advance past one heartbeat interval — no further heartbeat sends.
		const callsBefore = sendMock.mock.calls.length;
		act( () => jest.advanceTimersByTime( 10000 ) );
		expect( sendMock.mock.calls.length ).toBe( callsBefore );
	} );

	it( 'calls onBeforeConnect on every connect attempt', () => {
		const onBeforeConnect = jest.fn();
		const { result } = renderHook( () =>
			useMessageStream( {
				subscriptions: [ 'firehose' ],
				onBeforeConnect,
			} )
		);
		act( () => result.current.connect() );
		act( () => result.current.connect() );
		expect( onBeforeConnect ).toHaveBeenCalledTimes( 2 );
	} );

	it( 'onopen resets the retry counter', () => {
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [ 'firehose' ] } )
		);
		act( () => result.current.connect() );
		act( () => FakeEventSource.last().onopen() );
		// Errors should restart backoff from 2s (retry=1) again. We just
		// verify the path executes without throwing.
		expect( result.current.error ).toBeNull();
	} );

	it( 'connected envelope replaces a prior heartbeat interval', () => {
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [ 'firehose' ] } )
		);
		act( () => result.current.connect() );
		act( () =>
			FakeEventSource.last().dispatch( 'msg', [
				64,
				0,
				'_sse_pool',
				'',
				'',
				'connected',
				{ slot: 1 },
			] )
		);
		act( () =>
			FakeEventSource.last().dispatch( 'msg', [
				64,
				0,
				'_sse_pool',
				'',
				'',
				'connected',
				{ slot: 2 },
			] )
		);
		// Advance the heartbeat cadence — newest slot wins.
		act( () => jest.advanceTimersByTime( 5000 ) );
		const lastCall = sendMock.mock.calls.at( -1 )[ 0 ];
		expect( lastCall.payload.slot ).toBe( 2 );
	} );

	it( 'ignores a connected envelope with a non-integer slot', () => {
		const { result } = renderHook( () =>
			useMessageStream( { subscriptions: [ 'firehose' ] } )
		);
		act( () => result.current.connect() );
		act( () =>
			FakeEventSource.last().dispatch( 'msg', [
				64,
				0,
				'_sse_pool',
				'',
				'',
				'connected',
				{ slot: 'bad' },
			] )
		);
		act( () => jest.advanceTimersByTime( 5000 ) );
		expect( sendMock ).not.toHaveBeenCalled();
	} );
} );
