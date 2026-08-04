/* global requestAnimationFrame */
/**
 * useConsoleGraph tests — the in-browser node graph. SseIn is mocked with a fake
 * connector (the EventSource bits) so the session wrap/routing logic still runs;
 * Router, CommandInterpreter, Dumper, Metadata, Uptime, RemoteIpc (composing the
 * fake SseIn + a real HttpOut + Heartbeat), and the anonymous Shell are real.
 * Reserved node names come from runtime/reserved-node-names.json.
 *
 * The worker attachment is now one RemoteIpc per active worker (named `{topology}.p{N}`);
 * the session's own worker is always present. The active RemoteIpc owns the single
 * live SseIn — `lastConnector` is its composed SseIn child (`{reader}:sse-in`).
 */

import { renderHook, act, waitFor } from '@testing-library/react';
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
import * as wire from '../../../runtime/message';
import { installFakeCommandWire } from '@newspack-nodes/shared/test-utils/fakeCommandWire';

// The command wire is faked, not the client — commands travel the real graph
// and their replies come back addressed `TO = FROM`. beforeEach answers the
// background topology seed so it is a real no-op, not a swallowed failure.
// mockSend sees the verb in the `{ to, verb, args }` shape the assertions read.
const mockSend = jest.fn();

let lastConnector = null;

// FakeEventSource: real `msg` frame → route-by-TO, not empty-name stamp path.
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
	// Extend the REAL SseInNode; only start/close bookkeeping layered on.
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
			// Complete lease envelope; _applyConnected fires CONNECTED.
			this._applyConnected(
				`PID ${ pid } SLOT 1 OWNER 9007199254740993 ` +
					'SUBSCRIPTIONS x INTERVAL 2000'
			);
		}
	}
	return { SseInNode: FakeSseIn };
} );

import { useConsoleGraph } from '../useConsoleGraph';

beforeEach( () => {
	// Dumper persists its transcript to localStorage; isolate it per test.
	window.localStorage.clear();
	Core.reset();
	lastConnector = null;
	RemoteIpcNode.active = null;
	FakeEventSource.last = null;
	global.EventSource = FakeEventSource;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
	mockSend.mockReset();
	installFakeCommandWire( ( m ) =>
		mockSend( {
			to: String( m[ wire.TO ] ),
			verb: m[ wire.VALUE ]?.name,
			args: m[ wire.VALUE ]?.arguments,
		} )
	);
	mockSend.mockImplementation( ( message ) => {
		if ( 'topologies' === message?.to && 'get' === message?.verb ) {
			return Promise.resolve(
				reply( {
					name: 'demo',
					source: 'user',
					tsl: '',
					expanded: { nodes: [], edges: [] },
					resolved_config_edges: [],
				} )
			);
		}
		return undefined;
	} );
} );

const loadEmptyCatalog = () =>
	Promise.resolve( { classes: [], formatters: [] } );

const renderGraph = ( props = {} ) =>
	renderHook(
		( p ) =>
			useConsoleGraph( {
				topology: 'demo',
				partition: 0,
				enabled: true,
				debugLevelRef: { current: 0 },
				loadCatalog: loadEmptyCatalog,
				...p,
			} ),
		{ initialProps: props }
	);

// The composed HttpOut of the session worker's RemoteIpc — where sends land.
const httpOf = () => Core.node( names.HTTP );

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
		// No top-level `_sse`, but `_http`/`_heartbeat` are shared singletons.
		expect( Core.node( names.SSE ) ).toBeNull();
		expect( Core.node( names.HTTP ) ).toBe( Core.node( names.HTTP ) );
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

	it( 'makes each RemoteIpc with a token-free (worker-only) argument token', () => {
		renderGraph( { topology: 'demo', partition: 3 } );
		// baseUrl/nonce come from the localized global, NOT make_node tokens.
		expect( Core.node( 'demo.p3' ).arguments ).toEqual( [ 'demo.p3' ] );
	} );

	it( 'sets the Shell cwd path to the bare session worker reader', () => {
		const { result } = renderGraph( { topology: 'demo', partition: 2 } );
		expect( result.current.shell.path ).toBe( 'demo.p2' );
	} );
} );

