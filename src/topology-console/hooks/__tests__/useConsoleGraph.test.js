/**
 * useConsoleGraph tests — the in-browser node graph. SseIn is mocked with a fake
 * connector (the EventSource bits) so the session wrap/routing logic still runs;
 * Router, CommandInterpreter, Dumper, Metadata, Uptime, RemoteIpc (composing the
 * fake SseIn + a real HttpOut + Heartbeat), and the anonymous Shell are real.
 * Reserved node names come from runtime/reserved-node-names.json.
 *
 * The worker-pivot is now one RemoteIpc per active worker (named `{topology}.p{N}`);
 * the session's own worker is always present. The active RemoteIpc owns the single
 * live SseIn — `lastConnector` is its composed SseIn child (`{reader}:sse-in`).
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import { RouterNode } from '../../../runtime/router-node';
import { CommandInterpreterNode } from '../../../runtime/command-interpreter-node';
import { DumperNode } from '../../../runtime/dumper-node';
import { MetadataNode } from '../../../runtime/metadata-node';
import { UptimeNode } from '../../../runtime/uptime-node';
import { CompletionNode } from '../../../runtime/completion-node';
import { RemoteIpcNode } from '../../../runtime/remote-ipc-node';
import { ShellNode } from '../../../runtime/shell-node';
import names from '../../../runtime/reserved-node-names.json';

// The command client is the singleton useConsoleGraph hands each RemoteIpc AND
// uses for the mount-time `topologies get` TSL seed. Mock it so no real fetch
// fires; `mockSend` defaults to resolving null (seed no-ops) and tests override
// it to drive a TSL reply.
const mockSend = jest.fn().mockResolvedValue( null );
const mockPostBatch = jest.fn().mockResolvedValue( [] );
jest.mock( '../../utils/commandClient', () => ( {
	getCommandClient: () => ( { send: mockSend, postBatch: mockPostBatch } ),
	__resetCommandClientForTests: () => {},
} ) );

let lastConnector = null;

// Minimal FakeEventSource — same shape as the substrate's `sse-in-node.test.js`
// and `useRawLogsGraph.test.js`. Lets the reply-routing tests drive a real `msg`
// frame the way production delivers it (through the EventSource), so it lands on
// the REAL SseInNode `msg` listener → `Node.fill` (route-by-TO), NOT the
// `SseInNode.fill` empty-name stamp path that a direct `connector.fill()` hits.
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

jest.mock( '../../../runtime/sse-in-node', () => {
	// Extend the REAL SseInNode so the session wrap/routing logic is exercised. The
	// EventSource itself is the suite's FakeEventSource (`global.EventSource`), so
	// `start()` runs the REAL connector path — registering the production `msg`
	// listener — and only the start/close BOOKKEEPING is layered on. The
	// RemoteIpc/RemoteLink composes this as its receive child, so `lastConnector`
	// tracks the active worker's composed SseIn. The fake exposes an `opts`-shaped
	// read-back of the public config properties so the tests can assert against
	// `lastConnector.opts.…`.
	const { SseInNode: RealSseIn } = jest.requireActual(
		'../../../runtime/sse-in-node'
	);
	class FakeSseIn extends RealSseIn {
		constructor() {
			super();
			this.started = false;
			this.closed = false;
			this.startCount = 0;
			lastConnector = this;
		}
		// Read-back of the ctor-time config now living as public properties.
		get opts() {
			return {
				subscribe: this.subscribe,
				baseUrl: this.baseUrl,
				nonce: this.nonce,
			};
		}
		start() {
			this.started = true;
			this.startCount += 1;
			super.start();
		}
		close() {
			this.closed = true;
			super.close();
		}
		emitConnected( pid ) {
			// The connected envelope is now the flat string the server sends;
			// _applyConnected parses pid + slot into plain fields and fires the
			// CONNECTED bridge.
			this._applyConnected(
				`PID ${ pid } SLOT 1 SUBSCRIPTIONS x INTERVAL 2000`
			);
		}
	}
	return { SseInNode: FakeSseIn };
} );

import { useConsoleGraph } from '../useConsoleGraph';

beforeEach( () => {
	Core.reset();
	lastConnector = null;
	RemoteIpcNode.active = null;
	FakeEventSource.last = null;
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	mockSend.mockReset();
	mockSend.mockResolvedValue( null );
	mockPostBatch.mockReset();
	mockPostBatch.mockResolvedValue( [] );
} );

const renderGraph = ( props = {} ) =>
	renderHook(
		( p ) =>
			useConsoleGraph( {
				topology: 'demo',
				partition: 0,
				enabled: true,
				debugLevelRef: { current: 0 },
				...p,
			} ),
		{ initialProps: props }
	);

// The composed HttpOut of the session worker's RemoteIpc — where its sends land.
const httpOf = ( reader ) => Core.node( reader )?.httpOut;

describe( 'useConsoleGraph — graph topology', () => {
	it( 'mounts the spine + the session worker RemoteIpc under the reserved node names', () => {
		renderGraph();
		expect( Core.node( names.ROUTER ) ).toBeInstanceOf( RouterNode );
		expect( Core.node( names.COMMAND_INTERPRETER ) ).toBeInstanceOf(
			CommandInterpreterNode
		);
		expect( Core.node( names.OUTPUT ) ).toBeInstanceOf( DumperNode );
		expect( Core.node( names.METADATA ) ).toBeInstanceOf( MetadataNode );
		expect( Core.node( names.UPTIME ) ).toBeInstanceOf( UptimeNode );
		expect( Core.node( names.COMPLETION ) ).toBeInstanceOf(
			CompletionNode
		);
		expect( Core.node( 'demo.p0' ) ).toBeInstanceOf( RemoteIpcNode );
		// No top-level `_sse` node (each RemoteIpc owns an UNNAMED SseIn), but
		// `_http`/`_heartbeat` ARE the SHARED reserved-name singletons every
		// RemoteIpc composes — present once the session worker connects on mount.
		expect( Core.node( names.SSE ) ).toBeNull();
		expect( Core.node( names.HTTP ) ).toBe(
			Core.node( 'demo.p0' ).httpOut
		);
		expect( Core.node( names.HEARTBEAT ) ).toBe(
			Core.node( 'demo.p0' ).heartbeat
		);
	} );

	it( 'creates one RemoteIpc per active worker (plus the session worker)', () => {
		renderGraph( {
			topology: 'demo',
			partition: 0,
			workers: [ 'demo.p0', 'other.p1' ],
		} );
		expect( Core.node( 'demo.p0' ) ).toBeInstanceOf( RemoteIpcNode );
		expect( Core.node( 'other.p1' ) ).toBeInstanceOf( RemoteIpcNode );
	} );

	it( 'registers its RemoteIpc channels in Core.reinitNames (console infra, not user nodes for the Reset chip)', () => {
		renderGraph( {
			topology: 'demo',
			partition: 0,
			workers: [ 'demo.p0', 'other.p1' ],
		} );
		expect( Core.reinitNames ).toEqual(
			expect.arrayContaining( [ 'demo.p0', 'other.p1' ] )
		);
	} );

	it( 'bumping the graph generation tears down + rebuilds the graph (fresh Router)', () => {
		renderGraph();
		const first = Core.node( names.ROUTER );
		expect( first ).toBeInstanceOf( RouterNode );
		act( () => Core.bumpGraphGeneration() );
		const second = Core.node( names.ROUTER );
		expect( second ).toBeInstanceOf( RouterNode );
		expect( second ).not.toBe( first );
	} );

	it( 'builds the substrate soft-nodes via interpreter.makeNode (Dumper stays new+named for the debugLevelRef)', () => {
		const spy = jest.spyOn( CommandInterpreterNode.prototype, 'makeNode' );
		try {
			renderGraph();
			const built = spy.mock.calls.map( ( c ) => c[ 0 ] );
			for ( const type of [
				'Metadata',
				'Uptime',
				'Completion',
				'RemoteIpc',
			] ) {
				expect( built ).toContain( type );
			}
			// Dumper needs the debugLevelRef, so it stays bare new + setName.
			expect( built ).not.toContain( 'Dumper' );
			expect( Core.node( names.OUTPUT ).debugLevelRef ).toEqual( {
				current: 0,
			} );
		} finally {
			spy.mockRestore();
		}
	} );

	it( 'mounts the _cwd indirection node sinking into the interpreter', () => {
		renderGraph();
		const cwd = Core.node( names.CWD );
		expect( cwd ).not.toBeNull();
		expect( cwd.sink ).toBe( Core.node( names.COMMAND_INTERPRETER ) );
	} );

	it( 'seeds _cwd.target to the bare session worker reader', () => {
		renderGraph( { topology: 'demo', partition: 2 } );
		expect( Core.node( names.CWD ).target ).toBe( 'demo.p2' );
	} );

	it( 'points the canvas poll nodes at _cwd (no pollTo)', () => {
		renderGraph();
		expect( Core.node( names.METADATA ).target ).toBe( names.CWD );
		expect( Core.node( names.UPTIME ).target ).toBe( names.CWD );
		expect( Core.node( names.METADATA ).pollTo ).toBeUndefined();
		expect( Core.node( names.UPTIME ).pollTo ).toBeUndefined();
	} );

	it( 'wires the session RemoteIpc sink → _command_interpreter (rule #2)', () => {
		renderGraph();
		expect( Core.node( 'demo.p0' ).sink ).toBe(
			Core.node( names.COMMAND_INTERPRETER )
		);
	} );

	it( 'sinks every node into the interpreter — _router is the only node with no sink (rule #2)', () => {
		renderGraph();
		const interpreter = Core.node( names.COMMAND_INTERPRETER );
		for ( const name of [
			names.OUTPUT,
			names.COMPLETION,
			names.METADATA,
			names.UPTIME,
			'demo.p0',
		] ) {
			expect( Core.node( name ).sink ).toBe( interpreter );
		}
		expect( Core.node( names.ROUTER ).sink ).toBeNull();
		expect( interpreter.sink ).toBe( Core.node( names.ROUTER ) );
	} );

	it( 'wires Shell.sink → _command_interpreter → _router', () => {
		const { result } = renderGraph();
		const shell = result.current.shell;
		expect( shell ).toBeInstanceOf( ShellNode );
		expect( shell.sink ).toBe( Core.node( names.CONSOLE_TAP ) );
		expect( Core.node( names.COMMAND_INTERPRETER ).sink ).toBe(
			Core.node( names.ROUTER )
		);
	} );

	it( 'subscribes the active connector to {topology}.p{N} with baseUrl + nonce', () => {
		renderGraph( { topology: 'demo', partition: 3 } );
		// First poll/connect boots the session worker's stream.
		expect( lastConnector.opts.subscribe ).toEqual( [ 'demo.p3' ] );
		expect( lastConnector.opts.baseUrl ).toBe( '/wp-json/' );
		expect( lastConnector.opts.nonce ).toBe( 'NONCE' );
	} );

	it( 'sets the Shell cwd path to the bare session worker reader', () => {
		const { result } = renderGraph( { topology: 'demo', partition: 2 } );
		expect( result.current.shell.path ).toBe( 'demo.p2' );
	} );
} );

describe( 'useConsoleGraph — TIMER batch lock/flush pairing', () => {
	it( 'batches one tick of the active worker polls into a SINGLE postBatch', () => {
		renderGraph();
		act( () => lastConnector.emitConnected( 4242 ) );
		const postBatch = jest.fn().mockResolvedValue( [] );
		httpOf( 'demo.p0' ).client = { postBatch };
		// Point the cwd at the active worker so the polls route out to its HttpOut.
		Core.node( names.CWD ).target = 'demo.p0';
		// One Router TIMER tick: every poll this tick emits (dump_metadata + any
		// uptime) rides ONE POST via the active RemoteIpc's HttpOut.
		act( () => Core.node( names.ROUTER ).fireCb() );
		expect( postBatch ).toHaveBeenCalledTimes( 1 );
		const { VALUE } = require( '../../../runtime/message' );
		const verbNames = postBatch.mock.calls[ 0 ][ 0 ]
			.map( ( m ) => m && m[ VALUE ] && m[ VALUE ].name )
			.filter( Boolean );
		expect( verbNames ).toContain( 'dump_metadata' );
	} );

	it( 'flushes the SAME node it locked when a steal swaps active mid-notify', () => {
		renderGraph( {
			topology: 'demo',
			partition: 0,
			workers: [ 'demo.p0', 'other.p1' ],
		} );
		const router = Core.node( names.ROUTER );
		const oldActive = Core.node( 'demo.p0' );
		const newActive = Core.node( 'other.p1' );
		// Make demo.p0 the active link; every RemoteIpc shares the one `_http`.
		act( () => oldActive.connect() );
		expect( RemoteIpcNode.active ).toBe( oldActive );
		newActive.ensureChildren();
		const sharedHttp = Core.node( names.HTTP );
		expect( oldActive.httpOut ).toBe( sharedHttp );
		expect( newActive.httpOut ).toBe( sharedHttp );
		const flush = jest.spyOn( sharedHttp, 'flush' );
		// Run the bracket by hand, stealing active in between (what a poll that
		// reconnects a different worker does mid-notifyTimer). `beforeTimerNotify`
		// captures the node active at lock-time; `afterTimerNotify` must flush
		// THAT captured node's httpOut (the shared `_http`) exactly once, even
		// though active was stolen — never re-resolving the flush off the new
		// active (which would risk a double-flush or a stranded lock).
		act( () => {
			router.beforeTimerNotify();
			RemoteIpcNode.active = newActive; // steal mid-notify
			router.afterTimerNotify();
		} );
		expect( flush ).toHaveBeenCalledTimes( 1 );
	} );
} );

describe( 'useConsoleGraph — connection state', () => {
	it( 'starts in connecting status with a null pid', () => {
		const { result } = renderGraph();
		expect( result.current.status ).toBe( 'connecting' );
		expect( result.current.ssePid ).toBeNull();
	} );

	it( 'flips to open and exposes the pid once the connected envelope lands', () => {
		const { result } = renderGraph();
		act( () => lastConnector.emitConnected( 12345 ) );
		expect( result.current.status ).toBe( 'open' );
		expect( result.current.ssePid ).toBe( 12345 );
	} );

	it( 'exposes the connected pid (the active RemoteIpc reads it from its SseIn)', () => {
		const { result } = renderGraph();
		act( () => lastConnector.emitConnected( 777 ) );
		expect( result.current.ssePid ).toBe( 777 );
		expect( Core.node( 'demo.p0' ).pid() ).toBe( 777 );
	} );

	it( 'holds a Heartbeat slot on the active worker after the connected handshake (slot keepalive)', () => {
		renderGraph();
		// The fake SseIn's connected envelope carries slot 1; the RemoteLink bridge
		// hands it to the composed Heartbeat so the slot is kept alive.
		act( () => lastConnector.emitConnected( 4242 ) );
		expect( Core.node( 'demo.p0' ).heartbeat.slot ).toBe( 1 );
	} );

	it( 'resets the displayed pid when a steal closes the active worker (onClose)', () => {
		const { result } = renderGraph( {
			topology: 'demo',
			partition: 0,
			workers: [ 'demo.p0', 'other.p1' ],
		} );
		// Session worker connects → pid displayed.
		act( () => Core.node( 'demo.p0' ).connect() );
		act( () => Core.node( 'demo.p0' ).sseIn.emitConnected( 4242 ) );
		expect( result.current.ssePid ).toBe( 4242 );
		// Steal to the other worker: its connect() closes demo.p0, whose onClose
		// must clear the displayed pid (the new worker repopulates it on handshake).
		act( () => Core.node( 'other.p1' ).connect() );
		expect( result.current.ssePid ).toBeNull();
	} );
} );

describe( 'useConsoleGraph — visibility-gated streaming', () => {
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

	it( 'opens the stream on mount when visible and streaming', () => {
		renderGraph( { streamEnabled: true } );
		expect( lastConnector.started ).toBe( true );
	} );

	it( 'closes the stream and clears the pid when the tab is hidden', () => {
		const { result } = renderGraph( { streamEnabled: true } );
		act( () => lastConnector.emitConnected( 42 ) );
		expect( result.current.ssePid ).toBe( 42 );
		act( () => setVisibility( 'hidden' ) );
		expect( lastConnector.closed ).toBe( true );
		expect( result.current.ssePid ).toBeNull();
	} );

	it( 'reopens the stream when the tab becomes visible again', () => {
		renderGraph( { streamEnabled: true } );
		act( () => setVisibility( 'hidden' ) );
		lastConnector.startCount = 0;
		act( () => setVisibility( 'visible' ) );
		expect( lastConnector.startCount ).toBe( 1 );
	} );

	it( 'does NOT open the stream while streaming is off, even when visible', () => {
		renderGraph( { streamEnabled: false } );
		// The session worker's RemoteIpc EXISTS (it's always mounted)…
		expect( Core.node( 'demo.p0' ) ).toBeInstanceOf( RemoteIpcNode );
		act( () => setVisibility( 'hidden' ) );
		act( () => setVisibility( 'visible' ) );
		// …but its stream was never opened: with streaming off, connect() never
		// ran, so no SseIn child was ever built (a null connector is the proof, not
		// a vacuous fallback). If one HAD been built, it must not have started.
		expect( Core.node( 'demo.p0' ).sseIn ).toBeNull();
		expect( lastConnector ).toBeNull();
	} );
} );

describe( 'useConsoleGraph — reply routing through _router', () => {
	it( 'an SSE reply with TO=_output lands in the Dumper transcript', () => {
		renderGraph();
		// Deliver the reply the way production does — a packed `msg` frame through
		// the live EventSource — so it lands on the REAL SseIn `msg` listener
		// → Node.fill (route-by-TO), not the SseInNode.fill empty-name stamp path.
		const {
			newMessage,
			pack,
			TYPE,
			TO,
			VALUE,
			TM_BYTESTREAM,
		} = require( '../../../runtime/message' );
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ TO ] = names.OUTPUT;
		m[ VALUE ] = 'hello from worker';
		act( () => FakeEventSource.last.dispatch( 'msg', pack( m ) ) );
		expect( Core.node( names.OUTPUT ).setStateCache.transcript ).toEqual( [
			expect.objectContaining( {
				kind: 'recv',
				text: 'hello from worker',
			} ),
		] );
	} );

	it( 'an SSE broadcast with empty TO lands in the Dumper transcript', () => {
		renderGraph();
		// Empty TO falls back to the connector's target (_output) in Node.fill.
		const {
			newMessage,
			pack,
			TYPE,
			TO,
			VALUE,
			TM_BYTESTREAM,
		} = require( '../../../runtime/message' );
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ TO ] = ''; // broadcast — unaddressed
		m[ VALUE ] = 'broadcast from worker';
		act( () => FakeEventSource.last.dispatch( 'msg', pack( m ) ) );
		expect( Core.node( names.OUTPUT ).setStateCache.transcript ).toEqual( [
			expect.objectContaining( {
				kind: 'recv',
				text: 'broadcast from worker',
			} ),
		] );
	} );

	it( 'an SSE reply with TO=_metadata lands in the Metadata node (not the transcript)', () => {
		renderGraph();
		const {
			newMessage,
			pack,
			TYPE,
			TO,
			VALUE,
			TM_STRUCT,
		} = require( '../../../runtime/message' );
		const m = newMessage();
		m[ TYPE ] = TM_STRUCT;
		m[ TO ] = names.METADATA;
		m[ VALUE ] = { n1: { class: 'Echo', counter: 1, target: '' } };
		act( () => FakeEventSource.last.dispatch( 'msg', pack( m ) ) );
		expect(
			Core.node( names.METADATA ).setStateCache.metadata.nodes
		).toHaveLength( 1 );
		expect(
			Core.node( names.OUTPUT ).setStateCache.transcript ?? []
		).toHaveLength( 0 );
	} );

	it( 'seeds the Metadata node with the topology TSL on mount (instant structure before dump_metadata)', async () => {
		const { newMessage, VALUE } = require( '../../../runtime/message' );
		const tsl = 'make_node Echo greeter\n';
		const reply = newMessage();
		reply[ VALUE ] = {
			name: 'get',
			payload: { name: 'demo', source: 'user', tsl },
		};
		mockSend.mockResolvedValue( reply );
		await act( async () => {
			renderGraph();
			await Promise.resolve();
		} );
		// Fired the topologies `get` for the live topology — the same direct REST
		// command edit mode uses, independent of the SSE stream.
		expect( mockSend ).toHaveBeenCalledWith(
			expect.objectContaining( {
				to: 'topologies',
				verb: 'get',
				args: 'demo',
			} )
		);
		// parseTsl( tsl ).nodes seeded the canvas graph (useGraphSource reads this)
		// before any dump_metadata reply.
		const seeded = Core.node( names.METADATA ).setStateCache.metadata;
		expect( seeded.nodes.map( ( n ) => n.id ) ).toContain( 'greeter' );
	} );

	it( 'does NOT seed the Metadata node at the local root (cwd "/") — only at a worker scope', async () => {
		const { newMessage, VALUE } = require( '../../../runtime/message' );
		const reply = newMessage();
		reply[ VALUE ] = {
			name: 'get',
			payload: {
				name: 'demo',
				source: 'user',
				tsl: 'make_node Echo greeter\n',
			},
		};
		mockSend.mockResolvedValue( reply );
		renderGraph();
		// cd / before the async TSL seed resolves. The local root renders the
		// in-browser graph, never the topology — seeding it here paints the wrong
		// graph and stomps the layout (foreign node ids miss the 'local' map).
		Core.node( names.CWD ).target = '';
		await act( async () => {
			await Promise.resolve();
		} );
		expect(
			Core.node( names.METADATA ).setStateCache?.metadata
		).toBeUndefined();
	} );

	it( 'an SSE reply with TO=_completion lands in the Completion node (not the transcript)', () => {
		renderGraph();
		const {
			newMessage,
			pack,
			TYPE,
			TO,
			KEY,
			VALUE,
			TM_COMMAND,
			TM_RESPONSE,
		} = require( '../../../runtime/message' );
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		m[ TO ] = names.COMPLETION;
		m[ KEY ] = 'completion';
		m[ VALUE ] = { name: 'help', payload: 'connect\nconnect_node' };
		act( () => FakeEventSource.last.dispatch( 'msg', pack( m ) ) );
		expect(
			Core.node( names.COMPLETION ).setStateCache.candidates.candidates
		).toEqual( [ 'connect', 'connect_node' ] );
		expect(
			Core.node( names.OUTPUT ).setStateCache.transcript ?? []
		).toHaveLength( 0 );
	} );

	it( 'a typed Shell command flows Shell → interpreter → Router → RemoteIpc → POST', () => {
		const { result } = renderGraph();
		act( () => lastConnector.emitConnected( 4242 ) );
		const postBatch = jest.fn().mockResolvedValue( [] );
		httpOf( 'demo.p0' ).client = { postBatch };
		act( () => {
			result.current.shell.fill( 'ls -al' );
		} );
		expect( postBatch ).toHaveBeenCalledTimes( 1 );
		const batch = postBatch.mock.calls[ 0 ][ 0 ];
		const { FROM, TO, VALUE } = require( '../../../runtime/message' );
		// connect_worker_input leads; the routed command follows.
		expect( batch[ 0 ][ VALUE ].name ).toBe( 'connect_worker_input' );
		expect( batch[ 0 ][ VALUE ].arguments ).toBe( 'demo.p0' );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p0' );
		expect( batch[ 1 ][ VALUE ].name ).toBe( 'ls' );
		// RemoteIpc wrapped the bare `_output` FROM into the private reply pivot.
		expect( batch[ 1 ][ FROM ] ).toBe( `${ names.SSE }:4242/_output` );
	} );

	it( 'ls -a at the local root (cd /) lists EVERY in-browser node in the transcript', () => {
		const { result } = renderGraph();
		act( () => result.current.shell.fill( 'cd /' ) ); // empty cwd → local interpreter
		act( () => result.current.shell.fill( 'ls -a' ) );
		const transcript = Core.node( names.OUTPUT ).setStateCache.transcript;
		const recv = transcript.find( ( e ) => e.kind === 'recv' );
		expect( recv ).toBeTruthy();
		expect( recv.text ).toContain( names.COMMAND_INTERPRETER );
		expect( recv.text ).toContain( names.OUTPUT );
		expect( recv.text ).toContain( 'demo.p0' );
	} );

	it( 'ls -c at the local root renders the full _cmdList COUNT column (not a flat name dump)', () => {
		const { result } = renderGraph();
		act( () => result.current.shell.fill( 'cd /' ) );
		act( () => result.current.shell.fill( 'ls -c' ) );
		const transcript = Core.node( names.OUTPUT ).setStateCache.transcript;
		const recv = transcript.find( ( e ) => e.kind === 'recv' );
		expect( recv ).toBeTruthy();
		expect( recv.text ).toContain( 'COUNT' );
		expect( recv.text ).toContain( 'NAME' );
	} );

	it( 'bare ls at the local root lists the interpreter siblings, not _router', () => {
		const { result } = renderGraph();
		act( () => result.current.shell.fill( 'cd /' ) );
		act( () => result.current.shell.fill( 'ls' ) );
		const transcript = Core.node( names.OUTPUT ).setStateCache.transcript;
		const recv = transcript.find( ( e ) => e.kind === 'recv' );
		expect( recv ).toBeTruthy();
		expect( recv.text ).toContain( names.METADATA );
		expect( recv.text ).toContain( names.UPTIME );
		expect( recv.text ).toContain( names.OUTPUT );
		// _router is the ONLY node with no sink → never an interpreter sibling.
		expect( recv.text.split( '\n' ) ).not.toContain( names.ROUTER );
	} );
} );

describe( 'useConsoleGraph — _cwd re-stamping routes every scope', () => {
	const {
		newMessage,
		TYPE,
		FROM,
		TO,
		VALUE,
		LOCAL,
		TM_COMMAND,
	} = require( '../../../runtime/message' );

	// A poll addressed to `_cwd` (FROM=_metadata), the way the poll nodes emit it.
	const cwdPoll = () => {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = names.METADATA;
		m[ TO ] = names.CWD;
		m[ VALUE ] = { name: 'dump_metadata', arguments: '' };
		m[ LOCAL ] = true;
		return m;
	};

	it( 'a worker cwd re-stamps the poll TO out to the worker and POSTs (reply rides the stream)', () => {
		renderGraph();
		act( () => lastConnector.emitConnected( 4242 ) );
		const postBatch = jest.fn().mockResolvedValue( [] );
		httpOf( 'demo.p0' ).client = { postBatch };
		// cd onto a worker: the gating effect sets `_cwd.target` to the bare reader.
		Core.node( names.CWD ).target = 'demo.p0';
		act( () => {
			Core.node( names.COMMAND_INTERPRETER ).fill( cwdPoll() );
		} );
		expect( postBatch ).toHaveBeenCalledTimes( 1 );
		const batch = postBatch.mock.calls[ 0 ][ 0 ];
		const routed = batch.find(
			( m ) => m && m[ VALUE ] && 'dump_metadata' === m[ VALUE ].name
		);
		expect( routed ).toBeTruthy();
		expect( routed[ TO ] ).toBe( 'demo.p0' );
		// FROM survived the `_cwd` hop (a plain Node doesn't stamp FROM); RemoteIpc
		// wrapped the reply pivot with the live pid.
		expect( routed[ FROM ] ).toBe(
			`${ names.SSE }:4242/${ names.METADATA }`
		);
	} );

	it( 'the local root (_cwd.target = "") interprets the poll in-browser (no POST)', () => {
		renderGraph();
		act( () => lastConnector.emitConnected( 4242 ) );
		const postBatch = jest.fn().mockResolvedValue( [] );
		httpOf( 'demo.p0' ).client = { postBatch };
		// cd /: the gating effect leaves `_cwd.target` empty (local root).
		Core.node( names.CWD ).target = '';
		act( () => {
			Core.node( names.COMMAND_INTERPRETER ).fill( cwdPoll() );
		} );
		expect( postBatch ).not.toHaveBeenCalled();
		expect(
			Core.node( names.METADATA ).setStateCache.metadata
		).toBeDefined();
	} );
} );

describe( 'useConsoleGraph — lifecycle', () => {
	it( 'short-circuits when enabled=false: no nodes, status closed', () => {
		const { result } = renderGraph( { enabled: false } );
		expect( result.current.status ).toBe( 'closed' );
		expect( result.current.ssePid ).toBeNull();
		expect( result.current.shell ).toBeNull();
		expect( Core.node( names.ROUTER ) ).toBeNull();
		expect( Core.node( names.OUTPUT ) ).toBeNull();
		expect( lastConnector ).toBeNull();
	} );

	it( 'closes the connector and unregisters every node on unmount', () => {
		const { unmount } = renderGraph();
		const connector = lastConnector;
		unmount();
		expect( connector.closed ).toBe( true );
		expect( Core.node( names.ROUTER ) ).toBeNull();
		expect( Core.node( names.OUTPUT ) ).toBeNull();
		expect( Core.node( 'demo.p0' ) ).toBeNull();
		expect( RemoteIpcNode.active ).toBeNull();
	} );

	it( 'tears down the shared _http/_heartbeat singletons on unmount (no orphan for the next tab to collide with)', () => {
		const { unmount } = renderGraph();
		// The session worker's RemoteIpc composed the shared singletons on its
		// mount-time connect.
		expect( Core.node( names.HTTP ) ).not.toBeNull();
		expect( Core.node( names.HEARTBEAT ) ).not.toBeNull();
		unmount();
		// They must NOT survive the console unmount: the next tab's
		// `makeNode( 'HttpOut', '_http' )` registers unconditionally and would
		// throw "node name collision" against an orphan.
		expect( Core.node( names.HTTP ) ).toBeNull();
		expect( Core.node( names.HEARTBEAT ) ).toBeNull();
	} );

	it( 're-mounts cleanly when the partition changes (no name collision)', () => {
		const { rerender } = renderGraph( { partition: 0 } );
		const first = lastConnector;
		expect( () =>
			rerender( {
				topology: 'demo',
				partition: 1,
				enabled: true,
				debugLevelRef: { current: 0 },
			} )
		).not.toThrow();
		expect( first.closed ).toBe( true );
		expect( lastConnector ).not.toBe( first );
		expect( lastConnector.opts.subscribe ).toEqual( [ 'demo.p1' ] );
		expect( Core.node( names.OUTPUT ) ).toBeInstanceOf( DumperNode );
	} );

	it( 'tearing down on enabled→false unregisters nodes + closes the stream', () => {
		const { rerender } = renderGraph( { enabled: true } );
		const connector = lastConnector;
		act( () => {
			rerender( {
				topology: 'demo',
				partition: 0,
				enabled: false,
				debugLevelRef: { current: 0 },
			} );
		} );
		expect( connector.closed ).toBe( true );
		expect( Core.node( names.OUTPUT ) ).toBeNull();
		expect( Core.node( 'demo.p0' ) ).toBeNull();
	} );
} );

describe( 'useConsoleGraph — SSE stream gating (cwd is a worker)', () => {
	const rerenderProps = ( streamEnabled ) => ( {
		topology: 'demo',
		partition: 0,
		enabled: true,
		debugLevelRef: { current: 0 },
		streamEnabled,
	} );

	it( 'does NOT open the stream when streamEnabled is false (cwd not a worker)', () => {
		renderGraph( { streamEnabled: false } );
		// The session worker's RemoteIpc is mounted but its stream is never opened:
		// connect() never ran, so no SseIn child was built. Asserting the node
		// exists AND has no connector beats the old `lastConnector ? … : false`,
		// which passed vacuously when no SseIn was ever constructed.
		expect( Core.node( 'demo.p0' ) ).toBeInstanceOf( RemoteIpcNode );
		expect( Core.node( 'demo.p0' ).sseIn ).toBeNull();
		expect( lastConnector ).toBeNull();
	} );

	it( 'opens the stream when streamEnabled flips true (cd back onto a worker)', () => {
		const { rerender } = renderGraph( { streamEnabled: false } );
		act( () => rerender( rerenderProps( true ) ) );
		expect( lastConnector.started ).toBe( true );
	} );

	it( 'closes the stream and resets the pid when streamEnabled flips false', () => {
		const { result, rerender } = renderGraph( { streamEnabled: true } );
		act( () => lastConnector.emitConnected( 4242 ) );
		expect( result.current.ssePid ).toBe( 4242 );
		act( () => rerender( rerenderProps( false ) ) );
		expect( lastConnector.closed ).toBe( true );
		expect( result.current.ssePid ).toBeNull();
	} );
} );
