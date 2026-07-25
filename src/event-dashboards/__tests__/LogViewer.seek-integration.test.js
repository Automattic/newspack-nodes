/**
 * Log Viewer FILE-MODE seek-feedback INTEGRATION pin — the counterpart to the
 * Partition Viewer pin, for a source whose segment slot is an opaque inode. On
 * Replay the component re-fetches `taillog sources` for the source's FRESH byte
 * size, `seek()` fills a file-mode browse control (null end + byte boundary) into
 * the view node, replayed records with `inode:offset:length` ID breadcrumbs stream
 * through the real `SseIn → Tee → view`, and the view flips Replay→Live the moment
 * a record reaches the captured byte size OR the inode rotates (logrotate). Real
 * hook + fake SSE + fake CommandClient; only the two leaf presentational
 * components are stubbed. Distinct values: inode 4242, size 977, rotation to 5151.
 */

import { render, act } from '@testing-library/react';
import {
	newMessage,
	pack,
	TYPE,
	KEY,
	FROM,
	ID,
	TO,
	TIMESTAMP,
	VALUE,
	TM_INFO,
	TM_COMMAND,
	TM_RESPONSE,
	TM_BYTESTREAM,
} from '../../runtime/message';
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

// Provide the fake client to the real hook via CommandClient.fromGlobal().
let mockFakeClient;
jest.mock( '../../runtime/command-client', () => ( {
	__esModule: true,
	CommandClient: { fromGlobal: () => mockFakeClient },
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
				messages.map( ( m ) => {
					const reply = newMessage();
					reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
					reply[ TO ] = m[ FROM ];
					reply[ ID ] = m[ ID ];
					reply[ TIMESTAMP ] = 0;
					reply[ VALUE ] = {
						name: m[ VALUE ]?.name,
						payload: payloadByVerb[ m[ VALUE ]?.name ] ?? null,
					};
					return reply;
				} )
			);
		},
	};
}

function connectedEnvelope() {
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] = 'PID 4242 SLOT 3 SUBSCRIPTIONS access INTERVAL 2000';
	return m;
}

// A raw log line carrying an `inode:offset:length` breadcrumb (file mode).
function fileFrame( id ) {
	const m = newMessage();
	m[ TYPE ] = TM_BYTESTREAM;
	m[ FROM ] = 'access';
	m[ ID ] = id;
	m[ VALUE ] = `line ${ id }`;
	return m;
}

beforeEach( () => {
	Core.reset();
	FakeEventSource.last = null;
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	// One available file source; its current size (977 bytes) is the boundary.
	mockFakeClient = makeFakeClient( {
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
	logBrowserProps = undefined;
} );

// eslint-disable-next-line import/first
const LogViewer = require( '../LogViewer' ).default;

test( 'file-mode Replay flips to Live once records reach the captured byte size', async () => {
	await act( async () => {
		render( <LogViewer /> );
	} );
	// The source rides the toolbar dropdown; a file source has no segments.
	expect( logBrowserProps.items ).toHaveLength( 0 );

	// Replay: re-fetches the fresh size and enters a file-mode replay boundary.
	await act( async () => {
		logBrowserProps.onReplay();
	} );
	expect( logBrowserProps.mode ).toBe( 'replay' );

	// Records replay on the reference inode 4242; 500 < 977 → still replaying.
	await act( async () => {
		FakeEventSource.last.dispatch(
			'connected',
			pack( connectedEnvelope() )
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
			pack( connectedEnvelope() )
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
