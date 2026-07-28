/**
 * usePartitionViewerGraph tests — the Partition Viewer dashboard graph clipped onto the
 * substrate's canonical rule-#2 backbone (`_command_interpreter → _router`) via
 * a SINGLE `RemoteLink` node plus the single `partition:view` view-model node.
 *
 * RemoteLink composes an UNNAMED per-link SseIn (held as `link.sseIn`, NOT
 * registered in Core — no canvas churn) and SHARES the reserved-name `_http`
 * (HttpOut) + `_heartbeat` (Heartbeat) singletons, wiring the connected lease
 * to that shared heartbeat. The bespoke `partition:route` /
 * `partition:transform` nodes are gone — envelope→row shaping is inlined into the
 * view itself.
 *
 * EventSource is faked via `global.EventSource`; SseInNode's connection logic
 * (already covered by the substrate's `sse-in-node.test.js`) is unmocked
 * here — we drive a `msg` event through the fake EventSource and assert it
 * actually routes the composed (unnamed) sse-in → view.
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
import { mountExospine } from '../../../runtime/exospine';
import { Node } from '../../../runtime/node';
import { useNodeState } from '../../../runtime/react';
import names from '../../../runtime/reserved-node-names.json';

// Minimal FakeEventSource — same shape as the substrate's sse-in-node.test.
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

import { usePartitionViewerGraph } from '../usePartitionViewerGraph';

const INTERPRETER = '_command_interpreter';
const ROUTER = '_router';
const LINK = 'partition:link';
// SseIn is UNNAMED (link.sseIn); HttpOut + Heartbeat are shared singletons.
const HTTP = names.HTTP;
const HEARTBEAT = names.HEARTBEAT;
const VIEW = 'partition:view';
const TEE = 'partition:stream';
const LEASE_OWNER = '9007199254740993';

// CommandClient double: postBatch returns reply Messages addressed along FROM.
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

// Build a connected envelope as a flat string (TM_INFO values are strings).
function connectedEnvelope( {
	pid = 4242,
	slot = 3,
	owner = LEASE_OWNER,
} = {} ) {
	const value =
		`PID ${ pid } SLOT ${ slot } OWNER ${ owner } ` +
		'SUBSCRIPTIONS firehose.p0 INTERVAL 2000';
	const m = newMessage();
	m[ TYPE ] = TM_INFO;
	m[ KEY ] = 'connected';
	m[ VALUE ] = value;
	return m;
}

function mountGraph( client ) {
	return renderHook( () =>
		usePartitionViewerGraph( { commandClient: client } )
	);
}

const oneLogReply = () => [ { key: 'firehose.p0', label: 'firehose.p0' } ];

describe( 'usePartitionViewerGraph — exospine + RemoteLink wiring', () => {
	test( 'mounts the backbone + one RemoteLink (composing three children) + the view', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		const interpreter = Core.node( INTERPRETER );
		expect( interpreter ).toBeTruthy();
		expect( Core.node( ROUTER ) ).toBeTruthy();
		// The view sinks into the interpreter.
		expect( Core.node( VIEW ) ).toBeTruthy();
		expect( Core.node( VIEW ).sink ).toBe( interpreter );
		// The composed SseIn is UNNAMED — held on the link, never registered.
		const link = Core.node( LINK );
		expect( link.sseIn ).toBeTruthy();
		expect( Core.node( 'partition:link:sse-in' ) ).toBeNull();
		// HttpOut + Heartbeat are SHARED singletons sinking into the backbone.
		for ( const name of [ HTTP, HEARTBEAT ] ) {
			const node = Core.node( name );
			expect( node ).toBeTruthy();
			expect( node.sink ).toBe( interpreter );
		}
		expect( link.httpOut ).toBe( Core.node( HTTP ) );
		expect( link.heartbeat ).toBe( Core.node( HEARTBEAT ) );
	} );

	test( 'steers flow with targets: composed (unnamed) sse-in → stream Tee → view; shared heartbeat → _http/workers', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		// The link re-homes frames to the Tee, which fans to the view.
		expect( Core.node( LINK ).sseIn.target ).toBe( TEE );
		expect( Core.node( TEE ).target ).toEqual( [ VIEW ] );
		expect( Core.node( HEARTBEAT ).target ).toBe( `${ HTTP }/workers` );
	} );

	test( 'does NOT mount partition:route or partition:transform (chain collapsed into view)', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		expect( Core.node( 'partition:route' ) ).toBeNull();
		expect( Core.node( 'partition:transform' ) ).toBeNull();
	} );

	test( 'inserts an inspectable Tee on the stream edge: link → tee → view', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		const interpreter = Core.node( INTERPRETER );
		const tee = Core.node( TEE );
		// A named Tee sits on the stream path, sinking into the backbone.
		expect( tee ).toBeTruthy();
		expect( tee.constructor.name ).toBe( 'TeeNode' );
		expect( tee.sink ).toBe( interpreter );
		// The link re-homes frames to the Tee, not straight to the view.
		expect( Core.node( LINK ).sseIn.target ).toBe( TEE );
		// The Tee forwards to the view (pure pass-through, single target).
		expect( tee.target ).toEqual( [ VIEW ] );
	} );

	test( 'a delivered log envelope still reaches the view through the Tee', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		FakeEventSource.last.dispatch(
			'connected',
			pack( connectedEnvelope() )
		);
		const env = newMessage();
		env[ TYPE ] = TM_BYTESTREAM;
		env[ KEY ] = 'p0';
		env[ FROM ] = 'firehose.p0';
		env[ VALUE ] = 'through the tee';
		FakeEventSource.last.dispatch( 'msg', pack( env ) );
		const view = Core.node( VIEW );
		expect( view.lines ).toHaveLength( 1 );
		expect( view.lines[ 0 ].content ).toBe( 'p0: through the tee' );
	} );

	test( 'connecting a second target to the Tee fans the live stream out without disturbing the view', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		// A debug-overlay `connect <tee> <watcher>` appends a second target.
		const watcher = new Node();
		watcher.name = 'watcher';
		const seen = [];
		watcher.fill = ( m ) => seen.push( m[ VALUE ] );
		Core.node( TEE ).connectNode( 'watcher' );

		FakeEventSource.last.dispatch(
			'connected',
			pack( connectedEnvelope() )
		);
		const env = newMessage();
		env[ TYPE ] = TM_BYTESTREAM;
		env[ KEY ] = 'p0';
		env[ FROM ] = 'firehose.p0';
		env[ VALUE ] = 'watched line';
		FakeEventSource.last.dispatch( 'msg', pack( env ) );

		// The watcher saw the raw stream AND the view still rendered the line.
		expect( seen ).toContain( 'watched line' );
		expect( Core.node( VIEW ).lines ).toHaveLength( 1 );
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
		// View got the logs list and defaulted the selection to logs[0].key.
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

	test( 'makes the RemoteLink with a token-free (subscribe-only) argument string', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		// baseUrl/nonce come from the localized global, NOT make_node tokens.
		expect( Core.node( LINK ).arguments ).toEqual( [ 'raw-logs' ] );
	} );
} );

describe( 'usePartitionViewerGraph — end-to-end routing through the exospine', () => {
	test( 'a delivered log envelope routes composed sse-in → view (shaped inline)', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		// Drive a `connected` envelope so the heartbeat has a slot to poke.
		FakeEventSource.last.dispatch(
			'connected',
			pack( connectedEnvelope() )
		);
		// A string VALUE is TM_BYTESTREAM; a typeless frame drops at ingress.
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

describe( 'usePartitionViewerGraph — heartbeat slot bridge', () => {
	test( 'a `connected` envelope populates heartbeat.slot', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		FakeEventSource.last.dispatch(
			'connected',
			pack( connectedEnvelope( { pid: 7, slot: 5 } ) )
		);
		expect( Core.node( HEARTBEAT ).slot ).toBe( 5 );
	} );

	test( 'a `connected` envelope with no slot leaves heartbeat slot null', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		expectConsoleWarn(
			'ERROR: SseInNode: connected envelope missing or invalid SLOT'
		);
		FakeEventSource.last.dispatch(
			'connected',
			pack( connectedEnvelope( { pid: 7, slot: -1 } ) )
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
					'connected',
					pack( connectedEnvelope( { pid: 7, slot: 5 } ) )
				);
			} );
			client.batches.length = 0; // ignore the initial list_logs batch
			// 1s Router TIMER x 5 = past the 5s base-Timer throttle.
			act( () => {
				jest.advanceTimersByTime( 5000 );
			} );
			expect( Core.node( HEARTBEAT ).lastFireTime ).toBeGreaterThan( 0 );
			const poke = client.batches
				.flat()
				.find(
					( m ) => m && m[ VALUE ] && 'heartbeat' === m[ VALUE ].name
				);
			expect( poke ).toBeTruthy();
			expect( poke[ VALUE ].arguments ).toEqual( [ '5', LEASE_OWNER ] );
		} finally {
			jest.useRealTimers();
		}
	} );
} );

describe( 'usePartitionViewerGraph — teardown', () => {
	test( 'unmount tears down the RemoteLink + shared singletons + the backbone and closes the EventSource', async () => {
		const { unmount } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		const es = FakeEventSource.last;
		unmount();
		expect( es.closed ).toBe( true );
		// The single-link owner tears down the shared _http/_heartbeat too.
		for ( const name of [
			HTTP,
			HEARTBEAT,
			LINK,
			VIEW,
			INTERPRETER,
			ROUTER,
		] ) {
			expect( Core.node( name ) ).toBeNull();
		}
	} );
} );

describe( 'usePartitionViewerGraph — control callbacks', () => {
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

	test( 'fetchLogStatus resolves a log_status reply addressed to raw-logs', async () => {
		const client = makeFakeClient( {
			list_logs: oneLogReply(),
			log_status: {
				log_id: 'firehose.p0',
				segments: [
					{ id: 4, size: 100 },
					{ id: 5, size: 200 },
				],
				segment_count: 2,
				total_size: 300,
			},
		} );
		const { result } = mountGraph( client );
		await act( async () => {} );
		let status;
		await act( async () => {
			status = await result.current.fetchLogStatus( 'firehose.p0' );
		} );
		const statusMsg = client.batches
			.flat()
			.find( ( m ) => 'log_status' === m[ VALUE ]?.name );
		expect( statusMsg[ TO ] ).toBe( 'raw-logs' );
		expect( statusMsg[ VALUE ].arguments ).toEqual( [ 'firehose.p0' ] );
		expect( status.segments ).toEqual( [
			{ id: 4, size: 100 },
			{ id: 5, size: 200 },
		] );
	} );

	test( 'seek re-subscribes the stream at the given positions seed', async () => {
		const { result } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		const before = FakeEventSource.last;
		act( () =>
			result.current.seek( 'firehose.p0', {
				'firehose.p0': { segment: 5, offset: 0 },
			} )
		);
		expect( before.closed ).toBe( true );
		const url = FakeEventSource.last.url;
		expect( url ).toContain( 'positions=' );
		const positions = JSON.parse(
			decodeURIComponent(
				url.split( 'positions=' )[ 1 ].split( '&' )[ 0 ]
			)
		);
		expect( positions ).toEqual( {
			'firehose.p0': { segment: 5, offset: 0 },
		} );
	} );

	test( 'a graphGeneration bump rebuilds the graph nodes fresh (backbone preserved)', async () => {
		// The overlay owns the backbone; this dashboard is a reused mount whose
		// spine.reinit is subscribed to graphGeneration. A bump (the real Reset
		// Graph trigger) rebuilds JUST its soft nodes, keeping the shared backbone.
		mountExospine();
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		const firstView = Core.node( VIEW );
		const firstHttp = Core.node( HTTP );
		const backbone = Core.node( INTERPRETER );
		expect( firstView ).not.toBeNull();

		await act( async () => {
			Core.bumpGraphGeneration();
		} );

		// Soft nodes rebuild fresh; the backbone (with _http) survives.
		expect( Core.node( VIEW ) ).not.toBe( firstView );
		expect( Core.node( HTTP ) ).toBe( firstHttp );
		expect( Core.node( VIEW ).sink ).toBe( Core.node( INTERPRETER ) );
		expect( Core.node( INTERPRETER ) ).toBe( backbone );
	} );

	test( 'a graphGeneration bump re-renders the consumer so useNodeState re-subscribes to the fresh view', async () => {
		mountExospine();
		const client = makeFakeClient( { list_logs: oneLogReply() } );
		const { result } = renderHook( () => {
			const graph = usePartitionViewerGraph( { commandClient: client } );
			const view = useNodeState( VIEW, 'view' );
			return { graph, view };
		} );
		await act( async () => {} );
		const firstView = Core.node( VIEW );

		await act( async () => {
			Core.bumpGraphGeneration();
		} );
		const freshView = Core.node( VIEW );
		expect( freshView ).not.toBe( firstView );

		// Fresh view publishes; the consumer must observe it (proving rebind).
		await act( async () => {
			freshView.setState( 'view', { selected: 'sentinel' } );
		} );
		expect( result.current.view ).toEqual( { selected: 'sentinel' } );
	} );
} );

describe( 'usePartitionViewerGraph — visibility-gated streaming', () => {
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

	test( 'resumes from the last streamed offset on refocus (reopen carries &positions=), not a blind tail', async () => {
		mountGraph( makeFakeClient( { list_logs: oneLogReply() } ) );
		await act( async () => {} );
		// Server stamps segment:offset in ID + partition dir in FROM.
		const env = newMessage();
		env[ TYPE ] = TM_BYTESTREAM;
		env[ KEY ] = 'p0';
		env[ FROM ] = 'firehose.p0';
		env[ ID ] = '3:14200:90';
		env[ VALUE ] = 'a real log line';
		act( () => FakeEventSource.last.dispatch( 'msg', pack( env ) ) );
		// Hide → close; refocus must reopen SEEKING the last offset, not tail.
		act( () => setVisibility( 'hidden' ) );
		act( () => setVisibility( 'visible' ) );
		const url = FakeEventSource.last.url;
		expect( url ).toContain( 'positions=' );
		const positions = JSON.parse(
			decodeURIComponent(
				url.split( 'positions=' )[ 1 ].split( '&' )[ 0 ]
			)
		);
		expect( positions ).toEqual( {
			'firehose.p0': { segment: 3, offset: 14200 + 90 },
		} );
	} );
} );

describe( 'usePartitionViewerGraph — pause disconnects / play resumes', () => {
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
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		const open = FakeEventSource.last;
		expect( open.closed ).toBe( false );
		act( () => result.current.setPaused( true ) );
		expect( open.closed ).toBe( true );
		// The view flag is still published for the button + empty-state label.
		expect( Core.node( VIEW ).setStateCache.view.paused ).toBe( true );
	} );

	test( 'setPaused(false) resumes at the paused offset (reopen carries &positions=), not a blind tail', async () => {
		const { result } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		// A streamed record stamps segment:offset in ID + partition dir in FROM.
		const env = newMessage();
		env[ TYPE ] = TM_BYTESTREAM;
		env[ KEY ] = 'p0';
		env[ FROM ] = 'firehose.p0';
		env[ ID ] = '7:2200:40';
		env[ VALUE ] = 'a real log line';
		act( () => FakeEventSource.last.dispatch( 'msg', pack( env ) ) );
		act( () => result.current.setPaused( true ) );
		const before = FakeEventSource.instances.length;
		act( () => result.current.setPaused( false ) );
		// A fresh EventSource opened, seeking the exact next record boundary.
		expect( FakeEventSource.instances.length ).toBe( before + 1 );
		const url = FakeEventSource.last.url;
		expect( url ).toContain( 'positions=' );
		const positions = JSON.parse(
			decodeURIComponent(
				url.split( 'positions=' )[ 1 ].split( '&' )[ 0 ]
			)
		);
		expect( positions ).toEqual( {
			'firehose.p0': { segment: 7, offset: 2200 + 40 },
		} );
	} );

	test( 'step while paused fetches ONE record over /command — the stream stays offline', async () => {
		// Server-stamped by the ephemeral Consumer: FROM + ID breadcrumb.
		const stepped = newMessage();
		stepped[ TYPE ] = TM_BYTESTREAM;
		stepped[ FROM ] = 'firehose.p0';
		stepped[ ID ] = '7:120:30';
		stepped[ VALUE ] = 'stepped one';
		const payload = {
			list_logs: oneLogReply(),
			read_message: {
				message: [ ...stepped ],
				cursor: { segment: 7, offset: 150 },
				at_eof: false,
			},
		};
		const client = makeFakeClient( payload );
		const { result } = mountGraph( client );
		await act( async () => {} );
		// A live frame seeds the resume cursor, then pause closes the stream.
		const env = newMessage();
		env[ TYPE ] = TM_BYTESTREAM;
		env[ KEY ] = '';
		env[ FROM ] = 'firehose.p0';
		env[ ID ] = '7:100:20';
		env[ VALUE ] = 'seen live';
		act( () => FakeEventSource.last.dispatch( 'msg', pack( env ) ) );
		act( () => result.current.setPaused( true ) );

		const esCount = FakeEventSource.instances.length;
		await act( async () => result.current.step() );

		// No stream opened; the record rode the command channel.
		expect( FakeEventSource.instances.length ).toBe( esCount );
		const cmd = client.batches
			.flat()
			.find( ( m ) => 'read_message' === m[ VALUE ]?.name );
		expect( cmd[ VALUE ].arguments ).toEqual( [ 'firehose.p0', '7:120' ] );
		const view = Core.node( VIEW );
		expect( view.lines[ 0 ].content ).toBe( 'stepped one' );
		// Stamped like a streamed frame: sub-prefixed FROM keeps the P column.
		expect( view.lines[ 0 ].partition ).toBe( 0 );

		// The SECOND step asks for offset + length — the next record.
		payload.read_message = {
			message: [ ...stepped ],
			cursor: { segment: 7, offset: 160 },
			at_eof: false,
		};
		await act( async () => result.current.step() );
		const cmds = client.batches
			.flat()
			.filter( ( m ) => 'read_message' === m[ VALUE ]?.name );
		expect( cmds[ 1 ][ VALUE ].arguments ).toEqual( [
			'firehose.p0',
			'7:150',
		] );
	} );

	test( 'step while LIVE is a no-op (paused-only control)', async () => {
		const { result } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		const before = FakeEventSource.instances.length;
		await act( async () => result.current.step() );
		expect( FakeEventSource.instances.length ).toBe( before );
	} );

	test( 'a user pause outranks a visibility refocus: pause → hide → refocus stays CLOSED (no auto-resume)', async () => {
		const { result } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		const open = FakeEventSource.last;
		act( () => result.current.setPaused( true ) );
		expect( open.closed ).toBe( true );
		const afterPause = FakeEventSource.instances.length;
		// Hiding then refocusing the tab must NOT reopen a user-paused stream.
		act( () => setVisibility( 'hidden' ) );
		act( () => setVisibility( 'visible' ) );
		expect( FakeEventSource.instances.length ).toBe( afterPause );
		expect( FakeEventSource.last.closed ).toBe( true );
	} );

	test( 'reinit while paused re-publishes paused:true and does NOT reopen the stream', async () => {
		mountExospine();
		const { result } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		act( () => result.current.setPaused( true ) );
		const afterPause = FakeEventSource.instances.length;
		await act( async () => {
			Core.bumpGraphGeneration();
		} );
		// The rebuilt view defaults paused:false; the hook re-applies the pause.
		expect( Core.node( VIEW ).setStateCache.view.paused ).toBe( true );
		// And no fresh EventSource opened for the rebuilt-while-paused graph.
		expect( FakeEventSource.instances.length ).toBe( afterPause );
	} );

	const twoLogReply = () => [
		{ key: 'firehose.p0', label: 'firehose.p0' },
		{ key: 'errors.p0', label: 'errors.p0' },
	];

	test( 'selectLog while paused does NOT reopen the stream (stays closed, slot stays freed)', async () => {
		const { result } = mountGraph(
			makeFakeClient( { list_logs: twoLogReply() } )
		);
		await act( async () => {} );
		act( () => result.current.setPaused( true ) );
		const closed = FakeEventSource.last;
		const count = FakeEventSource.instances.length;
		act( () => result.current.selectLog( 'errors.p0' ) );
		// The dropdown change must NOT revive the EventSource while paused.
		expect( FakeEventSource.instances.length ).toBe( count );
		expect( closed.closed ).toBe( true );
		// But the new selection is recorded for Play.
		expect( Core.node( VIEW ).setStateCache.view.selected ).toBe(
			'errors.p0'
		);
	} );

	test( 'Play after a paused selectLog opens the NEW selection (tail, no stale offset)', async () => {
		const { result } = mountGraph(
			makeFakeClient( { list_logs: twoLogReply() } )
		);
		await act( async () => {} );
		// Stream firehose.p0 so a stale resume offset exists for the OLD dir.
		const env = newMessage();
		env[ TYPE ] = TM_BYTESTREAM;
		env[ KEY ] = 'p0';
		env[ FROM ] = 'firehose.p0';
		env[ ID ] = '2:100:20';
		env[ VALUE ] = 'old line';
		act( () => FakeEventSource.last.dispatch( 'msg', pack( env ) ) );
		act( () => result.current.setPaused( true ) );
		act( () => result.current.selectLog( 'errors.p0' ) );
		const before = FakeEventSource.instances.length;
		act( () => result.current.setPaused( false ) );
		expect( FakeEventSource.instances.length ).toBe( before + 1 );
		const url = FakeEventSource.last.url;
		expect( url ).toContain( 'subscribe=errors.p0' );
		// A fresh selection tails — the OLD dir's resume offset must not leak in.
		expect( url ).not.toContain( 'positions=' );
	} );

	test( 'seek while paused does NOT reopen the stream', async () => {
		const { result } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		act( () => result.current.setPaused( true ) );
		const count = FakeEventSource.instances.length;
		act( () =>
			result.current.seek(
				'firehose.p0',
				{ 'firehose.p0': { segment: 5, offset: 0 } },
				{ segment: 5, offset: 200 }
			)
		);
		expect( FakeEventSource.instances.length ).toBe( count );
	} );

	test( 'Play after a paused seek replays that segment and the tracker flips at the boundary', async () => {
		const { result } = mountGraph(
			makeFakeClient( { list_logs: oneLogReply() } )
		);
		await act( async () => {} );
		act( () => result.current.setPaused( true ) );
		act( () =>
			result.current.seek(
				'firehose.p0',
				{ 'firehose.p0': { segment: 5, offset: 0 } },
				{ segment: 5, offset: 200 }
			)
		);
		// The seek control still drove the view into replay while paused.
		expect( Core.node( VIEW ).mode ).toBe( 'replay' );
		act( () => result.current.setPaused( false ) );
		// The reopened stream replays the seeked segment, not a stale offset.
		const url = FakeEventSource.last.url;
		const positions = JSON.parse(
			decodeURIComponent(
				url.split( 'positions=' )[ 1 ].split( '&' )[ 0 ]
			)
		);
		expect( positions ).toEqual( {
			'firehose.p0': { segment: 5, offset: 0 },
		} );
		// A replayed record reaching the boundary flips Replay → Live.
		const caughtUp = newMessage();
		caughtUp[ TYPE ] = TM_BYTESTREAM;
		caughtUp[ KEY ] = 'p0';
		caughtUp[ FROM ] = 'firehose.p0';
		caughtUp[ ID ] = '5:300:50';
		caughtUp[ VALUE ] = 'caught up';
		act( () => FakeEventSource.last.dispatch( 'msg', pack( caughtUp ) ) );
		expect( Core.node( VIEW ).mode ).toBe( 'live' );
	} );
} );