describe( 'useConsoleGraph — TIMER batch lock/flush pairing', () => {
	it( 'batches one tick of the active worker polls into a SINGLE postBatch', async () => {
		renderGraph();
		// Let /auth land: a node with no session mints nothing.
		await act( async () => {} );
		act( () => lastConnector.emitConnected( 4242 ) );
		const postBatch = jest.fn().mockResolvedValue( [] );
		httpOf( 'demo.p0' ).client = { postBatch };
		// Point the cwd at the active worker so polls route to its HttpOut.
		Core.node( names.CWD ).target = 'demo.p0';
		// One Router TIMER tick: every poll rides ONE POST via active HttpOut.
		act( () => Core.node( names.ROUTER ).fireCb() );
		expect( postBatch ).toHaveBeenCalledTimes( 1 );
		const { VALUE } = require( '../../../runtime/message' );
		const verbNames = postBatch.mock.calls[ 0 ][ 0 ]
			.map( ( m ) => m && m[ VALUE ] && m[ VALUE ].name )
			.filter( Boolean );
		expect( verbNames ).toContain( 'dump_metadata' );
	} );

	// @longform
	// This replaces a "flushes the SAME node it locked when a steal swaps
	// active mid-notify" test. Both hooks now close over the one `_http`, so
	// RemoteIpcNode.active is not read by either and the steal it staged could
	// no longer make the assertion fail — a tautology. What is worth pinning is
	// that the bracket actually holds the buffer across notifyTimer.
	it( 'holds `_http` locked across notifyTimer and releases it after', () => {
		renderGraph( {
			topology: 'demo',
			partition: 0,
			workers: [ 'demo.p0' ],
		} );
		const router = Core.node( names.ROUTER );
		const http = Core.node( names.HTTP );

		expect( http.locked ).toBe( false );
		act( () => {
			router.beforeTimerNotify();
		} );
		expect( http.locked ).toBe( true );
		act( () => {
			router.afterTimerNotify();
		} );
		expect( http.locked ).toBe( false );
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
		// Connected envelope carries slot 1; Heartbeat keeps that slot alive.
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
		// Stealing to the other worker closes demo.p0; onClose clears the pid.
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

	it( 'stops the router tick when hidden, so every poller stops with it', () => {
		// Pollers hitchhike the tick — dump_metadata (1s), uptime (5s), dmesg
		// (10s), topologies list (10s). Only the SSE was gated, so a hidden
		// console kept POSTing all of them. (The heartbeat was already silent:
		// closing the stream calls clearSlot, which stopTimers on the last
		// lease.) Gating the tick they share stops them coherently.
		renderGraph( { streamEnabled: true } );
		const router = Core.node( names.ROUTER );
		expect( router.mode ).not.toBe( 'inactive' );

		// Prove the mechanism, not just the router's own flag: a hitchhiking
		// poller fires from notify_timer, so a stopped tick must silence it.
		const metadata = Core.node( names.METADATA );
		const before = metadata.counter;
		act( () => router.fireCb() );
		expect( metadata.counter ).toBeGreaterThan( before );

		// …so an inactive router is a silent poller: notify_timer only runs
		// from the router's own fire path.
		act( () => setVisibility( 'hidden' ) );
		expect( router.mode ).toBe( 'inactive' );

		// Resuming must actually repaint: at cwd '/' this poll is LOCAL (it
		// dumps the browser's own graph, no request), so pausing it while
		// hidden is only acceptable if it comes straight back.
		act( () => setVisibility( 'visible' ) );
		expect( router.mode ).not.toBe( 'inactive' );
		const resumed = metadata.counter;
		// Metadata self-throttles to its own 1s interval off Core.now(), so a
		// frozen clock hides the resume. Step past it.
		const realNow = Date.now;
		Date.now = () => realNow() + 2000;
		try {
			act( () => router.fireCb() );
		} finally {
			Date.now = realNow;
		}
		expect( metadata.counter ).toBeGreaterThan( resumed );
	} );

	it( 'gates the tick in EDIT mode too, where the catalog poller lives on', () => {
		// `enabled` is false in edit mode (mode !== 'edit'), but
		// useTopologyCatalog deliberately keeps its 10s router-hitchhiking
		// poll mounted there. Honouring `enabled` would leave the leak open on
		// the one path guaranteed to still be polling.
		renderGraph( { enabled: false } );
		const router = Core.node( names.ROUTER );

		act( () => setVisibility( 'hidden' ) );
		expect( router.mode ).toBe( 'inactive' );
		// The tick interval survives the pause: a bare setTimer() hitchhike
		// reads it, and would inherit 0 from stopTimer.
		expect( router.interval_ms ).toBe( 1000 );

		act( () => setVisibility( 'visible' ) );
		expect( router.mode ).not.toBe( 'inactive' );
	} );

	it( 'does NOT open the stream while streaming is off, even when visible', () => {
		renderGraph( { streamEnabled: false } );
		// The session worker's RemoteIpc EXISTS (it's always mounted)…
		expect( Core.node( 'demo.p0' ) ).toBeInstanceOf( RemoteIpcNode );
		act( () => setVisibility( 'hidden' ) );
		act( () => setVisibility( 'visible' ) );
		// Streaming off: connect() never ran; no SseIn child built (null).
		expect( Core.node( 'demo.p0' ).sseIn ).toBeNull();
		expect( lastConnector ).toBeNull();
	} );
} );

describe( 'useConsoleGraph — reply routing through _router', () => {
	// Data-plane frames coalesce onto the next animation frame; flush it.
	const flushFrame = () =>
		act(
			async () =>
				await new Promise( ( resolve ) =>
					requestAnimationFrame( () => resolve() )
				)
		);

	it( 'an SSE reply with TO=_output lands in the Dumper transcript', async () => {
		renderGraph();
		// Packed `msg` via EventSource → route-by-TO, not empty-name stamp.
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
		await flushFrame();
		expect( Core.node( names.OUTPUT ).setStateCache.transcript ).toEqual( [
			expect.objectContaining( {
				kind: 'recv',
				text: 'hello from worker',
			} ),
		] );
	} );

	it( 'an SSE broadcast with empty TO lands in the Dumper transcript', async () => {
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
		await flushFrame();
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
		const tsl = 'make_node Echo greeter\n';
		mockSend.mockResolvedValue( { name: 'demo', source: 'user', tsl } );
		await act( async () => {
			renderGraph();
			await Promise.resolve();
		} );
		// Fired topologies `get` — same direct REST command edit mode uses.
		expect( mockSend ).toHaveBeenCalledWith(
			expect.objectContaining( {
				to: 'topologies',
				verb: 'get',
				args: [ 'demo' ],
			} )
		);
		// The .tsl's own nodes seed the canvas before dump_metadata lands.
		const seeded = Core.node( names.METADATA ).setStateCache.metadata;
		expect( seeded.nodes.map( ( n ) => n.id ) ).toContain( 'greeter' );
	} );

	it( 'does NOT seed the Metadata node at the local root (cwd "/") — only at a worker scope', async () => {
		mockSend.mockResolvedValue( {
			name: 'demo',
			source: 'user',
			tsl: 'make_node Echo greeter\n',
		} );
		renderGraph();
		// cd / before the seed resolves; seeding topology paints wrong graph.
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

	it( 'a typed Shell command flows Shell → interpreter → Router → RemoteIpc → POST', async () => {
		const { result } = renderGraph();
		// Let /auth land: a node with no session mints nothing.
		await act( async () => {} );
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
		expect( batch[ 0 ][ VALUE ].arguments ).toEqual( [ 'demo.p0' ] );
		expect( batch[ 1 ][ TO ] ).toBe( 'demo.p0' );
		expect( batch[ 1 ][ VALUE ].name ).toBe( 'ls' );
		// RemoteIpc wrapped the bare `_output` FROM into the reply address.
		expect( batch[ 1 ][ FROM ] ).toBe( `${ names.SSE }:4242/_output` );
	} );

	it( 'ls -a at the local root (cd /) lists EVERY in-browser node in the transcript', () => {
		const { result } = renderGraph();
		act( () => result.current.shell.fill( 'cd /' ) ); // empty cwd → local
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

	// A poll addressed to `_cwd` (FROM=_metadata), as the poll nodes emit it.
	const cwdPoll = () => {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = names.METADATA;
		m[ TO ] = names.CWD;
		m[ VALUE ] = { name: 'dump_metadata', arguments: [] };
		m[ LOCAL ] = true;
		return m;
	};

	it( 'a worker cwd re-stamps the poll TO out to the worker and POSTs (reply rides the stream)', async () => {
		renderGraph();
		// Let /auth land: a node with no session mints nothing.
		await act( async () => {} );
		act( () => lastConnector.emitConnected( 4242 ) );
		const postBatch = jest.fn().mockResolvedValue( [] );
		httpOf( 'demo.p0' ).client = { postBatch };
		// cd onto a worker: gating sets `_cwd.target` to the bare reader.
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
		// FROM survived the `_cwd` hop; RemoteIpc wrapped it with live pid.
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

describe( 'useConsoleGraph — hub transcript persistence [87]', () => {
	const { saveHubTranscript } = require( '../../core/consolePersistence' );

	it( 'restores the persisted hub transcript into the Dumper on mount', () => {
		saveHubTranscript( [ { kind: 'recv', text: 'last session' } ] );
		renderGraph();
		expect( Core.node( names.OUTPUT ).setStateCache.transcript ).toEqual( [
			expect.objectContaining( { kind: 'recv', text: 'last session' } ),
		] );
	} );

	it( 'keeps the transcript across a worker switch (partition-change rebuild)', () => {
		const { rerender } = renderGraph( { partition: 0 } );
		act( () =>
			Core.node( names.OUTPUT ).append( {
				kind: 'sent',
				text: 'survive the switch',
			} )
		);
		// Switching workers tears down + rebuilds the backbone (fresh Dumper).
		act( () =>
			rerender( {
				topology: 'demo',
				partition: 1,
				enabled: true,
				debugLevelRef: { current: 0 },
			} )
		);
		expect( Core.node( names.OUTPUT ).setStateCache.transcript ).toEqual( [
			expect.objectContaining( { text: 'survive the switch' } ),
		] );
	} );
} );

describe( 'useConsoleGraph — lifecycle', () => {
	// The backbone is the page's and stands either way; what `enabled=false`
	// means is no VIEW nodes and no stream. Edit mode still saves, deletes and
	// expands, and those commands need somewhere to sink.
	it( 'short-circuits when enabled=false: no view nodes, status closed', () => {
		const { result } = renderGraph( { enabled: false } );
		expect( result.current.status ).toBe( 'closed' );
		expect( result.current.ssePid ).toBeNull();
		expect( result.current.shell ).toBeNull();
		expect( Core.node( names.OUTPUT ) ).toBeNull();
		expect( Core.node( names.METADATA ) ).toBeNull();
		expect( Core.node( 'demo.p0' ) ).toBeNull();
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
		// The session RemoteIpc composed the shared singletons on connect.
		expect( Core.node( names.HTTP ) ).not.toBeNull();
		expect( Core.node( names.HEARTBEAT ) ).not.toBeNull();
		unmount();
		// Must NOT survive unmount: next tab's makeNode collides with orphan.
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
		// The in-flight topology `get` reply outlives its node; the Router says
		// so rather than routing it into the void.
		expectConsoleWarn( '_router: WARNING: message not addressed' );
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
		// RemoteIpc mounted; connect() never ran, so no SseIn child was built.
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

// The wire wraps the payload into a reply Message itself.
const reply = ( payload ) => payload;

describe( 'useConsoleGraph — the pre-dump_metadata seed', () => {
	it( 'resolves a tokenized top-level override on a borrowed seed node', async () => {
		mockSend.mockImplementation( ( msg ) => {
			if ( 'topologies' === msg?.to && 'get' === msg?.verb ) {
				return Promise.resolve(
					reply( {
						name: 'demo',
						source: 'user',
						tsl:
							'include wombat-seed-base\n' +
							'cmd cobalt-borrowed-source-619:config set_stats_target <wombat_seed:stats_sink>\n',
						expanded: {
							nodes: [
								'cobalt-borrowed-source-619',
								'amber-old-stats-731',
								'violet-resolved-stats-947',
							].map( ( name ) => ( {
								name,
								class: 'Echo',
								args: [],
								origin: [ 'wombat-seed-base' ],
								via: [ 'wombat-seed-base' ],
							} ) ),
							edges: [
								{
									from: 'cobalt-borrowed-source-619',
									to: 'amber-old-stats-731',
									roles: [ 'config' ],
									config_slots: [ 'set_stats_target' ],
								},
							],
						},
						resolved_config_edges: [
							{
								from: 'cobalt-borrowed-source-619',
								to: 'violet-resolved-stats-947',
								roles: [ 'config' ],
								config_slots: [ 'set_stats_target' ],
							},
						],
					} )
				);
			}
			return undefined;
		} );

		renderGraph();

		await waitFor( () => {
			const seeded = Core.node( names.METADATA )?.setStateCache?.metadata;
			const source = seeded?.nodes.find(
				( node ) => 'cobalt-borrowed-source-619' === node.id
			);
			expect( source?.origin ).toEqual( [ 'wombat-seed-base' ] );
			expect( seeded?.edges ).toContainEqual( {
				from: 'cobalt-borrowed-source-619',
				to: 'violet-resolved-stats-947',
				roles: [ 'config' ],
				config_slots: [ 'set_stats_target' ],
			} );
		} );
	} );

	it( 'surfaces a missing resolved-edge contract as a seed error', async () => {
		mockSend.mockImplementation( ( msg ) => {
			if ( 'topologies' === msg?.to && 'get' === msg?.verb ) {
				return Promise.resolve(
					reply( {
						name: 'demo',
						source: 'user',
						tsl: [
							'make_node Echo indigo-source-863',
							'cmd indigo-source-863:config set_errors_target <wombat_seed:required_errors_sink>',
						].join( '\n' ),
						expanded: { nodes: [], edges: [] },
					} )
				);
			}
			return undefined;
		} );

		const { result } = renderGraph();

		await waitFor( () => {
			expect( result.current.seedError?.message ).toBe(
				'Missing resolved_config_edges in topologies get response.'
			);
		} );
		expect(
			Core.node( names.METADATA )?.setStateCache?.metadata
		).toBeUndefined();
	} );

	it( 'resolves a flat topology own-node config target without making the node borrowed', async () => {
		const loadCatalog = jest.fn().mockResolvedValue( {
			classes: [
				{
					shell_name: 'Wombat_Flame_Builder_619',
					fans_out: false,
					commands: [
						{
							name: 'set_stats_target',
							args: [ { type: 'node_name' } ],
						},
					],
				},
				{ shell_name: 'Echo', fans_out: false, commands: [] },
			],
			formatters: [],
		} );
		mockSend.mockImplementation( ( msg ) => {
			if ( 'topologies' === msg?.to && 'get' === msg?.verb ) {
				return Promise.resolve(
					reply( {
						name: 'demo',
						source: 'user',
						tsl: [
							'make_node Wombat_Flame_Builder_619 cerulean-flame-builder-619',
							'make_node Echo violet-stats-sink-947',
							'cmd cerulean-flame-builder-619:config set_stats_target <wombat_seed:stats_sink>',
						].join( '\n' ),
						expanded: { nodes: [], edges: [] },
						resolved_config_edges: [
							{
								from: 'cerulean-flame-builder-619',
								to: 'violet-stats-sink-947',
								origin: [ 'demo' ],
								roles: [ 'config' ],
								config_slots: [ 'set_stats_target' ],
							},
						],
					} )
				);
			}
			return undefined;
		} );

		renderGraph( { loadCatalog } );

		await waitFor( () => {
			const seeded = Core.node( names.METADATA )?.setStateCache?.metadata;
			const source = seeded?.nodes.find(
				( node ) => 'cerulean-flame-builder-619' === node.id
			);
			expect( source?.borrowed ).not.toBe( true );
			expect( seeded?.edges ).toContainEqual( {
				from: 'cerulean-flame-builder-619',
				to: 'violet-stats-sink-947',
				virtual: true,
			} );
			expect( seeded?.edges ).not.toContainEqual(
				expect.objectContaining( {
					to: '<wombat_seed:stats_sink>',
				} )
			);
		} );
	} );

	it( 'waits for the PHP catalog before folding a custom Tee seed', async () => {
		let resolveCatalog;
		const loadCatalog = jest.fn(
			() =>
				new Promise( ( resolve ) => {
					resolveCatalog = resolve;
				} )
		);
		mockSend.mockImplementation( ( msg ) => {
			if ( 'topologies' === msg?.to && 'get' === msg?.verb ) {
				return Promise.resolve(
					reply( {
						name: 'demo',
						source: 'user',
						tsl: [
							'make_node WombatSeedFanout731 zebra-fanout',
							'make_node Echo giraffe-target',
							'make_node Echo llama-target',
							'connect_node zebra-fanout giraffe-target',
							'connect_node zebra-fanout llama-target',
						].join( '\n' ),
						expanded: { nodes: [], edges: [] },
					} )
				);
			}
			return undefined;
		} );

		const { result } = renderGraph( { loadCatalog } );
		await waitFor( () => expect( loadCatalog ).toHaveBeenCalledTimes( 1 ) );
		await act( async () => {
			await Promise.resolve();
		} );
		expect(
			Core.node( names.METADATA )?.setStateCache?.metadata
		).toBeUndefined();

		await act( async () => {
			resolveCatalog( {
				classes: [
					{ shell_name: 'WombatSeedFanout731', fans_out: true },
					{ shell_name: 'Echo', fans_out: false },
				],
				formatters: [],
			} );
		} );

		await waitFor( () => {
			const seeded = Core.node( names.METADATA )?.setStateCache?.metadata;
			expect(
				seeded.edges.filter( ( edge ) => edge.from === 'zebra-fanout' )
			).toHaveLength( 2 );
		} );
		expect( result.current.seedError ).toBeNull();
	} );

	it( 'surfaces a catalog failure and leaves the pre-metadata seed gated', async () => {
		const loadCatalog = jest
			.fn()
			.mockRejectedValue(
				new Error( 'seed-catalog-sentinel-947 failed' )
			);
		mockSend.mockImplementation( ( msg ) => {
			if ( 'topologies' === msg?.to && 'get' === msg?.verb ) {
				return Promise.resolve(
					reply( {
						name: 'demo',
						source: 'user',
						tsl: [
							'make_node WombatFailedFanout947 zebra-fanout',
							'make_node Echo giraffe-target',
							'make_node Echo llama-target',
							'connect_node zebra-fanout giraffe-target',
							'connect_node zebra-fanout llama-target',
						].join( '\n' ),
						expanded: { nodes: [], edges: [] },
					} )
				);
			}
			return undefined;
		} );

		const { result } = renderGraph( { loadCatalog } );
		await waitFor( () => {
			expect( result.current.seedError?.message ).toBe(
				'seed-catalog-sentinel-947 failed'
			);
		} );
		expect(
			Core.node( names.METADATA )?.setStateCache?.metadata
		).toBeUndefined();
	} );

	it( 'seeds the EXPANDED graph, so an include-only topology paints in one shot', async () => {
		// combined.tsl owns one node and borrows the rest. Seeding the parsed file
		// alone paints that sliver + _repl, and everything else pops in on the next
		// dump_metadata — the staged paint. The seed must expand its includes.
		mockSend.mockImplementation( ( msg ) => {
			if ( 'topologies' === msg?.to && 'get' === msg?.verb ) {
				return Promise.resolve(
					reply( {
						name: 'demo',
						source: 'user',
						tsl: 'include zebra-base\nmake_node Tee wombat:tee\n',
					} )
				);
			}
			if ( 'topologies' === msg?.to && 'expand' === msg?.verb ) {
				return Promise.resolve(
					reply( {
						nodes: [
							{
								name: 'zebra:consumer',
								class: 'Consumer',
								args: [],
								origin: [ 'zebra-base' ],
								via: [ 'zebra-base' ],
							},
						],
						edges: [],
						tree: { 'zebra-base': {} },
					} )
				);
			}
			return undefined;
		} );

		renderGraph();

		await waitFor( () => {
			const seeded = Core.node( names.METADATA )?.setStateCache?.metadata;
			const ids = ( seeded?.nodes || [] ).map( ( n ) => n.id );
			expect( ids ).toContain( 'wombat:tee' );
			expect( ids ).toContain( 'zebra:consumer' );
		} );
	} );

	it( 'uses the expansion `get` ships, without a second round trip', async () => {
		// Two SEQUENTIAL round trips before the first paint is what made an
		// include-based topology feel slow next to a flat one.
		mockSend.mockImplementation( ( msg ) => {
			if ( 'topologies' === msg?.to && 'get' === msg?.verb ) {
				return Promise.resolve(
					reply( {
						name: 'demo',
						source: 'user',
						tsl: 'include zebra-base\nmake_node Tee wombat:tee\n',
						includes: [ 'zebra-base' ],
						expanded: {
							nodes: [
								{
									name: 'zebra:consumer',
									class: 'Consumer',
									args: [],
									origin: [ 'zebra-base' ],
									via: [ 'zebra-base' ],
								},
							],
							edges: [],
							tree: { 'zebra-base': {} },
						},
					} )
				);
			}
			return undefined;
		} );

		renderGraph();

		await waitFor( () => {
			const seeded = Core.node( names.METADATA )?.setStateCache?.metadata;
			expect( ( seeded?.nodes || [] ).map( ( n ) => n.id ) ).toContain(
				'zebra:consumer'
			);
		} );
		expect(
			mockSend.mock.calls.filter( ( c ) => 'expand' === c[ 0 ]?.verb )
		).toHaveLength( 0 );
	} );
} );
