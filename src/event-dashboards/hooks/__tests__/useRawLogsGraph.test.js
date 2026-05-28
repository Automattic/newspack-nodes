/* eslint-disable no-bitwise -- TYPE field uses bitmask flags (Tachikoma convention). */
/**
 * useRawLogsGraph tests — the Raw Logs dashboard graph clipped onto the
 * substrate's I/O boundary nodes (exospine + `_sse` + `_http` + `_heartbeat`)
 * plus the existing `rawlogs:route` / `rawlogs:transform` / `rawlogs:view`
 * chain, all on the canonical rule-#2 backbone (`_command_interpreter →
 * _router`). The bespoke `rawlogs:stream` Node and its inlined slot-heartbeat
 * loop are gone — `_sse` owns the EventSource, `_heartbeat` owns the slot poke.
 *
 * EventSource is faked via `global.EventSource`; SseIn's connection logic
 * (already covered by the substrate's `sse_connector.test.js`) is unmocked
 * here — we drive a `msg` event through the fake EventSource and assert it
 * actually routes _sse → route → transform → view.
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
	TM_INFO,
	TM_COMMAND,
	TM_RESPONSE,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';

// Minimal FakeEventSource — same shape as the substrate's `sse_connector.test.js`.
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

import { useRawLogsGraph } from '../useRawLogsGraph';

const CI = '_command_interpreter';
const ROUTER = '_router';
const SSE = '_sse';
const HTTP = '_http';
const HEARTBEAT = '_heartbeat';
const ROUTE = 'rawlogs:route';
const TRANSFORM = 'rawlogs:transform';
const VIEW = 'rawlogs:view';
const ALL_GRAPH_NAMES = [ SSE, HTTP, HEARTBEAT, ROUTE, TRANSFORM, VIEW ];

// CommandClient double mirroring HttpOut's seam: postBatch returns reply
// Messages addressed back along FROM. Used for `list_logs` (initial dropdown)
// and `heartbeat` (slot poke).
function makeFakeClient( payloadByVerb = {} ) {
	const client = {
		batches: [],
		buildMessage( { to, verb, args = '', payload = null } ) {
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ TO ] = to;
			m[ VALUE ] = { name: verb, arguments: args, payload };
			return m;
		},
		postBatch( messages ) {
			client.batches.push( messages );
			const replies = messages.map( ( m ) => {
				const reply = newMessage();
				reply[ TYPE ] = TM_COMMAND | TM_RESPONSE;
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

// Build a `connected` envelope as SseConnector recognizes it.
function connectedEnvelope( { pid = 4242, slot = 3, partition = 0 } = {} ) {
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] = { pid, slot, partition };
	return m;
}

function mountGraph( client ) {
	return renderHook( () => useRawLogsGraph( { commandClient: client } ) );
}

const oneLogReply = () => [ { key: 'firehose', label: 'firehose.log' } ];

describe( 'useRawLogsGraph — exospine + I/O boundary wiring', () => {
	test( 'mounts the backbone + the six graph nodes, each sinking into the CI', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		const ci = Core.node( CI );
		expect( ci ).toBeTruthy();
		expect( Core.node( ROUTER ) ).toBeTruthy();
		for ( const name of ALL_GRAPH_NAMES ) {
			const node = Core.node( name );
			expect( node ).toBeTruthy();
			expect( node.sink ).toBe( ci );
		}
	} );

	test( 'steers flow with targets: _sse → route → transform → view; heartbeat → _http/workers', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		expect( Core.node( SSE ).target ).toBe( ROUTE );
		expect( Core.node( TRANSFORM ).target ).toBe( VIEW );
		expect( Core.node( HEARTBEAT ).target ).toBe( `${ HTTP }/workers` );
	} );

	test( '_http has the injected CommandClient as its client', async () => {
		const client = makeFakeClient( { list_logs: oneLogReply() } );
		mountGraph( client );
		await act( async () => {} );
		expect( Core.node( HTTP ).client ).toBe( client );
	} );

	test( 'fires list_logs on mount addressed to _http/raw-logs and pushes it into the view', async () => {
		const client = makeFakeClient( {
			list_logs: [
				{ key: 'firehose', label: 'firehose.log' },
				{ key: 'errors', label: 'errors.log' },
			],
		} );
		mountGraph( client );
		await act( async () => {} );
		const listMsg = client.batches
			.flat()
			.find( ( m ) => 'list_logs' === m[ VALUE ]?.name );
		expect( listMsg ).toBeTruthy();
		expect( listMsg[ TO ] ).toBe( 'raw-logs' );
		// View received the logs list and defaulted the selection to logs[0].key.
		const view = Core.node( VIEW );
		expect( view.setStateCache.view.logs ).toHaveLength( 2 );
		expect( view.setStateCache.view.selected ).toBe( 'firehose' );
	} );

	test( 'opens an EventSource against /messages/stream?subscribe={selected-log}', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		expect( FakeEventSource.last ).toBeTruthy();
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/messages/stream'
		);
		expect( FakeEventSource.last.url ).toContain( 'subscribe=firehose' );
	} );
} );

describe( 'useRawLogsGraph — end-to-end routing through the exospine', () => {
	test( 'a delivered log envelope routes _sse → route → transform → view', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		// Drive a `connected` envelope so the heartbeat has a slot to poke.
		FakeEventSource.last.dispatch( 'msg', pack( connectedEnvelope() ) );
		// Drive a real log line.
		const env = newMessage();
		env[ KEY ] = 'p0';
		env[ FROM ] = 'firehose.p0';
		env[ VALUE ] = 'a real log line';
		FakeEventSource.last.dispatch( 'msg', pack( env ) );
		const view = Core.node( VIEW );
		expect( view.lines ).toHaveLength( 1 );
		expect( view.lines[ 0 ].content ).toBe( 'p0: a real log line' );
	} );
} );

describe( 'useRawLogsGraph — heartbeat slot bridge', () => {
	test( 'a `connected` envelope populates heartbeat.slot and heartbeat.partition', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		FakeEventSource.last.dispatch(
			'msg',
			pack( connectedEnvelope( { pid: 7, slot: 5, partition: 2 } ) )
		);
		expect( Core.node( HEARTBEAT ).slot ).toBe( 5 );
		expect( Core.node( HEARTBEAT ).partition ).toBe( 2 );
	} );

	test( 'a `connected` envelope with no slot leaves heartbeat slot null', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		FakeEventSource.last.dispatch(
			'msg',
			pack( connectedEnvelope( { pid: 7, slot: -1, partition: 0 } ) )
		);
		expect( Core.node( HEARTBEAT ).slot ).toBeNull();
	} );
} );

describe( 'useRawLogsGraph — teardown', () => {
	test( 'unmount unregisters all graph nodes + the backbone and closes the EventSource', async () => {
		const { unmount } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		const es = FakeEventSource.last;
		unmount();
		expect( es.closed ).toBe( true );
		for ( const name of [ ...ALL_GRAPH_NAMES, CI, ROUTER ] ) {
			expect( Core.node( name ) ).toBeNull();
		}
	} );
} );

describe( 'useRawLogsGraph — control callbacks', () => {
	test( 'selectLog re-subscribes the EventSource and selects in the view', async () => {
		const { result } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		const before = FakeEventSource.last;
		act( () => result.current.selectLog( 'errors' ) );
		// Old EventSource closed, a new one opened with subscribe=errors.
		expect( before.closed ).toBe( true );
		expect( FakeEventSource.last ).not.toBe( before );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=errors' );
		// View reflects the selection.
		expect( Core.node( VIEW ).setStateCache.view.selected ).toBe(
			'errors'
		);
	} );

	test( 'setPaused toggles the view paused flag', async () => {
		const { result } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		act( () => result.current.setPaused( true ) );
		expect( Core.node( VIEW ).setStateCache.view.paused ).toBe( true );
	} );
} );
