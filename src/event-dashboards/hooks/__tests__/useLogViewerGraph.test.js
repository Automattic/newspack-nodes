/**
 * useLogViewerGraph tests — the Log Viewer dashboard graph. Same RemoteLink →
 * Tee → view backbone as the Partition Viewer, but the link opens the substrate's
 * `GET /log/stream` (endpoint override) and the catalog is the interpreter
 * builtin `taillog sources` (empty TO), replying with `{ name, path, mode,
 * available, bytes, segments }` source rows that feed the picker, the segment
 * sidebar, and the replay boundary.
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import {
	newMessage,
	pack,
	TYPE,
	KEY,
	VALUE,
	TO,
	FROM,
	ID,
	TM_BYTESTREAM,
} from '../../../runtime/message';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';
import { Core } from '../../../runtime/core';
import { SEEK_END } from '../../../runtime/sse-in-node';
import { mountExospine } from '../../../runtime/exospine';
import { forgetSession, __setAuthFetch } from '../../../runtime/command-auth';
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

// The seam is the WIRE: the graph packs, POSTs and unpacks for real, so
// HttpOut, the router and the interpreter all run. `wire.batches` is what was
// posted. A verb in `errorVerbs` answers TM_ERROR, exercising a rejected
// pending reply.
function installWire( payloadByVerb = {}, errorVerbs = [] ) {
	return installFakeCommandWire( ( m ) => {
		const name = m[ VALUE ]?.name;
		return errorVerbs.includes( name )
			? new Error( name )
			: payloadByVerb[ name ] ?? payloadByVerb._default ?? null;
	} );
}

// debug listed first but unavailable; access is the first AVAILABLE source.
// `bytes` is the source's current file size — the Log Viewer replay boundary.
const sourcesReply = () => [
	{ name: 'debug', path: '/d', mode: 'file', available: false, bytes: null },
	{ name: 'access', path: '/a', mode: 'file', available: true, bytes: 977 },
];

function mountGraph() {
	return renderHook( () => useLogViewerGraph() );
}

describe( 'useLogViewerGraph', () => {
	test( 'mounts a RemoteLink pointed at /log/stream and the raw-line view', async () => {
		installWire( { taillog: sourcesReply() } );
		mountGraph();
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
		const wire = installWire( { taillog: sourcesReply() } );
		mountGraph();
		await act( async () => {} );
		const cmd = wire.batches
			.flat()
			.find( ( m ) => 'taillog' === m[ VALUE ]?.name );
		expect( cmd ).toBeTruthy();
		expect( cmd[ TO ] ).toBe( '' );
		expect( cmd[ VALUE ].arguments ).toEqual( [ 'sources' ] );
	} );

	/**
	 * The mount-time catalog raced /auth: markLocal set LOCAL but signCommand
	 * no-opped with no session, so the command went out with no `auth` and the
	 * server refused it as "verification failed: bad envelope". Routing through
	 * Node.command() makes that unconstructible — it gates on the session.
	 */
	test( 'signs the catalog command even when the session lands late', async () => {
		forgetSession();
		__setAuthFetch( async () => ( {
			handle: 'a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7',
			key: 'key-logviewer-late-auth',
			expires_in: 3600,
			now: 1771000000,
		} ) );
		const wire = installWire( { taillog: sourcesReply() } );
		mountGraph();
		await waitFor(
			() =>
				expect(
					wire.batches
						.flat()
						.find( ( m ) => 'taillog' === m[ VALUE ]?.name )
				).toBeTruthy(),
			{ timeout: 6000 }
		);

		const cmd = wire.batches
			.flat()
			.find( ( m ) => 'taillog' === m[ VALUE ]?.name );
		expect( cmd[ VALUE ].auth?.sig ).toMatch( /^[0-9a-f]{64}$/ );
	}, 15000 );

	test( 'opens the stream on the first AVAILABLE source over /log/stream', async () => {
		installWire( { taillog: sourcesReply() } );
		mountGraph();
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
		installWire( { taillog: sourcesReply() } );
		const { result } = mountGraph();
		await act( async () => {} );
		expect( result.current.sources ).toEqual( sourcesReply() );
	} );

	test( 'an empty catalog leaves the picker empty and opens nothing new', async () => {
		installWire( { taillog: [] } );
		const { result } = mountGraph();
		await act( async () => {} );
		expect( result.current.sources ).toEqual( [] );
	} );

	test( 'selectSource re-subscribes the stream and records the pick', async () => {
		installWire( { taillog: sourcesReply() } );
		const { result } = mountGraph();
		await act( async () => {} );
		const before = FakeEventSource.last;
		await act( async () => result.current.selectSource( 'debug' ) );
		expect( before.closed ).toBe( true );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=debug' );
		expect( Core.node( VIEW ).setStateCache.view.selected ).toBe( 'debug' );
	} );

	test( 'seek repositions the current source with a positions seed', async () => {
		installWire( { taillog: sourcesReply() } );
		const { result } = mountGraph();
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
		installWire( { taillog: sourcesReply() } );
		const { result } = mountGraph();
		await act( async () => {} );
		await act( async () =>
			result.current.seek( 'access', { access: 'start' }, { bytes: 977 } )
		);
		const view = Core.node( VIEW );
		expect( view.mode ).toBe( 'replay' );
		expect( view.seek.fileMode ).toBe( true );
		expect( view.seek.endOffset ).toBe( 977 );
	} );

	/**
	 * Was 'replay re-dispatches taillog sources for a FRESH size'. That round
	 * trip bought a boundary seconds newer at the cost of a failure path that
	 * stranded the user in Replay; both boundaries are approximate anyway,
	 * since the head segment grows during the fetch. The caller now passes the
	 * row it holds and re-catalogs on its own cadence.
	 */
	test( 'replay captures the boundary from the caller row, dispatching NO command', async () => {
		const wire = installWire( { taillog: sourcesReply() } );
		const { result } = mountGraph();
		await act( async () => {} );
		wire.batches.length = 0; // ignore the mount-time catalog fetch
		await act( async () =>
			result.current.seek( 'access', { access: 'start' }, { bytes: 977 } )
		);
		expect(
			wire.batches.flat().find( ( m ) => 'taillog' === m[ VALUE ]?.name )
		).toBeFalsy();
		expect( Core.node( VIEW ).seek.endOffset ).toBe( 977 );
	} );

	// A segmented source: the newest segment (id 5, 233 bytes) is the boundary.
	const segmentedReply = () => [
		{
			name: 'gate',
			path: '/g',
			mode: 'segmented',
			available: true,
			bytes: 233,
			segments: [
				{ id: 3, size: 977 },
				{ id: 5, size: 233 },
			],
		},
	];

	test( 'replay on a SEGMENTED source captures the newest segment as the boundary', async () => {
		installWire( { taillog: segmentedReply() } );
		const { result } = mountGraph();
		await act( async () => {} );
		await act( async () =>
			result.current.seek(
				'gate',
				{ gate: 'start' },
				segmentedReply()[ 0 ]
			)
		);
		const view = Core.node( VIEW );
		expect( view.mode ).toBe( 'replay' );
		expect( view.seek.fileMode ).toBe( false );
		expect( view.seek.endSegment ).toBe( 5 );
		expect( view.seek.endOffset ).toBe( 233 );
		// A record reaching the boundary auto-flips Replay → Live.
		const rec = newMessage();
		rec[ TYPE ] = TM_BYTESTREAM;
		rec[ KEY ] = '';
		rec[ FROM ] = 'gate';
		rec[ ID ] = '5:200:33';
		rec[ VALUE ] = 'caught up';
		act( () => FakeEventSource.last.dispatch( 'msg', pack( rec ) ) );
		expect( view.mode ).toBe( 'live' );
	} );

	test( 'browsing a SEGMENT rides positions and keeps the newest-segment boundary', async () => {
		installWire( { taillog: segmentedReply() } );
		const { result } = mountGraph();
		await act( async () => {} );
		await act( async () =>
			result.current.seek(
				'gate',
				{ gate: { segment: 3, offset: 0 } },
				segmentedReply()[ 0 ]
			)
		);
		const url = FakeEventSource.last.url;
		const positions = JSON.parse(
			decodeURIComponent(
				url.split( 'positions=' )[ 1 ].split( '&' )[ 0 ]
			)
		);
		expect( positions ).toEqual( { gate: { segment: 3, offset: 0 } } );
		expect( Core.node( VIEW ).seek.endSegment ).toBe( 5 );
	} );

	// Picking a source no longer re-asks for the catalog: the poll already
	// keeps the sidebar's segments fresh, and asking again was a round trip
	// per click for something arriving anyway.
	test( 'selectSource re-opens the stream without re-asking for the catalog', async () => {
		const wire = installWire( { taillog: sourcesReply() } );
		const { result } = mountGraph();
		await act( async () => {} );
		const asked = wire.batches
			.flat()
			.filter( ( m ) => 'taillog' === m[ VALUE ]?.name ).length;

		act( () => result.current.selectSource( 'debug' ) );

		expect( FakeEventSource.last.url ).toContain( 'subscribe=debug' );
		expect(
			wire.batches
				.flat()
				.filter( ( m ) => 'taillog' === m[ VALUE ]?.name ).length
		).toBe( asked );
	} );

	test( 'a stale seek does NOT reposition after the selection moved on', async () => {
		installWire( { taillog: sourcesReply() } );
		const { result } = mountGraph();
		await act( async () => {} );
		await act( async () => {
			// Replay 'access' starts its catalog fetch…
			result.current.seek( 'access', { access: 'start' } );
			// …but the user switches source before it resolves.
			result.current.selectSource( 'debug' );
		} );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=debug' );
		// Tails the NEW source; the abandoned `access: start` must not ride along.
		expect(
			JSON.parse(
				decodeURIComponent(
					FakeEventSource.last.url.split( 'positions=' )[ 1 ]
				)
			)
		).toEqual( { debug: SEEK_END } );
		expect( Core.node( VIEW ).mode ).toBe( 'live' );
	} );

	test( 'step while paused fetches ONE line via taillog read — the stream stays offline', async () => {
		// Server-stamped by the ephemeral Tail: FROM + ID breadcrumb.
		const stepped = newMessage();
		stepped[ TYPE ] = TM_BYTESTREAM;
		stepped[ FROM ] = 'access';
		stepped[ ID ] = '4242:100:20';
		stepped[ VALUE ] = 'stepped line\n';
		const payload = {
			taillog: sourcesReply(),
		};
		const wire = installWire( payload );
		const { result } = mountGraph();
		await act( async () => {} );
		const env = newMessage();
		env[ TYPE ] = TM_BYTESTREAM;
		env[ KEY ] = '';
		env[ FROM ] = 'access';
		env[ ID ] = '4242:80:20';
		env[ VALUE ] = 'seen live';
		act( () => FakeEventSource.last.dispatch( 'msg', pack( env ) ) );
		act( () => result.current.setPaused( true ) );
		// The read reply replaces the catalog payload for the step's command.
		payload.taillog = {
			message: [ ...stepped ],
			cursor: { segment: 4242, offset: 120 },
			at_eof: false,
		};

		const esCount = FakeEventSource.instances.length;
		act( () => result.current.step() );

		// The read rides the router tick, so the line is a wait away.
		await waitFor(
			() =>
				expect( Core.node( VIEW ).lines[ 0 ]?.content ).toBe(
					'stepped line\n'
				),
			{ timeout: 6000 }
		);
		expect( FakeEventSource.instances.length ).toBe( esCount );
		const cmd = wire.batches
			.flat()
			.find( ( m ) => 'read' === m[ VALUE ]?.arguments?.[ 0 ] );
		expect( cmd[ VALUE ].arguments ).toEqual( [
			'read',
			'access',
			'4242:100',
		] );
	}, 15000 );

	// The catalog is polled, so rotation lands on its own: nothing to call.
	test( 'the polled catalog picks up a rotation', async () => {
		const payload = { taillog: sourcesReply() };
		installWire( payload );
		const { result } = mountGraph();
		await waitFor(
			() => expect( result.current.sources ).toEqual( sourcesReply() ),
			{ timeout: 6000 }
		);

		payload.taillog = segmentedReply();
		await waitFor(
			() => expect( result.current.sources ).toEqual( segmentedReply() ),
			{ timeout: 15000 }
		);
	}, 25000 );

	/**
	 * Was 'a seek-time fetch failure replays with NO boundary (degraded)'. There
	 * is no seek-time fetch left to fail. The degraded state it pinned — replay
	 * with no boundary, which never auto-flips and strands the user until they
	 * click Live — is the failure mode removing the fetch was meant to delete.
	 * An unknown row now FOLLOWS: no boundary means nothing to replay to.
	 */
	test( 'a seek with no catalog row follows instead of stranding in replay', async () => {
		installWire( { taillog: sourcesReply() }, [ 'taillog' ] );
		const { result } = mountGraph();
		await act( async () => {} );
		await act( async () => result.current.selectSource( 'access' ) );
		await act( async () =>
			result.current.seek( 'access', { access: 'start' }, {} )
		);
		expect( Core.node( VIEW ).mode ).toBe( 'live' );
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
		installWire( { taillog: empty } );
		const { result } = mountGraph();
		await act( async () => {} );
		await act( async () =>
			result.current.seek( 'access', { access: 'start' } )
		);
		expect( Core.node( VIEW ).mode ).toBe( 'live' );
	} );

	test( 'clear() empties the ring through the view control, resetting the counter', async () => {
		installWire( { taillog: sourcesReply() } );
		const { result } = mountGraph();
		await act( async () => {} );
		const env = newMessage();
		env[ TYPE ] = TM_BYTESTREAM;
		env[ FROM ] = 'access';
		env[ ID ] = '5:900:60';
		env[ VALUE ] = 'a raw log line';
		act( () => FakeEventSource.last.dispatch( 'msg', pack( env ) ) );
		const view = Core.node( VIEW );
		expect( view.lines.length ).toBe( 1 );

		act( () => result.current.clear() );

		expect( view.lines ).toEqual( [] );
		// The whole reset, not just the rows a direct write would blank.
		expect( view.lineCounter ).toBe( 0 );
	} );

	test( 'setPaused toggles the view paused flag', async () => {
		installWire( { taillog: sourcesReply() } );
		const { result } = mountGraph();
		await act( async () => {} );
		act( () => result.current.setPaused( true ) );
		expect( Core.node( VIEW ).setStateCache.view.paused ).toBe( true );
	} );

	test( 'unmount tears down the link, view, and closes the EventSource', async () => {
		installWire( { taillog: sourcesReply() } );
		const { unmount } = mountGraph();
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
			installWire( { taillog: sourcesReply() } );
			mountGraph();
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
			installWire( { taillog: sourcesReply() } );
			const { result } = mountGraph();
			await act( async () => {} );
			const open = FakeEventSource.last;
			expect( open.closed ).toBe( false );
			act( () => result.current.setPaused( true ) );
			expect( open.closed ).toBe( true );
			expect( Core.node( VIEW ).setStateCache.view.paused ).toBe( true );
		} );

		test( 'setPaused(false) resumes at the paused offset (reopen carries &positions=)', async () => {
			installWire( { taillog: sourcesReply() } );
			const { result } = mountGraph();
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
			installWire( { taillog: sourcesReply() } );
			const { result } = mountGraph();
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

		test( 'Reset Graph re-establishes the catalog and re-opens the source', async () => {
			// The rebuild mints a FRESH view with selected=''; nothing but the
			// reconcile loop puts the dashboard back on the air.
			mountExospine();
			installWire( { taillog: sourcesReply() } );
			const { result } = mountGraph();
			await act( async () => {} );
			const before = FakeEventSource.instances.length;

			await act( async () => {
				Core.bumpGraphGeneration();
			} );

			expect( result.current.sources ).toEqual( sourcesReply() );
			expect( Core.node( VIEW ).selected ).toBe( 'access' );
			expect( FakeEventSource.instances.length ).toBeGreaterThan(
				before
			);
			expect( FakeEventSource.last.url ).toContain( 'subscribe=access' );
		} );

		test( 'reinit while paused re-publishes paused:true and does NOT reopen the stream', async () => {
			mountExospine();
			installWire( { taillog: sourcesReply() } );
			const { result } = mountGraph();
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
			installWire( { taillog: sourcesReply() } );
			const { result } = mountGraph();
			await act( async () => {} );
			act( () => result.current.setPaused( true ) );
			const closed = FakeEventSource.last;
			const count = FakeEventSource.instances.length;
			await act( async () => result.current.selectSource( 'debug' ) );
			expect( FakeEventSource.instances.length ).toBe( count );
			expect( closed.closed ).toBe( true );
			expect( Core.node( VIEW ).setStateCache.view.selected ).toBe(
				'debug'
			);
		} );

		test( 'Play after a paused selectSource opens the NEW source (tail)', async () => {
			installWire( { taillog: sourcesReply() } );
			const { result } = mountGraph();
			await act( async () => {} );
			act( () => result.current.setPaused( true ) );
			await act( async () => result.current.selectSource( 'debug' ) );
			const before = FakeEventSource.instances.length;
			act( () => result.current.setPaused( false ) );
			expect( FakeEventSource.instances.length ).toBe( before + 1 );
			expect( FakeEventSource.last.url ).toContain( 'subscribe=debug' );
		} );

		test( 'seek while paused does NOT reopen the stream', async () => {
			installWire( { taillog: sourcesReply() } );
			const { result } = mountGraph();
			await act( async () => {} );
			act( () => result.current.setPaused( true ) );
			const count = FakeEventSource.instances.length;
			await act( async () =>
				result.current.seek( 'access', { access: 'start' } )
			);
			expect( FakeEventSource.instances.length ).toBe( count );
		} );

		test( 'Play after a paused seek replays the source and the tracker flips at the boundary', async () => {
			installWire( { taillog: sourcesReply() } );
			const { result } = mountGraph();
			await act( async () => {} );
			act( () => result.current.setPaused( true ) );
			await act( async () =>
				result.current.seek(
					'access',
					{ access: 'start' },
					{ bytes: 977 }
				)
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
