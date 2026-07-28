/**
 * Partition Viewer seek-feedback INTEGRATION pin — drives the REAL chain the unit
 * tests skip: the component captures the seek-time end from `log_status`, `seek()`
 * fills the browse control into the view node, replayed records with
 * `segment:offset:length` ID breadcrumbs stream through the real `SseIn → Tee →
 * view`, the view publishes the mode change, and `useNodeState` re-feeds it to
 * `LogBrowser`. Real hook + fake SSE + fake CommandClient; only the two leaf
 * presentational components are stubbed so we can read the props the component
 * computes. This is the acceptance pin the shared-`SeekTracker` extraction must
 * keep passing.
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
	m[ VALUE ] =
		'PID 4242 SLOT 3 OWNER 9007199254740993 ' +
		'SUBSCRIPTIONS firehose.p0 INTERVAL 2000';
	return m;
}

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
	Core.reset();
	FakeEventSource.last = null;
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	mockFakeClient = makeFakeClient( {
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
	logBrowserProps = undefined;
} );

// eslint-disable-next-line import/first
const PartitionViewer = require( '../PartitionViewer' ).default;

test( 'REPRO: Replay flips to Live once replayed records reach the captured end', async () => {
	await act( async () => {
		render( <PartitionViewer /> );
	} );
	// list_logs + log_status settled: selected + segments present.
	expect( logBrowserProps.items ).toEqual( [
		{ id: 97, size: 1000 },
		{ id: 98, size: 500 },
	] );

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
			pack( connectedEnvelope() )
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
} );
