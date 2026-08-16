/**
 * Seek-feedback INTEGRATION pins for both log-stream dashboards, over ONE
 * harness — they drive the same real chain the unit tests skip: the component
 * captures the seek-time boundary from its catalog, `seek()` fills a browse
 * control into the view node, replayed records with `segment:offset:length` ID
 * breadcrumbs stream through the real `SseIn → Tee → view`, the view publishes
 * the mode change, and `useNodeState` re-feeds it to `LogBrowser`. Real hooks +
 * fake SSE + fake transport; only the two leaf presentational components are
 * stubbed so the props the component computes are readable.
 *
 * The two differ in what a boundary IS. A partition catches up on the newest
 * SEGMENT id and its size. A log source in file mode has no orderable segment —
 * a Tail over a raw file puts the opaque inode there — so it catches up on byte
 * size, or when the inode rotates. Distinct values: segments 97/98, inode 4242
 * rotating to 5151, size 977.
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
				messages.map( ( m ) =>
					commandReply( m, payloadByVerb[ m[ VALUE ]?.name ] ?? null )
				)
			);
		},
	};
}

function connectedEnvelope( subscription ) {
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] =
		`PID 4242 SLOT 3 OWNER 9007199254740993 ` +
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
}

/* eslint-disable import/first */
const PartitionViewer = require( '../PartitionViewer' ).default;
const LogViewer = require( '../LogViewer' ).default;
/* eslint-enable import/first */

describe( 'Partition Viewer', () => {
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
			log_status: {
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
			render( <PartitionViewer /> );
		} );
		// list_logs + log_status both ride the router tick; the rail is a wait
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

describe( 'Log Viewer (file mode)', () => {
	// A raw log line carrying an `inode:offset:length` breadcrumb.
	function fileFrame( id ) {
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ FROM ] = 'access';
		m[ ID ] = id;
		m[ VALUE ] = `line ${ id }`;
		return m;
	}

	beforeEach( () => {
		// One available file source; its current size (977 bytes) is the boundary.
		boot( {
			taillog: [
				{
					name: 'access',
					path: '/a',
					mode: 'file',
					available: true,
					bytes: 977,
				},
			],
		} );
	} );

	test( 'file-mode Replay flips to Live once records reach the captured byte size', async () => {
		await act( async () => {
			render( <LogViewer /> );
		} );
		// The source rides the toolbar dropdown; a file source has no segments.
		expect( logBrowserProps.items ).toHaveLength( 0 );

		// Replay: enters a file-mode replay boundary from the catalog row.
		await act( async () => {
			logBrowserProps.onReplay();
		} );
		expect( logBrowserProps.mode ).toBe( 'replay' );

		// Records replay on the reference inode 4242; 500 < 977 → still replaying.
		await act( async () => {
			FakeEventSource.last.dispatch(
				'connected',
				pack( connectedEnvelope( 'access' ) )
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

	test( 'file-mode Replay flips to Live when the inode rotates (logrotate)', async () => {
		await act( async () => {
			render( <LogViewer /> );
		} );

		await act( async () => {
			logBrowserProps.onReplay();
		} );
		expect( logBrowserProps.mode ).toBe( 'replay' );

		await act( async () => {
			FakeEventSource.last.dispatch(
				'connected',
				pack( connectedEnvelope( 'access' ) )
			);
			FakeEventSource.last.dispatch(
				'msg',
				pack( fileFrame( '4242:0:500' ) )
			);
		} );
		expect( logBrowserProps.mode ).toBe( 'replay' );

		// A new inode 5151 means the file rotated — we're on the live edge → live.
		await act( async () => {
			FakeEventSource.last.dispatch(
				'msg',
				pack( fileFrame( '5151:0:100' ) )
			);
		} );
		expect( logBrowserProps.mode ).toBe( 'live' );
	} );
} );
