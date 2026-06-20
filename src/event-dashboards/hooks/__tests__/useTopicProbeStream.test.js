/**
 * useTopicProbeStream tests — one RemoteLink tailing topicprobe.p0 into a
 * TopicProbeView, on the canonical backbone. EventSource is faked; we drive a
 * `msg` probe frame through it and assert it routes link → view (accumulated as
 * a per-offset_dir rate/backlog series), and that the mode selects the seek.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import {
	newMessage,
	TYPE,
	FROM,
	VALUE,
	TM_STRUCT,
} from '../../../runtime/message';

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
	dispatch( name, data ) {
		( this.listeners[ name ] || [] ).forEach( ( cb ) => cb( { data } ) );
	}
}

beforeEach( () => {
	Core.reset();
	FakeEventSource.last = null;
	FakeEventSource.instances = [];
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

import { useTopicProbeStream } from '../useTopicProbeStream';

const LINK = 'topicprobe:link';
const VIEW = 'topicprobe:view';

const fakeClient = () => ( { postBatch: () => Promise.resolve( [] ) } );

function probeFrame( overrides = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ FROM ] = 'topicprobe.p0';
	m[ VALUE ] = {
		ts: 1000,
		consumer: 'firehose:consumer',
		offset_dir: 'firehose.p0',
		source: 'firehose.p0',
		worker_type: 'combined',
		bytes_read: 0,
		bytes_behind: 0,
		...overrides,
	};
	return m;
}

describe( 'useTopicProbeStream', () => {
	it( 'mounts the backbone + a RemoteLink to topicprobe.p0 + the view', async () => {
		renderHook( () =>
			useTopicProbeStream( {
				mode: 'follow',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		expect( Core.node( '_command_interpreter' ) ).toBeTruthy();
		expect( Core.node( LINK ) ).toBeTruthy();
		expect( Core.node( VIEW ) ).toBeTruthy();
		expect( Core.node( LINK ).sseIn.subscribe ).toEqual( [
			'topicprobe.p0',
		] );
		expect( FakeEventSource.last.url ).toContain(
			'subscribe=topicprobe.p0'
		);
	} );

	it( "mode:'history' seeks from start (positions in the stream URL)", async () => {
		renderHook( () =>
			useTopicProbeStream( {
				mode: 'history',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		expect( FakeEventSource.last.url ).toContain( 'positions=' );
		expect( FakeEventSource.last.url ).toContain(
			encodeURIComponent(
				JSON.stringify( { 'topicprobe.p0': { 0: 'start' } } )
			)
		);
	} );

	it( "mode:'follow' tail-seeks (no positions param)", async () => {
		renderHook( () =>
			useTopicProbeStream( {
				mode: 'follow',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		expect( FakeEventSource.last.url ).not.toContain( 'positions=' );
	} );

	it( 'routes a probe frame through the link into the view as a rate/backlog series', async () => {
		renderHook( () =>
			useTopicProbeStream( {
				mode: 'follow',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				JSON.stringify(
					probeFrame( {
						bytes_read: 1000,
						bytes_behind: 50,
						ts: 100,
					} )
				)
			);
			FakeEventSource.last.dispatch(
				'msg',
				JSON.stringify(
					probeFrame( {
						bytes_read: 4000,
						bytes_behind: 7800,
						ts: 103,
					} )
				)
			);
		} );
		const snap = Core.node( VIEW ).snapshot();
		expect( snap[ 'firehose.p0' ] ).toBeTruthy();
		expect( snap[ 'firehose.p0' ].latest.rate ).toBe( 1000 );
		expect( snap[ 'firehose.p0' ].latest.backlog ).toBe( 7800 );
		expect( snap[ 'firehose.p0' ].worker_type ).toBe( 'combined' );
	} );
} );
