/**
 * useJobstatsStream tests — one RemoteLink tailing jobstats.p0 into a JobstatsView,
 * on the canonical backbone. EventSource is faked; we drive a jobstats frame through
 * it and assert it routes link → view (accumulated per identity key), and that the
 * mode selects the seek.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	TIMESTAMP,
	VALUE,
	TM_STRUCT,
} from '../../../runtime/message';
import {
	KEY,
	HANDLER,
	RUNS_DELTA,
	ELAPSED_MS,
} from '../../../runtime/jobstats-record';

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

import { useJobstatsStream } from '../useJobstatsStream';

const LINK = 'jobstats:link';
const VIEW = 'jobstats:view';

const fakeClient = () => ( { postBatch: () => Promise.resolve( [] ) } );

// The view drops records older than 24h; ts is an OFFSET into the live window.
const TS_BASE = Math.floor( Date.now() / 1000 ) - 10000;

function jobstatsFrame( {
	ts = 1000,
	key = 'evtemplate',
	handler = 'evtemplate',
	runs = 0,
	elapsedMs = 15000,
} = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ FROM ] = 'jobstats.p0';
	m[ TO ] = 'jobstats';
	m[ TIMESTAMP ] = TS_BASE + ts;
	const v = [];
	v[ KEY ] = key;
	v[ HANDLER ] = handler;
	v[ RUNS_DELTA ] = runs;
	v[ ELAPSED_MS ] = elapsedMs;
	m[ VALUE ] = v;
	return m;
}

describe( 'useJobstatsStream', () => {
	it( 'mounts the backbone + a RemoteLink to jobstats.p0 + the view', async () => {
		renderHook( () =>
			useJobstatsStream( { mode: 'follow', commandClient: fakeClient() } )
		);
		await act( async () => {} );
		expect( Core.node( '_command_interpreter' ) ).toBeTruthy();
		expect( Core.node( LINK ) ).toBeTruthy();
		expect( Core.node( VIEW ) ).toBeTruthy();
		expect( Core.node( LINK ).sseIn.subscribe ).toEqual( [
			'jobstats.p0',
		] );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=jobstats.p0' );
	} );

	it( "mode:'history' seeks from start (positions in the stream URL)", async () => {
		renderHook( () =>
			useJobstatsStream( {
				mode: 'history',
				commandClient: fakeClient(),
			} )
		);
		await act( async () => {} );
		expect( FakeEventSource.last.url ).toContain(
			encodeURIComponent( JSON.stringify( { 'jobstats.p0': 'start' } ) )
		);
	} );

	it( "mode:'follow' tail-seeks (no positions param)", async () => {
		renderHook( () =>
			useJobstatsStream( { mode: 'follow', commandClient: fakeClient() } )
		);
		await act( async () => {} );
		expect( FakeEventSource.last.url ).not.toContain( 'positions=' );
	} );

	it( 'routes a jobstats frame through the link into the view keyed by identity', async () => {
		renderHook( () =>
			useJobstatsStream( { mode: 'follow', commandClient: fakeClient() } )
		);
		await act( async () => {} );
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				JSON.stringify(
					jobstatsFrame( {
						key: 'cron:films',
						handler: 'cron',
						runs: 3,
						ts: 100,
					} )
				)
			);
		} );
		const snap = Core.node( VIEW ).snapshot();
		expect( snap[ 'cron:films' ] ).toBeTruthy();
		expect( snap[ 'cron:films' ].handler ).toBe( 'cron' );
	} );
} );
