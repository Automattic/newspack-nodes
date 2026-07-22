/**
 * useLogViewerGraph tests — the Log Viewer dashboard graph. Same RemoteLink →
 * Tee → view backbone as the Partition Viewer, but the link opens the substrate's
 * `GET /log/stream` (endpoint override) and the catalog is the interpreter
 * builtin `taillog sources` (empty TO), replying with `{ name, path, mode,
 * available }` source rows that feed the picker.
 */

import { renderHook, act } from '@testing-library/react';
import {
	newMessage,
	pack,
	TYPE,
	KEY,
	VALUE,
	TIMESTAMP,
	TO,
	FROM,
	ID,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_BYTESTREAM,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { mountExospine } from '../../../runtime/exospine';
import names from '../../../runtime/reserved-node-names.json';

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

import { useLogViewerGraph } from '../useLogViewerGraph';

const LINK = 'logviewer:link';
const VIEW = 'logviewer:view';
const HTTP = names.HTTP;

// CommandClient double: postBatch echoes a reply per verb name along FROM.
// A verb in `errorVerbs` replies TM_ERROR so a rejected pending-reply is exercised.
function makeFakeClient( payloadByVerb = {}, errorVerbs = [] ) {
	const client = {
		batches: [],
		postBatch( messages ) {
			client.batches.push( messages );
			const replies = messages.map( ( m ) => {
				const reply = newMessage();
				reply[ TYPE ] = errorVerbs.includes( m[ VALUE ]?.name )
					? TM_COMMAND | TM_RESPONSE | TM_ERROR
					: TM_COMMAND | TM_RESPONSE;
				reply[ TO ] = m[ FROM ];
				reply[ ID ] = m[ ID ];
				reply[ TIMESTAMP ] = 0;
				reply[ VALUE ] = {
					name: m[ VALUE ]?.name,
					payload:
						payloadByVerb[ m[ VALUE ]?.name ] ??
						payloadByVerb._default ??
						null,
				};
				return reply;
			} );
			return Promise.resolve( replies );
		},
	};
	return client;
}

// debug listed first but unavailable; access is the first AVAILABLE source.
// `bytes` is the source's current file size — the Log Viewer replay boundary.
const sourcesReply = () => [
	{ name: 'debug', path: '/d', mode: 'file', available: false, bytes: null },
	{ name: 'access', path: '/a', mode: 'file', available: true, bytes: 977 },
];

function mountGraph( client ) {
	return renderHook( () => useLogViewerGraph( { commandClient: client } ) );
}

describe( 'useLogViewerGraph', () => {
	test( 'mounts a RemoteLink pointed at /log/stream and the raw-line view', async () => {
		mountGraph( makeFakeClient( { taillog: sourcesReply() } ) );
		await act( async () => {} );
		const link = Core.node( LINK );
		expect( link ).toBeTruthy();
		expect( link.endpoint ).toBe( 'newspack-nodes/v1/log/stream' );
		expect( Core.node( VIEW ) ).toBeTruthy();
		expect( Core.node( VIEW ).sink ).toBe(
			Core.node( '_command_interpreter' )
		);
		expect( Core.node( HTTP ).client ).toBeTruthy();
	} );

	test( 'catalogs via the taillog-sources interpreter builtin (empty TO)', async () => {
		const client = makeFakeClient( { taillog: sourcesReply() } );
		mountGraph( client );
		await act( async () => {} );
		const cmd = client.batches
			.flat()
			.find( ( m ) => 'taillog' === m[ VALUE ]?.name );
		expect( cmd ).toBeTruthy();
		expect( cmd[ TO ] ).toBe( '' );
		expect( cmd[ VALUE ].arguments ).toEqual( [ 'sources' ] );
	} );

	test( 'opens the stream on the first AVAILABLE source over /log/stream', async () => {
		mountGraph( makeFakeClient( { taillog: sourcesReply() } ) );
		await act( async () => {} );
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/log/stream'
		);
		expect( FakeEventSource.last.url ).toContain( 'subscribe=access' );
		expect( Core.node( VIEW ).setStateCache.view.selected ).toBe(
			'access'
		);
	} );

	test( 'returns the source catalog for the picker', async () => {
		const { result } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() } )
		);
		await act( async () => {} );
		expect( result.current.sources ).toEqual( sourcesReply() );
	} );

	test( 'an empty catalog leaves the picker empty and opens nothing new', async () => {
		const { result } = mountGraph( makeFakeClient( { taillog: [] } ) );
		await act( async () => {} );
		expect( result.current.sources ).toEqual( [] );
	} );

	test( 'selectSource re-subscribes the stream and records the pick', async () => {
		const { result } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() } )
		);
		await act( async () => {} );
		const before = FakeEventSource.last;
		act( () => result.current.selectSource( 'debug' ) );
		expect( before.closed ).toBe( true );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=debug' );
		expect( Core.node( VIEW ).setStateCache.view.selected ).toBe( 'debug' );
	} );

	test( 'seek repositions the current source with a positions seed', async () => {
		const { result } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() } )
		);
		await act( async () => {} );
		// Replay first captures the fresh byte size, then reopens the stream.
		await act( async () =>
			result.current.seek( 'access', { access: 'start' } )
		);
		const url = FakeEventSource.last.url;
		expect( url ).toContain( 'positions=' );
		const positions = JSON.parse(
			decodeURIComponent(
				url.split( 'positions=' )[ 1 ].split( '&' )[ 0 ]
			)
		);
		expect( positions ).toEqual( { access: 'start' } );
	} );

	test( 'replay captures the source byte size as the file-mode boundary', async () => {
		const { result } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() } )
		);
		await act( async () => {} );
		await act( async () =>
			result.current.seek( 'access', { access: 'start' } )
		);
		const view = Core.node( VIEW );
		expect( view.mode ).toBe( 'replay' );
		expect( view.seek.fileMode ).toBe( true );
		expect( view.seek.endOffset ).toBe( 977 );
	} );

	test( 'replay re-dispatches taillog sources for a FRESH size (mount catalog is stale)', async () => {
		const client = makeFakeClient( { taillog: sourcesReply() } );
		const { result } = mountGraph( client );
		await act( async () => {} );
		client.batches.length = 0; // ignore the mount-time catalog fetch
		await act( async () =>
			result.current.seek( 'access', { access: 'start' } )
		);
		const cmd = client.batches
			.flat()
			.find( ( m ) => 'taillog' === m[ VALUE ]?.name );
		expect( cmd ).toBeTruthy();
		expect( cmd[ VALUE ].arguments ).toEqual( [ 'sources' ] );
	} );

	test( 'a seek-time fetch failure replays with NO boundary (degraded; never auto-flips)', async () => {
		// taillog errors → the fresh-size fetch rejects → the view enters replay
		// with no byte boundary (file mode off), so it never auto-flips.
		const { result } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() }, [ 'taillog' ] )
		);
		await act( async () => {} );
		await act( async () =>
			result.current.seek( 'access', { access: 'start' } )
		);
		const view = Core.node( VIEW );
		expect( view.mode ).toBe( 'replay' );
		expect( view.seek.fileMode ).toBe( false );
	} );

	test( 'replay on an EMPTY source flips straight to Live (nothing to replay)', async () => {
		const empty = [
			{
				name: 'access',
				path: '/a',
				mode: 'file',
				available: true,
				bytes: 0,
			},
		];
		const { result } = mountGraph( makeFakeClient( { taillog: empty } ) );
		await act( async () => {} );
		await act( async () =>
			result.current.seek( 'access', { access: 'start' } )
		);
		expect( Core.node( VIEW ).mode ).toBe( 'live' );
	} );

	test( 'setPaused toggles the view paused flag', async () => {
		const { result } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() } )
		);
		await act( async () => {} );
		act( () => result.current.setPaused( true ) );
		expect( Core.node( VIEW ).setStateCache.view.paused ).toBe( true );
	} );

	test( 'unmount tears down the link, view, and closes the EventSource', async () => {
		const { unmount } = mountGraph(
			makeFakeClient( { taillog: sourcesReply() } )
		);
		await act( async () => {} );
		const es = FakeEventSource.last;
		unmount();
		expect( es.closed ).toBe( true );
		expect( Core.node( LINK ) ).toBeNull();
		expect( Core.node( VIEW ) ).toBeNull();
	} );

	describe( 'visibility gating', () => {
		const setVisibility = ( state ) => {
			Object.defineProperty( document, 'visibilityState', {
				value: state,
				configurable: true,
			} );
			act( () => {
				document.dispatchEvent( new Event( 'visibilitychange' ) );
			} );
		};
		afterEach( () => setVisibility( 'visible' ) );

		test( 'closes the stream when hidden and reopens the source when visible', async () => {
			mountGraph( makeFakeClient( { taillog: sourcesReply() } ) );
			await act( async () => {} );
			const open = FakeEventSource.last;
			act( () => setVisibility( 'hidden' ) );
			expect( open.closed ).toBe( true );
			const before = FakeEventSource.instances.length;
			act( () => setVisibility( 'visible' ) );
			expect( FakeEventSource.instances.length ).toBe( before + 1 );
			expect( FakeEventSource.last.url ).toContain( 'subscribe=access' );
		} );
	} );

	describe( 'pause disconnects / play resumes', () => {
		const setVisibility = ( state ) => {
			Object.defineProperty( document, 'visibilityState', {
				value: state,
				configurable: true,
			} );
			act( () => {
				document.dispatchEvent( new Event( 'visibilitychange' ) );
			} );
		};
		afterEach( () => setVisibility( 'visible' ) );

		test( 'setPaused(true) closes the EventSource (frees the server slot), not just the view flag', async () => {
			const { result } = mountGraph(
				makeFakeClient( { taillog: sourcesReply() } )
			);
			await act( async () => {} );
			const open = FakeEventSource.last;
			expect( open.closed ).toBe( false );
			act( () => result.current.setPaused( true ) );
			expect( open.closed ).toBe( true );
			expect( Core.node( VIEW ).setStateCache.view.paused ).toBe( true );
		} );

		test( 'setPaused(false) resumes at the paused offset (reopen carries &positions=)', async () => {
			const { result } = mountGraph(
				makeFakeClient( { taillog: sourcesReply() } )
			);
			await act( async () => {} );
			// A streamed line stamps segment:offset in ID + the source in FROM.
			const env = newMessage();
			env[ TYPE ] = TM_BYTESTREAM;
			env[ KEY ] = '';
			env[ FROM ] = 'access';
			env[ ID ] = '5:900:60';
			env[ VALUE ] = 'a raw log line';
			act( () => FakeEventSource.last.dispatch( 'msg', pack( env ) ) );
			act( () => result.current.setPaused( true ) );
			const before = FakeEventSource.instances.length;
			act( () => result.current.setPaused( false ) );
			expect( FakeEventSource.instances.length ).toBe( before + 1 );
			const url = FakeEventSource.last.url;
			expect( url ).toContain( 'positions=' );
			const positions = JSON.parse(
				decodeURIComponent(
					url.split( 'positions=' )[ 1 ].split( '&' )[ 0 ]
				)
			);
			expect( positions ).toEqual( {
				access: { segment: 5, offset: 900 + 60 },
			} );
		} );

		test( 'a user pause outranks a visibility refocus: pause → hide → refocus stays CLOSED', async () => {
			const { result } = mountGraph(
				makeFakeClient( { taillog: sourcesReply() } )
			);
			await act( async () => {} );
			const open = FakeEventSource.last;
			act( () => result.current.setPaused( true ) );
			expect( open.closed ).toBe( true );
			const afterPause = FakeEventSource.instances.length;
			act( () => setVisibility( 'hidden' ) );
			act( () => setVisibility( 'visible' ) );
			expect( FakeEventSource.instances.length ).toBe( afterPause );
			expect( FakeEventSource.last.closed ).toBe( true );
		} );

		test( 'reinit while paused re-publishes paused:true and does NOT reopen the stream', async () => {
			mountExospine();
			const { result } = mountGraph(
				makeFakeClient( { taillog: sourcesReply() } )
			);
			await act( async () => {} );
			act( () => result.current.setPaused( true ) );
			const afterPause = FakeEventSource.instances.length;
			await act( async () => {
				Core.bumpGraphGeneration();
			} );
			expect( Core.node( VIEW ).setStateCache.view.paused ).toBe( true );
			expect( FakeEventSource.instances.length ).toBe( afterPause );
		} );

		test( 'selectSource while paused does NOT reopen the stream (stays closed)', async () => {
			const { result } = mountGraph(
				makeFakeClient( { taillog: sourcesReply() } )
			);
			await act( async () => {} );
			act( () => result.current.setPaused( true ) );
			const closed = FakeEventSource.last;
			const count = FakeEventSource.instances.length;
			act( () => result.current.selectSource( 'debug' ) );
			expect( FakeEventSource.instances.length ).toBe( count );
			expect( closed.closed ).toBe( true );
			expect( Core.node( VIEW ).setStateCache.view.selected ).toBe(
				'debug'
			);
		} );

		test( 'Play after a paused selectSource opens the NEW source (tail)', async () => {
			const { result } = mountGraph(
				makeFakeClient( { taillog: sourcesReply() } )
			);
			await act( async () => {} );
			act( () => result.current.setPaused( true ) );
			act( () => result.current.selectSource( 'debug' ) );
			const before = FakeEventSource.instances.length;
			act( () => result.current.setPaused( false ) );
			expect( FakeEventSource.instances.length ).toBe( before + 1 );
			expect( FakeEventSource.last.url ).toContain( 'subscribe=debug' );
		} );

		test( 'seek while paused does NOT reopen the stream', async () => {
			const { result } = mountGraph(
				makeFakeClient( { taillog: sourcesReply() } )
			);
			await act( async () => {} );
			act( () => result.current.setPaused( true ) );
			const count = FakeEventSource.instances.length;
			await act( async () =>
				result.current.seek( 'access', { access: 'start' } )
			);
			expect( FakeEventSource.instances.length ).toBe( count );
		} );

		test( 'Play after a paused seek replays the source and the tracker flips at the boundary', async () => {
			const { result } = mountGraph(
				makeFakeClient( { taillog: sourcesReply() } )
			);
			await act( async () => {} );
			act( () => result.current.setPaused( true ) );
			await act( async () =>
				result.current.seek( 'access', { access: 'start' } )
			);
			// The seek control still drove the view into replay while paused.
			expect( Core.node( VIEW ).mode ).toBe( 'replay' );
			act( () => result.current.setPaused( false ) );
			// The reopened stream replays from the seeked seed, not a stale tail.
			const url = FakeEventSource.last.url;
			expect( url ).toContain( 'positions=' );
			// File-mode replay flips to Live once a record reaches the byte size.
			const rec = newMessage();
			rec[ TYPE ] = TM_BYTESTREAM;
			rec[ KEY ] = '';
			rec[ FROM ] = 'access';
			rec[ ID ] = '1:900:100';
			rec[ VALUE ] = 'caught up';
			act( () => FakeEventSource.last.dispatch( 'msg', pack( rec ) ) );
			expect( Core.node( VIEW ).mode ).toBe( 'live' );
		} );
	} );
} );
