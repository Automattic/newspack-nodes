/**
 * useLogTailStream tests — the ONE parameterised probe-log tail. The per-log
 * hooks were byte-identical copies of this graph differing only in their names,
 * their subscription and their view class, so what is asserted here is the
 * derivation itself: `<name>:link → <name>:stream → <name>:view`, the seek
 * `mode` picks, and that an unrecognised mode fails LOUD instead of silently
 * tail-seeking away a replay.
 */

import { renderHook, act } from '@testing-library/react';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { Core } from '../../../runtime/core';

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

beforeEach( () => {
	installFakeCommandWire( () => undefined );
	Core.reset();
	FakeEventSource.last = null;
	FakeEventSource.instances = [];
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

import { useLogTailStream } from '../useLogTailStream';
import { SEEK_START, SEEK_END } from '../../../runtime/sse-in-node';

// Distinct from every shipped stream, so a hardcoded name cannot pass this.
const STREAM = {
	name: 'cachecozy',
	subscribe: 'cachecozy.p0',
	viewType: 'TopicProbeView',
};

describe( 'useLogTailStream', () => {
	it( 'derives link, stream Tee and view from the stream name', async () => {
		renderHook( () => useLogTailStream( { ...STREAM, mode: 'follow' } ) );
		await act( async () => {} );
		expect( Core.node( 'cachecozy:link' ) ).toBeTruthy();
		expect( Core.node( 'cachecozy:link' ).target ).toBe(
			'cachecozy:stream'
		);
		expect( Core.node( 'cachecozy:stream' ) ).toBeTruthy();
		expect( Core.node( 'cachecozy:view' ) ).toBeTruthy();
		expect( Core.node( 'cachecozy:link' ).sseIn.subscribe ).toEqual( [
			'cachecozy.p0',
		] );
	} );

	it( "mode:'history' seeds positions=start on the subscription", async () => {
		renderHook( () => useLogTailStream( { ...STREAM, mode: 'history' } ) );
		await act( async () => {} );
		expect( FakeEventSource.last.url ).toContain(
			encodeURIComponent(
				JSON.stringify( { 'cachecozy.p0': SEEK_START } )
			)
		);
	} );

	it( "mode:'follow' asks for the tail, not a replay", async () => {
		renderHook( () => useLogTailStream( { ...STREAM, mode: 'follow' } ) );
		await act( async () => {} );
		expect( FakeEventSource.last.url ).toContain(
			encodeURIComponent( JSON.stringify( { 'cachecozy.p0': SEEK_END } ) )
		);
	} );

	it( 'REFUSES an unrecognised mode rather than dropping the replay', () => {
		// React logs the render throw; shadow the setup's console recorder.
		jest.spyOn( console, 'error' ).mockImplementation( () => {} );
		expect( () =>
			renderHook( () =>
				useLogTailStream( { ...STREAM, mode: 'histroy' } )
			)
		).toThrow( /histroy/ );
	} );
} );
