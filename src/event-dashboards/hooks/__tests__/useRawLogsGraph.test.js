/**
 * useRawLogsGraph tests — the Raw Logs dashboard graph clipped onto the
 * substrate's canonical rule-#2 backbone (`_command_interpreter → _router`) via
 * a SINGLE `RemoteLink` node plus the single `rawlogs:view` view-model node.
 *
 * RemoteLink composes the three I/O children every SSE dashboard used to wire by
 * hand — `rawlogs:link:sse-in` (SseIn), `rawlogs:link:http` (HttpOut) and
 * `rawlogs:link:heartbeat` (Heartbeat) — and wires the `connected → slot` bridge
 * to its own heartbeat. The bespoke `rawlogs:route` / `rawlogs:transform` nodes
 * are gone — envelope→row shaping is inlined into the view itself.
 *
 * EventSource is faked via `global.EventSource`; SseInNode's connection logic
 * (already covered by the substrate's `sse_connector.test.js`) is unmocked
 * here — we drive a `msg` event through the fake EventSource and assert it
 * actually routes the composed sse-in → view.
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
	TM_BYTESTREAM,
} from '../../../runtime/message';
import { Core } from '../../../runtime/core';
import { useNodeState } from '../../../runtime/react';

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

const INTERPRETER = '_command_interpreter';
const ROUTER = '_router';
const LINK = 'rawlogs:link';
const SSE = 'rawlogs:link:sse-in';
const HTTP = 'rawlogs:link:http';
const HEARTBEAT = 'rawlogs:link:heartbeat';
const VIEW = 'rawlogs:view';
const COMPOSED_NAMES = [ SSE, HTTP, HEARTBEAT ];

// CommandClient double mirroring HttpOut's seam: postBatch returns reply
// Messages addressed back along FROM. Used for `list_logs` (initial dropdown)
// and `heartbeat` (slot poke).
function makeFakeClient( payloadByVerb = {} ) {
	const client = {
		batches: [],
		buildMessage( { to, verb, args = '' } ) {
			const m = newMessage();
			m[ TYPE ] = TM_COMMAND;
			m[ TO ] = to;
			m[ VALUE ] = { name: verb, arguments: args };
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

const oneLogReply = () => [ { key: 'firehose.p0', label: 'firehose.p0' } ];

describe( 'useRawLogsGraph — exospine + RemoteLink wiring', () => {
	test( 'mounts the backbone + one RemoteLink (composing three children) + the view', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		const interpreter = Core.node( INTERPRETER );
		expect( interpreter ).toBeTruthy();
		expect( Core.node( ROUTER ) ).toBeTruthy();
		// The view sinks into the interpreter.
		expect( Core.node( VIEW ) ).toBeTruthy();
		expect( Core.node( VIEW ).sink ).toBe( interpreter );
		// RemoteLink's three composed children are registered and sink into the interpreter.
		for ( const name of COMPOSED_NAMES ) {
			const node = Core.node( name );
			expect( node ).toBeTruthy();
			expect( node.sink ).toBe( interpreter );
		}
	} );

	test( 'steers flow with targets: composed sse-in → view; heartbeat → {link}:http/workers', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		expect( Core.node( SSE ).target ).toBe( VIEW );
		expect( Core.node( HEARTBEAT ).target ).toBe( `${ HTTP }/workers` );
	} );

	test( 'does NOT mount rawlogs:route or rawlogs:transform (chain collapsed into view)', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		expect( Core.node( 'rawlogs:route' ) ).toBeNull();
		expect( Core.node( 'rawlogs:transform' ) ).toBeNull();
	} );

	test( 'the composed HttpOut has the injected CommandClient as its client', async () => {
		const client = makeFakeClient( { list_logs: oneLogReply() } );
		mountGraph( client );
		await act( async () => {} );
		expect( Core.node( HTTP ).client ).toBe( client );
	} );

	test( 'fires list_logs on mount addressed to raw-logs and pushes it into the view', async () => {
		const client = makeFakeClient( {
			list_logs: [
				{ key: 'firehose.p0', label: 'firehose.p0' },
				{ key: 'errors.p0', label: 'errors.p0' },
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
		expect( view.setStateCache.view.selected ).toBe( 'firehose.p0' );
	} );

	test( 'opens an EventSource against /messages/stream?subscribe={selected-log}', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		expect( FakeEventSource.last ).toBeTruthy();
		expect( FakeEventSource.last.url ).toContain(
			'newspack-nodes/v1/messages/stream'
		);
		expect( FakeEventSource.last.url ).toContain( 'subscribe=firehose.p0' );
	} );
} );

describe( 'useRawLogsGraph — end-to-end routing through the exospine', () => {
	test( 'a delivered log envelope routes composed sse-in → view (shaped inline)', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		// Drive a `connected` envelope so the heartbeat has a slot to poke.
		FakeEventSource.last.dispatch( 'msg', pack( connectedEnvelope() ) );
		// Drive a real log line — a Consumer-unpacked firehose entry carries the
		// producer's type (a string VALUE is TM_BYTESTREAM); a typeless frame would
		// (correctly) be dropped at the SSE ingress boundary.
		const env = newMessage();
		env[ TYPE ] = TM_BYTESTREAM;
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

	test( 'the Router TIMER drives heartbeat.fire (via notify_timer) so the slot keep-alive actually fires', async () => {
		jest.useFakeTimers();
		try {
			const client = makeFakeClient( { list_logs: oneLogReply() } );
			mountGraph( client );
			await act( async () => {} ); // settle list_logs → EventSource opens
			act( () => {
				FakeEventSource.last.dispatch(
					'msg',
					pack(
						connectedEnvelope( { pid: 7, slot: 5, partition: 2 } )
					)
				);
			} );
			client.batches.length = 0; // ignore the initial list_logs batch
			// 1s Router TIMER × 5 = past the 5s throttle in HeartbeatNode.fire.
			act( () => {
				jest.advanceTimersByTime( 5000 );
			} );
			expect( Core.node( HEARTBEAT ).lastFired ).toBeGreaterThan( 0 );
			const poke = client.batches
				.flat()
				.find(
					( m ) => m && m[ VALUE ] && 'heartbeat' === m[ VALUE ].name
				);
			expect( poke ).toBeTruthy();
			expect( poke[ VALUE ].arguments ).toBe( '5 10 2' );
		} finally {
			jest.useRealTimers();
		}
	} );
} );

describe( 'useRawLogsGraph — teardown', () => {
	test( 'unmount tears down the RemoteLink children + the backbone and closes the EventSource', async () => {
		const { unmount } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		const es = FakeEventSource.last;
		unmount();
		expect( es.closed ).toBe( true );
		for ( const name of [
			...COMPOSED_NAMES,
			LINK,
			VIEW,
			INTERPRETER,
			ROUTER,
		] ) {
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
		act( () => result.current.selectLog( 'errors.p0' ) );
		// Old EventSource closed, a new one opened with subscribe=errors.
		expect( before.closed ).toBe( true );
		expect( FakeEventSource.last ).not.toBe( before );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=errors.p0' );
		// View reflects the selection.
		expect( Core.node( VIEW ).setStateCache.view.selected ).toBe(
			'errors.p0'
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

	test( 'Core.reinit rebuilds the graph nodes fresh (backbone preserved)', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		const firstView = Core.node( VIEW );
		const firstHttp = Core.node( HTTP );
		const backbone = Core.node( INTERPRETER );
		expect( firstView ).not.toBeNull();
		expect( typeof Core.reinit ).toBe( 'function' );

		await act( async () => {
			Core.reinit();
		} );

		// Soft nodes are fresh instances under the same names; backbone survives.
		expect( Core.node( VIEW ) ).not.toBe( firstView );
		expect( Core.node( HTTP ) ).not.toBe( firstHttp );
		expect( Core.node( VIEW ).sink ).toBe( Core.node( INTERPRETER ) );
		expect( Core.node( INTERPRETER ) ).toBe( backbone );
	} );

	test( 'Core.reinit re-renders the consumer so useNodeState re-subscribes to the fresh view', async () => {
		const client = makeFakeClient( { list_logs: oneLogReply() } );
		const { result } = renderHook( () => {
			const graph = useRawLogsGraph( { commandClient: client } );
			const view = useNodeState( VIEW, 'view' );
			return { graph, view };
		} );
		await act( async () => {} );
		const firstView = Core.node( VIEW );

		await act( async () => {
			Core.reinit();
		} );
		const freshView = Core.node( VIEW );
		expect( freshView ).not.toBe( firstView );

		// The fresh view publishes state; the consumer must observe it (proving
		// it re-subscribed to freshView, not the removed firstView).
		await act( async () => {
			freshView.setState( 'view', { selected: 'sentinel' } );
		} );
		expect( result.current.view ).toEqual( { selected: 'sentinel' } );
	} );
} );

describe( 'useRawLogsGraph — visibility-gated streaming', () => {
	const setVisibility = ( state ) => {
		Object.defineProperty( document, 'visibilityState', {
			value: state,
			configurable: true,
		} );
		act( () => {
			document.dispatchEvent( new Event( 'visibilitychange' ) );
		} );
	};

	// Other suites assume a visible tab; reset after each visibility test.
	afterEach( () => setVisibility( 'visible' ) );

	test( 'closes the EventSource when the tab is hidden', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		const open = FakeEventSource.last;
		expect( open.closed ).toBe( false );
		act( () => setVisibility( 'hidden' ) );
		expect( open.closed ).toBe( true );
	} );

	test( 'reopens on the selected log when the tab becomes visible again', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		act( () => setVisibility( 'hidden' ) );
		const before = FakeEventSource.instances.length;
		act( () => setVisibility( 'visible' ) );
		expect( FakeEventSource.instances.length ).toBe( before + 1 );
		expect( FakeEventSource.last.url ).toContain( 'subscribe=firehose.p0' );
	} );
} );
