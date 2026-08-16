/**
 * useLogViewerGraph recovery tests — what happens when the catalog fetch is
 * REFUSED at mount (an expired session, a worker restart) and the reconcile
 * loop later succeeds.
 *
 * Its own file because it drives the reconcile loop on fake timers, and fake
 * timers cannot be uninstalled mid-file (see build-kit/jest-node-timers.js).
 */

import { renderHook, act } from '@testing-library/react';
import { VALUE } from '../../../runtime/message';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { Core } from '../../../runtime/core';
import { useLogViewerGraph } from '../useLogReaderGraph';

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
		this.closed = false;
		FakeEventSource.last = this;
		FakeEventSource.instances.push( this );
	}
	addEventListener( name, cb ) {
		( this.listeners[ name ] ||= [] ).push( cb );
	}
	close() {
		this.closed = true;
	}
}

// `bytes` is the source's current size — the Log Viewer's replay boundary.
const sourcesReply = () => [
	{ name: 'debug', path: '/d', mode: 'file', available: false, bytes: null },
	{ name: 'access', path: '/a', mode: 'file', available: true, bytes: 977 },
];

beforeEach( () => {
	jest.useFakeTimers();
	Core.reset();
	FakeEventSource.last = null;
	FakeEventSource.instances = [];
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

afterEach( () => {
	// Never useRealTimers() — see jest-node-timers.js. Just drop pending work.
	jest.clearAllTimers();
} );

describe( 'useLogViewerGraph — recovery from a refused catalog', () => {
	it( 'a later reconcile restores the picker AND opens the default source', async () => {
		// The server refuses `taillog sources` until `refused` is cleared.
		let refused = true;
		installFakeCommandWire( ( m ) =>
			refused
				? new Error( 'verification failed' )
				: sourcesReply( m[ VALUE ] )
		);

		const { result } = renderHook( () => useLogViewerGraph() );
		await act( async () => {} );
		expect( result.current.sources ).toEqual( [] );
		expect( FakeEventSource.instances.length ).toBe( 0 );

		refused = false;
		// The catalog polls on its own cadence, not every tick.
		await act( async () => {
			jest.advanceTimersByTime( 11000 );
		} );
		await act( async () => {} );

		expect( result.current.sources ).toEqual( sourcesReply() );
		// The half the picker cannot supply: a selection and an open stream.
		expect( Core.node( 'logviewer:view' ).selected ).toBe( 'access' );
		expect( FakeEventSource.last?.url ).toContain( 'subscribe=access' );
	} );

	it( 'a settled catalog is NOT re-selected, so a user pick survives', async () => {
		installFakeCommandWire( () => sourcesReply() );
		const { result } = renderHook( () => useLogViewerGraph() );
		await act( async () => {} );
		await act( async () => result.current.selectSource( 'debug' ) );

		// Every later catalog TICK must leave the pick alone — the catalog is
		// polled now, so this is the thing that would clobber it.
		await act( async () => {
			jest.advanceTimersByTime( 5000 );
		} );
		await act( async () => {} );

		expect( Core.node( 'logviewer:view' ).selected ).toBe( 'debug' );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=debug' );
	} );
} );
