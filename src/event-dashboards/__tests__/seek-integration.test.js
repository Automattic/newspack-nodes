/**
 * Seek-feedback INTEGRATION pins for the Log Viewer over a partition dir
 * and over a file source, on ONE harness — they drive the same real chain the unit tests skip: the component
 * captures the seek-time boundary from its rail, `seek()` fills a browse
 * control into the view node, replayed records with `segment:offset:length` ID
 * breadcrumbs stream through the real `SseIn → Tee → view`, the view publishes
 * the mode change, and `useNodeState` re-feeds it to `LogBrowser`. Real hooks +
 * fake SSE + fake transport; only the two leaf presentational components are
 * stubbed so the props the component computes are readable.
 *
 * Both catch up on the newest SEGMENT id and its size. A file source is one
 * segment, its inode at the file's size, because a Tail over a raw file puts
 * the inode in the segment slot. Distinct values: segments 97/98, inode 4242
 * rotating down to 2207, size 977.
 */

import { render, act, waitFor } from '@testing-library/react';
import {
	newMessage,
	pack,
	TYPE,
	KEY,
	FROM,
	ID,
	TO,
	VALUE,
	TM_INFO,
	TM_COMMAND,
	TM_BYTESTREAM,
} from '../../runtime/message';
import { commandReply } from '../../shared/test-utils/fakeCommandWire';
import { Core } from '../../runtime/core';

let logBrowserProps;
jest.mock( '@newspack-nodes/shared/components/LogBrowser', () => ( {
	__esModule: true,
	default: ( props ) => {
		logBrowserProps = props;
		return null;
	},
} ) );
jest.mock( '@newspack-nodes/shared/components/LogRowList', () => ( {
	__esModule: true,
	default: () => null,
} ) );

// Provide the fake transport to the real hooks: HttpOut defaults to this when
// nothing was injected.
let mockFakeClient;
jest.mock( '../../runtime/command-transport', () => ( {
	__esModule: true,
	defaultTransport: () => mockFakeClient,
	commandTransport: () => mockFakeClient,
} ) );

class FakeEventSource {
	constructor( url ) {
		this.url = url;
		this.listeners = {};
		this.closed = false;
		FakeEventSource.last = this;
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

function makeFakeClient( payloadByVerb ) {
	return {
		batches: [],
		answered: [],
		buildMessage( { to, verb, args = [] } ) {
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ TO ] = to;
			m[ VALUE ] = { name: verb, arguments: args };
			return m;
		},
		postBatch( messages ) {
			this.batches.push( messages );
			return Promise.resolve(
				messages.map( ( m ) => {
					this.answered.push( m[ VALUE ]?.name );
					return commandReply(
						m,
						payloadByVerb[ m[ VALUE ]?.name ] ?? null
					);
				} )
			);
		},
	};
}

function connectedEnvelope( subscription ) {
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] =
		`SESSION e2e11111e2e22222e2e33333e2e44444 SLOT 3 OWNER 9007199254740993 ` +
		`SUBSCRIPTIONS ${ subscription } INTERVAL 2000`;
	return m;
}

function boot( payloadByVerb ) {
	Core.reset();
	FakeEventSource.last = null;
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	mockFakeClient = makeFakeClient( payloadByVerb );
	logBrowserProps = undefined;
	// The rail is folded until a reader opens it; these cases read it.
	window.localStorage.setItem(
		'newspack-nodes-rail:newspack-nodes-log-viewer',
		'open'
	);
}

/* eslint-disable import/first */
const LogViewer = require( '../LogViewer' ).default;
/* eslint-enable import/first */

