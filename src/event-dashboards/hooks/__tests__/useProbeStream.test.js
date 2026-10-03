/**
 * useProbeStream tests — one RemoteLink tailing each declared probe log into
 * its view, on the canonical backbone, parameterised over
 * EventSource is faked; a `msg` frame driven through it must route link → view
 * keyed as the view keys it, and the mode must select the seek.
 */

import { renderHook, act } from '@testing-library/react';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { Core } from '../../../runtime/core';
import { SEEK_START, SEEK_END } from '../../../runtime/sse-in-node';
import { Node } from '../../../runtime/node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	TIMESTAMP,
	VALUE,
	TM_STRUCT,
} from '../../../runtime/message';
import * as Probe from '../../../runtime/probe-record';
import * as Job from '../../../runtime/jobstats-record';
import * as Tbl from '../../../runtime/tablestats-record';
import { useProbeStream } from '../useProbeStream';

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
	// The seam is the wire; no command in this suite expects a reply.
	installFakeCommandWire( () => undefined );
	Core.reset();
	FakeEventSource.last = null;
	FakeEventSource.instances = [];
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
} );

// The views drop records older than 24h; ts is an OFFSET into the live window.
const TS_BASE = Math.floor( Date.now() / 1000 ) - 10000;

/** One frame per declared stream, keyed as its view keys it. */
const FRAMES = {
	topicprobe: {
		subscribe: 'topicprobe.p0',
		key: 'firehose.p0',
		value: () => {
			const v = [];
			v[ Probe.SOURCE ] = 'firehose.p0';
			v[ Probe.READER ] = 'firehose.p0';
			v[ Probe.MSGS_DELTA ] = 3000;
			// Distinct from the msgs delta, so a view reading the wrong field
			// cannot pass.
			v[ Probe.BYTES_READ_DELTA ] = 61000;
			v[ Probe.ELAPSED_MS ] = 3000;
			return v;
		},
		detail: ( entry ) => {
			expect( entry.source ).toBe( 'firehose.p0' );
			// 3000 msgs over the record's own 3s window.
			expect( entry.latest.msgRate ).toBe( 1000 );
		},
	},
	jobstats: {
		subscribe: 'jobstats.p0',
		key: 'cron:films',
		value: () => {
			const v = [];
			v[ Job.IDENTITY ] = 'cron:films';
			v[ Job.HANDLER ] = 'cron';
			v[ Job.RUNS_DELTA ] = 3;
			v[ Job.ELAPSED_MS ] = 15000;
			return v;
		},
		detail: ( entry ) => {
			expect( entry.handler ).toBe( 'cron' );
		},
	},
	tablestats: {
		subscribe: 'tablestats.p0',
		key: 'lab-7:kea.p3',
		value: () => {
			const v = [];
			v[ Tbl.IDENTITY ] = 'lab-7:kea.p3';
			v[ Tbl.BACKEND ] = 'sqlite';
			v[ Tbl.VERBS ] = { GET: [ 1, 1, 1, 0, 0.5, 0.5, 0 ] };
			v[ Tbl.PURGE_BEHIND ] = 0;
			v[ Tbl.WAL_STALLED ] = 0;
			v[ Tbl.FILE_BYTES ] = 0;
			v[ Tbl.ELAPSED_MS ] = 15000;
			return v;
		},
		detail: ( entry ) => {
			expect( entry.backend ).toBe( 'sqlite' );
			expect( entry.windowed.ops ).toBe( 1 );
		},
	},
};

/**
 * Build the TM_STRUCT a probe sweep leaves in its log.
 *
 * @param {string} name Declared stream name.
 * @param {number} ts   Offset into the live window, in seconds.
 * @return {Array} The message.
 */
function frame( name, ts = 100 ) {
	const m = newMessage();
	m[ TYPE ] = TM_STRUCT;
	m[ FROM ] = `${ name }.p0`;
	// A replayed record carries a server-side TO; RemoteLink must re-home it.
	m[ TO ] = name;
	m[ TIMESTAMP ] = TS_BASE + ts;
	m[ VALUE ] = FRAMES[ name ].value();
	return m;
}

