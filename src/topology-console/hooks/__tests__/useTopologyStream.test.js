/**
 * Tests for useTopologyStream — wraps the per-(topology, partition)
 * SSE controller into a React hook. Mocks the EventSource global so we
 * can drive `hello` / `msg` / `error` events deterministically without
 * a server.
 */

import { renderHook, act } from '@testing-library/react';
import { useTopologyStream } from '../useTopologyStream';

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
		this.closed = false;
		FakeEventSource.last = this;
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
	triggerError() {
		if ( this.onerror ) {
			this.onerror();
		}
	}
	close() {
		this.closed = true;
	}
}

describe( 'useTopologyStream', () => {
	const originalEventSource = window.EventSource;
	const originalData = window.NewspackNodesData;
	beforeEach( () => {
		window.EventSource = FakeEventSource;
		window.NewspackNodesData = {
			restUrl: '/wp-json/',
			nonce: 'NONCE',
		};
	} );
	afterEach( () => {
		window.EventSource = originalEventSource;
		window.NewspackNodesData = originalData;
		FakeEventSource.last = undefined;
	} );

	it( 'starts in connecting status and opens an EventSource with the right URL', () => {
		const { result } = renderHook( () =>
			useTopologyStream( 'demo', 3, () => {} )
		);
		expect( result.current.status ).toBe( 'connecting' );
		expect( result.current.ssePid ).toBeNull();
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/topology/demo/p3/stream'
		);
		expect( FakeEventSource.last.url ).toContain( '_wpnonce=NONCE' );
	} );

	it( 'flips to open and captures pid on hello event', () => {
		const { result } = renderHook( () =>
			useTopologyStream( 'demo', 0, () => {} )
		);
		act( () => {
			FakeEventSource.last.dispatch( 'hello', { pid: 12345 } );
		} );
		expect( result.current.status ).toBe( 'open' );
		expect( result.current.ssePid ).toBe( 12345 );
	} );

	it( 'tolerates a malformed hello payload without crashing', () => {
		const { result } = renderHook( () =>
			useTopologyStream( 'demo', 0, () => {} )
		);
		act( () => {
			FakeEventSource.last.dispatch( 'hello', 'not-json' );
		} );
		expect( result.current.status ).toBe( 'open' );
		expect( result.current.ssePid ).toBeNull();
	} );

	it( 'invokes onMessage for each msg event', () => {
		const onMessage = jest.fn();
		renderHook( () => useTopologyStream( 'demo', 0, onMessage ) );
		act( () => {
			FakeEventSource.last.dispatch( 'msg', { hello: 'world' } );
		} );
		expect( onMessage ).toHaveBeenCalledWith( { hello: 'world' } );
	} );

	it( 'silently drops malformed msg events', () => {
		const onMessage = jest.fn();
		renderHook( () => useTopologyStream( 'demo', 0, onMessage ) );
		act( () => {
			FakeEventSource.last.dispatch( 'msg', 'not-json' );
		} );
		expect( onMessage ).not.toHaveBeenCalled();
	} );

	it( 'flips to error on EventSource error', () => {
		const { result } = renderHook( () =>
			useTopologyStream( 'demo', 0, () => {} )
		);
		act( () => {
			FakeEventSource.last.triggerError();
		} );
		expect( result.current.status ).toBe( 'error' );
	} );

	it( 'closes the connection on unmount', () => {
		const { unmount } = renderHook( () =>
			useTopologyStream( 'demo', 0, () => {} )
		);
		const es = FakeEventSource.last;
		unmount();
		expect( es.closed ).toBe( true );
	} );

	it( 'short-circuits when enabled=false', () => {
		const { result } = renderHook( () =>
			useTopologyStream( 'demo', 0, () => {}, false )
		);
		expect( result.current.status ).toBe( 'closed' );
		expect( FakeEventSource.last ).toBeUndefined();
	} );

	it( 'sets status=error when NewspackNodesData is missing', () => {
		delete window.NewspackNodesData;
		const { result } = renderHook( () =>
			useTopologyStream( 'demo', 0, () => {} )
		);
		expect( result.current.status ).toBe( 'error' );
		expect( FakeEventSource.last ).toBeUndefined();
	} );

	it( 'heartbeat events are accepted without side effects', () => {
		const onMessage = jest.fn();
		const { result } = renderHook( () =>
			useTopologyStream( 'demo', 0, onMessage )
		);
		act( () => {
			FakeEventSource.last.dispatch( 'heartbeat', {} );
		} );
		// Heartbeats don't change status or fire onMessage.
		expect( result.current.status ).toBe( 'connecting' );
		expect( onMessage ).not.toHaveBeenCalled();
	} );

	it( 'always uses the latest onMessage closure', () => {
		const first = jest.fn();
		const second = jest.fn();
		const { rerender } = renderHook(
			( { fn } ) => useTopologyStream( 'demo', 0, fn ),
			{ initialProps: { fn: first } }
		);
		rerender( { fn: second } );
		act( () => {
			FakeEventSource.last.dispatch( 'msg', { x: 1 } );
		} );
		expect( first ).not.toHaveBeenCalled();
		expect( second ).toHaveBeenCalledWith( { x: 1 } );
	} );
} );