describe( 'Log Viewer', () => {
	// A packed partition envelope, keyed by partition.
	function replayFrame( id ) {
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ FROM ] = 'firehose.p0/request-builder';
		m[ KEY ] = 'p0';
		m[ ID ] = id;
		m[ VALUE ] = `record ${ id }`;
		return m;
	}

	beforeEach( () => {
		boot( {
			list_logs: [ { key: 'firehose.p0', label: 'firehose.p0' } ],
			// Newest segment id 98 @ 500 bytes is the live boundary; 97 is older.
			dump_log: {
				log_id: 'firehose.p0',
				segments: [
					{ id: 97, size: 1000 },
					{ id: 98, size: 500 },
				],
			},
		} );
	} );

	test( 'REPRO: Replay flips to Live once replayed records reach the captured end', async () => {
		await act( async () => {
			render( <LogViewer /> );
		} );
		// list_logs + dump_log both ride the router tick; the rail is a wait
		// away, not a flush.
		await waitFor(
			() =>
				expect( logBrowserProps.items ).toEqual( [
					{ id: 97, size: 1000 },
					{ id: 98, size: 500 },
				] ),
			{ timeout: 6000 }
		);

		// Nothing received yet: no rail highlight follows.
		expect( logBrowserProps.activeKey ).toBe( null );

		// Click Replay: carries the captured end into the view, opens the replay SSE.
		await act( async () => {
			logBrowserProps.onReplay();
		} );
		expect( logBrowserProps.mode ).toBe( 'replay' );

		// A replayed record from the older segment: rail follows it, still replaying.
		await act( async () => {
			FakeEventSource.last.dispatch(
				'connected',
				pack( connectedEnvelope( 'firehose.p0' ) )
			);
			FakeEventSource.last.dispatch(
				'msg',
				pack( replayFrame( '97:0:1000' ) )
			);
		} );
		expect( logBrowserProps.mode ).toBe( 'replay' );
		expect( logBrowserProps.activeKey ).toBe( 97 );

		// A record in the newest segment (below the captured end): rail follows on.
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				pack( replayFrame( '98:0:250' ) )
			);
		} );
		expect( logBrowserProps.mode ).toBe( 'replay' );
		expect( logBrowserProps.activeKey ).toBe( 98 );

		// A record whose end reaches 500 catches up → flip to live.
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				pack( replayFrame( '98:250:250' ) )
			);
		} );
		expect( logBrowserProps.mode ).toBe( 'live' );
	}, 20000 );
} );

describe( 'Log Viewer over a file source', () => {
	// A raw log line carrying an `inode:offset:length` breadcrumb.
	function fileFrame( id ) {
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ FROM ] = 'sources/access';
		m[ ID ] = id;
		m[ VALUE ] = `line ${ id }`;
		return m;
	}

	// Render, then wait for the footprint the Replay boundary is read from.
	async function renderWithFootprint() {
		await act( async () => {
			render( <LogViewer /> );
		} );
		await waitFor(
			() => expect( logBrowserProps?.items?.length ).toBeGreaterThan( 0 ),
			{ timeout: 6000 }
		);
	}

	beforeEach( () => {
		// One available file source: inode 4242 at 977 bytes is the boundary.
		boot( {
			list_logs: [
				{ key: 'sources/access', label: 'access', available: true },
			],
			dump_log: {
				log_id: 'sources/access',
				segments: [ { id: 4242, size: 977 } ],
				segment_count: 1,
				total_size: 977,
			},
			// A rotation re-catalogs, and that tick carries the slot's poke.
			heartbeat: { success: true },
		} );
	} );

	test( 'the rail shows a file source as its one segment', async () => {
		await renderWithFootprint();
		expect( logBrowserProps.items ).toEqual( [ { id: 4242, size: 977 } ] );
	} );

	test( "Replay captures the file's inode at its size as the boundary", async () => {
		await renderWithFootprint();
		await act( async () => {
			logBrowserProps.onReplay();
		} );
		const { seek } = Core.node( 'log-viewer:view' );
		expect( [ seek.endSegment, seek.endOffset ] ).toEqual( [ 4242, 977 ] );
	} );

	test( 'Replay flips to Live once records reach the captured byte size', async () => {
		await renderWithFootprint();

		await act( async () => {
			logBrowserProps.onReplay();
		} );
		expect( logBrowserProps.mode ).toBe( 'replay' );

		// Records replay on the reference inode 4242; 500 < 977 → still replaying.
		await act( async () => {
			FakeEventSource.last.dispatch(
				'connected',
				pack( connectedEnvelope( 'sources/access' ) )
			);
			FakeEventSource.last.dispatch(
				'msg',
				pack( fileFrame( '4242:0:500' ) )
			);
		} );
		expect( logBrowserProps.mode ).toBe( 'replay' );

		// 500 + 477 = 977 → caught up to the seek-time file size → flip to live.
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				pack( fileFrame( '4242:500:477' ) )
			);
		} );
		expect( logBrowserProps.mode ).toBe( 'live' );
	} );

	test( 'Replay flips to Live when the inode rotates, even to a lower one', async () => {
		await renderWithFootprint();

		await act( async () => {
			logBrowserProps.onReplay();
		} );
		expect( logBrowserProps.mode ).toBe( 'replay' );

		await act( async () => {
			FakeEventSource.last.dispatch(
				'connected',
				pack( connectedEnvelope( 'sources/access' ) )
			);
			FakeEventSource.last.dispatch(
				'msg',
				pack( fileFrame( '4242:0:500' ) )
			);
		} );
		expect( logBrowserProps.mode ).toBe( 'replay' );

		// A new inode, though lower, means the file rotated: live edge → live.
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				pack( fileFrame( '2207:0:100' ) )
			);
		} );
		expect( logBrowserProps.mode ).toBe( 'live' );
	} );
} );