describe.each( Object.keys( FRAMES ) )( 'useProbeStream( %s )', ( name ) => {
	const LINK = `${ name }:link`;
	const TEE = `${ name }:stream`;
	const VIEW = `${ name }:view`;
	const SUB = FRAMES[ name ].subscribe;

	it( 'mounts the backbone, the link and the view', async () => {
		renderHook( () => useProbeStream( name, { mode: 'follow' } ) );
		await act( async () => {} );
		expect( Core.node( '_command_interpreter' ) ).toBeTruthy();
		expect( Core.node( LINK ) ).toBeTruthy();
		expect( Core.node( VIEW ) ).toBeTruthy();
		expect( Core.node( LINK ).sseIn.subscribe ).toEqual( [ SUB ] );
		expect( FakeEventSource.last.url ).toContain( `subscribe=${ SUB }` );
	} );

	it( 'makes the link with a token-free (subscribe-only) argument string', async () => {
		renderHook( () => useProbeStream( name, { mode: 'follow' } ) );
		await act( async () => {} );
		// baseUrl/nonce come from the localized global, NOT make_node tokens.
		expect( Core.node( LINK ).arguments ).toEqual( [ SUB ] );
	} );

	it( "mode:'history' seeks the log from its start", async () => {
		renderHook( () => useProbeStream( name, { mode: 'history' } ) );
		await act( async () => {} );
		expect( FakeEventSource.last.url ).toContain( 'positions=' );
		expect( FakeEventSource.last.url ).toContain(
			encodeURIComponent( JSON.stringify( { [ SUB ]: SEEK_START } ) )
		);
	} );

	it( "mode:'follow' asks for the tail, not a replay", async () => {
		renderHook( () => useProbeStream( name, { mode: 'follow' } ) );
		await act( async () => {} );
		expect( FakeEventSource.last.url ).toContain(
			encodeURIComponent( JSON.stringify( { [ SUB ]: SEEK_END } ) )
		);
	} );

	it( 'inserts an inspectable Tee on the stream edge: link → tee → view', async () => {
		renderHook( () => useProbeStream( name, { mode: 'follow' } ) );
		await act( async () => {} );
		const interpreter = Core.node( '_command_interpreter' );
		const tee = Core.node( TEE );
		expect( tee ).toBeTruthy();
		expect( tee.constructor.name ).toBe( 'TeeNode' );
		expect( tee.sink ).toBe( interpreter );
		// The link re-homes received frames to the Tee, which fans to the view.
		expect( Core.node( LINK ).sseIn.target ).toBe( TEE );
		expect( tee.target ).toEqual( [ VIEW ] );
	} );

	it( 'fans the live stream to a debug-overlay watcher without disturbing the view', async () => {
		renderHook( () => useProbeStream( name, { mode: 'follow' } ) );
		await act( async () => {} );
		const watcher = new Node();
		watcher.name = 'watcher';
		const seen = [];
		watcher.fill = ( m ) => seen.push( m[ VALUE ] );
		Core.node( TEE ).connectNode( 'watcher' );
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				JSON.stringify( frame( name ) )
			);
		} );
		// The watcher saw the raw record AND the view accumulated it.
		// The wire carries a sparse slot as null.
		expect( seen ).toEqual( [
			JSON.parse( JSON.stringify( FRAMES[ name ].value() ) ),
		] );
		expect(
			Core.node( VIEW ).snapshot()[ FRAMES[ name ].key ]
		).toBeTruthy();
	} );

	it( 'routes a frame through the link into the view, keyed', async () => {
		renderHook( () => useProbeStream( name, { mode: 'follow' } ) );
		await act( async () => {} );
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				JSON.stringify( frame( name ) )
			);
		} );
		const entry = Core.node( VIEW ).snapshot()[ FRAMES[ name ].key ];
		expect( entry ).toBeTruthy();
		FRAMES[ name ].detail( entry );
	} );

	it( 'reconnects (re-seeking history) after a graph rebuild drops + recreates the link', async () => {
		renderHook( () => useProbeStream( name, { mode: 'history' } ) );
		await act( async () => {} );
		const firstLink = Core.node( LINK );
		const before = FakeEventSource.instances.length;

		await act( async () => {
			Core.bumpGraphGeneration();
		} );

		expect( Core.node( LINK ) ).not.toBe( firstLink );
		expect( FakeEventSource.instances.length ).toBeGreaterThan( before );
		expect( FakeEventSource.last.url ).toContain(
			encodeURIComponent( JSON.stringify( { [ SUB ]: SEEK_START } ) )
		);
	} );
} );

describe( 'useProbeStream( topicprobe ) series', () => {
	it( 'folds successive records into a rate/backlog series', async () => {
		renderHook( () => useProbeStream( 'topicprobe' ) );
		await act( async () => {} );
		const second = frame( 'topicprobe', 103 );
		second[ VALUE ][ Probe.DISTANCE ] = 7800;
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				JSON.stringify( frame( 'topicprobe', 100 ) )
			);
			FakeEventSource.last.dispatch( 'msg', JSON.stringify( second ) );
		} );
		const entry =
			Core.node( 'topicprobe:view' ).snapshot()[ 'firehose.p0' ];
		expect( entry.latest.msgRate ).toBe( 1000 );
		expect( entry.latest.backlog ).toBe( 7800 );
	} );
} );

it( 'refuses a stream nobody declared', () => {
	// React logs the render throw; shadow the setup's console recorder.
	jest.spyOn( console, 'error' ).mockImplementation( () => {} );
	expect( () => renderHook( () => useProbeStream( 'nosuch-4410' ) ) ).toThrow(
		TypeError
	);
} );

it( 'refuses a mode nobody declared, as the shared tail does', () => {
	jest.spyOn( console, 'error' ).mockImplementation( () => {} );
	expect( () =>
		renderHook( () =>
			useProbeStream( 'jobstats', { mode: 'nosuch-4410' } )
		)
	).toThrow( TypeError );
} );
