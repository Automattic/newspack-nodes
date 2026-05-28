/**
 * useConsoleGraph tests — the in-browser node graph (WIRING-PLAN §2/§4 spine).
 * SseIn is mocked with a fake connector; Router, CommandInterpreter, Dumper,
 * Metadata, Uptime, HttpOut, and the anonymous Shell are real. Reserved node
 * names come from runtime/reserved-node-names.json.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import { Router } from '../../../runtime/router';
import { CommandInterpreter } from '../../../runtime/command_interpreter';
import { Dumper } from '../../nodes/dumper';
import { Metadata } from '../../nodes/metadata';
import { Uptime } from '../../nodes/uptime';
import { Completion } from '../../nodes/completion';
import { Heartbeat } from '../../nodes/heartbeat';
import { HttpOut } from '../../nodes/httpOut';
import { Shell } from '../../nodes/shell';
import names from '../../../runtime/reserved-node-names.json';

let lastConnector = null;

jest.mock( '../../nodes/sseIn', () => {
	// Extend the REAL SseIn so the session wrap/routing logic is exercised; only
	// the EventSource bits (start/close/pid) are stubbed. Task 10 moved deps from
	// the ctor to public properties (subscribe/baseUrl/nonce via arguments=); the
	// fake exposes an `opts`-shaped read-back from those public properties so the
	// existing tests can keep asserting against `lastConnector.opts.…`.
	const { SseIn: RealSseIn } = jest.requireActual( '../../nodes/sseIn' );
	class FakeSseIn extends RealSseIn {
		constructor() {
			super();
			this.started = false;
			this.closed = false;
			this._pid = null;
			// eslint-disable-next-line no-undef
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
		}
		close() {
			this.closed = true;
		}
		pid() {
			return this._pid;
		}
		emitConnected( pid ) {
			this._pid = pid;
			this.setState( 'connected', { pid, slot: 1 } );
		}
	}
	return { SseIn: FakeSseIn };
} );

import { useConsoleGraph } from '../useConsoleGraph';

beforeEach( () => {
	Core.reset();
	lastConnector = null;
	window.NewspackNodesData = { restUrl: '/wp-json/', nonce: 'NONCE' };
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

describe( 'useConsoleGraph — graph topology', () => {
	it( 'mounts the full spine under the reserved node names', () => {
		renderGraph();
		expect( Core.node( names.ROUTER ) ).toBeInstanceOf( Router );
		expect( Core.node( names.COMMAND_INTERPRETER ) ).toBeInstanceOf(
			CommandInterpreter
		);
		expect( Core.node( names.OUTPUT ) ).toBeInstanceOf( Dumper );
		expect( Core.node( names.METADATA ) ).toBeInstanceOf( Metadata );
		expect( Core.node( names.UPTIME ) ).toBeInstanceOf( Uptime );
		expect( Core.node( names.COMPLETION ) ).toBeInstanceOf( Completion );
		expect( Core.node( names.HEARTBEAT ) ).toBeInstanceOf( Heartbeat );
		expect( Core.node( names.HTTP ) ).toBeInstanceOf( HttpOut );
		expect( Core.node( names.SSE ) ).toBe( lastConnector );
	} );

	it( 'bumping resetKey tears down + rebuilds the graph (fresh Router)', () => {
		const { rerender } = renderGraph( { resetKey: 0 } );
		const first = Core.node( names.ROUTER );
		expect( first ).toBeInstanceOf( Router );
		act( () => {
			rerender( {
				topology: 'demo',
				partition: 0,
				enabled: true,
				debugLevelRef: { current: 0 },
				resetKey: 1,
			} );
		} );
		const second = Core.node( names.ROUTER );
		expect( second ).toBeInstanceOf( Router );
		expect( second ).not.toBe( first );
	} );

	it( 'mounts the _cwd indirection node sinking into the CI', () => {
		renderGraph();
		const cwd = Core.node( names.CWD );
		expect( cwd ).not.toBeNull();
		expect( cwd.sink ).toBe( Core.node( names.COMMAND_INTERPRETER ) );
	} );

	it( 'points the canvas poll nodes at _cwd and the heartbeat at _sse/workers (no pollTo)', () => {
		renderGraph();
		expect( Core.node( names.METADATA ).target ).toBe( names.CWD );
		expect( Core.node( names.UPTIME ).target ).toBe( names.CWD );
		expect( Core.node( names.HEARTBEAT ).target ).toBe(
			`${ names.SSE }/workers`
		);
		expect( Core.node( names.METADATA ).pollTo ).toBeUndefined();
		expect( Core.node( names.UPTIME ).pollTo ).toBeUndefined();
		expect( Core.node( names.HEARTBEAT ).pollTo ).toBeUndefined();
	} );

	it( 'wires _sse.sink → _command_interpreter (rule #2: everything sinks into the CI)', () => {
		renderGraph();
		// The CI forwards non-command / non-empty-TO SSE traffic to the router;
		// steering stays the SSE node's target (_output), not a direct router sink.
		expect( lastConnector.sink ).toBe(
			Core.node( names.COMMAND_INTERPRETER )
		);
		expect( lastConnector.started ).toBe( true );
	} );

	it( 'sinks every node into the CI — _router is the only node with no sink (rule #2)', () => {
		renderGraph();
		const ci = Core.node( names.COMMAND_INTERPRETER );
		// The reply/boundary nodes are terminal (they render or POST in fill, never
		// forwarding through sink), but rule #2 still wires their sink to the CI so
		// the declared topology is uniform — only _router is bare.
		for ( const name of [
			names.OUTPUT,
			names.COMPLETION,
			names.HTTP,
			names.SSE,
			names.METADATA,
			names.UPTIME,
			names.HEARTBEAT,
		] ) {
			expect( Core.node( name ).sink ).toBe( ci );
		}
		expect( Core.node( names.ROUTER ).sink ).toBeNull();
		expect( ci.sink ).toBe( Core.node( names.ROUTER ) );
	} );

	it( 'wires Shell.sink → _command_interpreter → _router', () => {
		const { result } = renderGraph();
		const shell = result.current.shell;
		expect( shell ).toBeInstanceOf( Shell );
		expect( shell.sink ).toBe( Core.node( names.COMMAND_INTERPRETER ) );
		expect( Core.node( names.COMMAND_INTERPRETER ).sink ).toBe(
			Core.node( names.ROUTER )
		);
	} );

	it( 'subscribes the connector to {topology}.p{N} with baseUrl + nonce', () => {
		renderGraph( { topology: 'demo', partition: 3 } );
		expect( lastConnector.opts.subscribe ).toEqual( [ 'demo.p3' ] );
		expect( lastConnector.opts.baseUrl ).toBe( '/wp-json/' );
		expect( lastConnector.opts.nonce ).toBe( 'NONCE' );
	} );

	it( 'sets the Shell cwd path to the private session default _sse/{reader}', () => {
		const { result } = renderGraph( { topology: 'demo', partition: 2 } );
		expect( result.current.shell.path ).toBe( '_sse/demo.p2' );
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

	it( 'exposes the connected pid (the wrap reads it from _sse, not the Shell)', () => {
		const { result } = renderGraph();
		act( () => lastConnector.emitConnected( 777 ) );
		expect( result.current.ssePid ).toBe( 777 );
		expect( lastConnector.pid() ).toBe( 777 );
	} );

	it( 'pokes workers/heartbeat (with this partition) on the TIMER once a slot is held', () => {
		jest.useFakeTimers();
		try {
			const { getCommandClient } = require( '../../utils/commandClient' );
			const calls = [];
			getCommandClient().postBatch = jest.fn( ( entries ) => {
				calls.push( entries );
				return Promise.resolve( null );
			} );
			renderGraph( { topology: 'demo', partition: 0 } );
			act( () => lastConnector.emitConnected( 777 ) ); // payload { pid, slot: 1 }
			calls.length = 0;
			act( () => jest.advanceTimersByTime( 5000 ) );
			const { TO, VALUE } = require( '../../../runtime/message' );
			const poke = calls
				.flat()
				.find(
					( m ) => m && m[ VALUE ] && 'heartbeat' === m[ VALUE ].name
				);
			expect( poke ).toBeTruthy();
			expect( poke[ VALUE ].arguments ).toBe( '1 10 0' );
			expect( poke[ TO ] ).toBe( 'workers' );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'does not poke heartbeat before a slot is acquired', () => {
		jest.useFakeTimers();
		try {
			const { getCommandClient } = require( '../../utils/commandClient' );
			const calls = [];
			getCommandClient().postBatch = jest.fn( ( entries ) => {
				calls.push( entries );
				return Promise.resolve( null );
			} );
			renderGraph( { topology: 'demo', partition: 0 } );
			// No emitConnected → no slot.
			act( () => jest.advanceTimersByTime( 5000 ) );
			const { VALUE } = require( '../../../runtime/message' );
			const poke = calls
				.flat()
				.find(
					( m ) => m && m[ VALUE ] && 'heartbeat' === m[ VALUE ].name
				);
			expect( poke ).toBeUndefined();
		} finally {
			jest.useRealTimers();
		}
	} );
} );

describe( 'useConsoleGraph — reply routing through _router', () => {
	it( 'an SSE reply with TO=_output lands in the Dumper transcript', () => {
		renderGraph();
		const {
			newMessage,
			TYPE,
			TO,
			VALUE,
			TM_BYTESTREAM,
		} = require( '../../../runtime/message' );
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ TO ] = names.OUTPUT;
		m[ VALUE ] = 'hello from worker';
		act( () => lastConnector.fill( m ) );
		expect( Core.node( names.OUTPUT ).setStateCache.transcript ).toEqual( [
			expect.objectContaining( {
				kind: 'recv',
				text: 'hello from worker',
			} ),
		] );
	} );

	it( 'an SSE broadcast with empty TO lands in the Dumper transcript', () => {
		// A broadcast (e.g. `send _repl ...`) arrives over SSE with TO='' (no
		// reply-node). The browser _router can't peel an empty TO, so it must
		// forward to its sink (_output) — otherwise the broadcast is dropped.
		renderGraph();
		const {
			newMessage,
			TYPE,
			TO,
			VALUE,
			TM_BYTESTREAM,
		} = require( '../../../runtime/message' );
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ TO ] = ''; // broadcast — unaddressed
		m[ VALUE ] = 'broadcast from worker';
		act( () => lastConnector.fill( m ) );
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
			TYPE,
			TO,
			VALUE,
			TM_STRUCT,
		} = require( '../../../runtime/message' );
		const m = newMessage();
		m[ TYPE ] = TM_STRUCT;
		m[ TO ] = names.METADATA;
		m[ VALUE ] = { n1: { class: 'Echo', counter: 1, target: '' } };
		act( () => lastConnector.fill( m ) );
		expect(
			Core.node( names.METADATA ).setStateCache.metadata.nodes
		).toHaveLength( 1 );
		expect(
			Core.node( names.OUTPUT ).setStateCache.transcript ?? []
		).toHaveLength( 0 );
	} );

	it( 'an SSE reply with TO=_completion lands in the Completion node (not the transcript)', () => {
		renderGraph();
		const {
			newMessage,
			TYPE,
			TO,
			KEY,
			VALUE,
			TM_COMMAND,
			TM_RESPONSE,
		} = require( '../../../runtime/message' );
		const m = newMessage();
		// eslint-disable-next-line no-bitwise
		m[ TYPE ] = TM_COMMAND | TM_RESPONSE;
		m[ TO ] = names.COMPLETION;
		m[ KEY ] = 'completion';
		m[ VALUE ] = { name: 'help', payload: 'connect\nconnect_node' };
		act( () => lastConnector.fill( m ) );
		expect(
			Core.node( names.COMPLETION ).setStateCache.candidates.candidates
		).toEqual( [ 'connect', 'connect_node' ] );
		expect(
			Core.node( names.OUTPUT ).setStateCache.transcript ?? []
		).toHaveLength( 0 );
	} );

	it( 'a typed Shell command flows Shell → CI → Router → HttpOut → POST', () => {
		const { result } = renderGraph();
		act( () => lastConnector.emitConnected( 4242 ) );
		const postBatch = jest.fn().mockResolvedValue( null );
		Core.node( names.HTTP ).client.postBatch = postBatch;
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
		// `_sse` wrapped the bare `_output` FROM into the private reply pivot.
		expect( batch[ 1 ][ FROM ] ).toBe( `${ names.SSE }:4242/_output` );
	} );

	it( 'ls -a at the local root (cd /) lists EVERY in-browser node in the transcript', () => {
		const { result } = renderGraph();
		act( () => result.current.shell.fill( 'cd /' ) ); // empty cwd → local CI
		act( () => result.current.shell.fill( 'ls -a' ) );
		const transcript = Core.node( names.OUTPUT ).setStateCache.transcript;
		const recv = transcript.find( ( e ) => e.kind === 'recv' );
		expect( recv ).toBeTruthy();
		expect( recv.text ).toContain( names.COMMAND_INTERPRETER );
		expect( recv.text ).toContain( names.OUTPUT );
		expect( recv.text ).toContain( names.SSE );
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

	it( 'bare ls at the local root lists the CI siblings (everything that sinks into the CI), not _router', () => {
		const { result } = renderGraph();
		act( () => result.current.shell.fill( 'cd /' ) );
		act( () => result.current.shell.fill( 'ls' ) );
		const transcript = Core.node( names.OUTPUT ).setStateCache.transcript;
		const recv = transcript.find( ( e ) => e.kind === 'recv' );
		expect( recv ).toBeTruthy();
		// Default = siblings (sink IS the CI). Per rule #2 every node sinks into
		// the CI, so the poll nodes AND the terminal reply/boundary nodes are all
		// siblings now (_output included).
		expect( recv.text ).toContain( names.METADATA );
		expect( recv.text ).toContain( names.UPTIME );
		expect( recv.text ).toContain( names.OUTPUT );
		// _router is the ONLY node with no sink → never a CI sibling.
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
		m[ VALUE ] = { name: 'dump_metadata', arguments: '', payload: '' };
		m[ LOCAL ] = true;
		return m;
	};

	it( 'a worker cwd re-stamps the poll TO out to the worker and POSTs (reply rides the stream)', () => {
		renderGraph();
		act( () => lastConnector.emitConnected( 4242 ) );
		const postBatch = jest.fn().mockResolvedValue( null );
		Core.node( names.HTTP ).client.postBatch = postBatch;
		// cd onto a worker: the gating effect sets `_cwd.target` to the worker path.
		Core.node( names.CWD ).target = '_sse/demo.p0';
		act( () => {
			Core.node( names.HTTP ).lock();
			Core.node( names.COMMAND_INTERPRETER ).fill( cwdPoll() );
			Core.node( names.HTTP ).flush();
		} );
		expect( postBatch ).toHaveBeenCalledTimes( 1 );
		const batch = postBatch.mock.calls[ 0 ][ 0 ];
		const routed = batch.find(
			( m ) => m && m[ VALUE ] && 'dump_metadata' === m[ VALUE ].name
		);
		expect( routed ).toBeTruthy();
		// `_sse` peeled, leaving the worker reader as TO.
		expect( routed[ TO ] ).toBe( 'demo.p0' );
		// FROM survived the `_cwd` hop (a plain Node doesn't stamp FROM); `_sse`
		// wrapped the reply pivot with the live pid.
		expect( routed[ FROM ] ).toBe(
			`${ names.SSE }:4242/${ names.METADATA }`
		);
	} );

	it( 'the local root (_cwd.target = "") interprets the poll in-browser (no POST)', () => {
		renderGraph();
		act( () => lastConnector.emitConnected( 4242 ) );
		const postBatch = jest.fn().mockResolvedValue( null );
		Core.node( names.HTTP ).client.postBatch = postBatch;
		// cd /: the gating effect leaves `_cwd.target` empty (local root).
		Core.node( names.CWD ).target = '';
		act( () => {
			Core.node( names.HTTP ).lock();
			Core.node( names.COMMAND_INTERPRETER ).fill( cwdPoll() );
			Core.node( names.HTTP ).flush();
		} );
		// Empty TO → the local CI interprets the poll; the reply routes back to
		// _metadata (in-browser), never out over HTTP.
		expect( postBatch ).not.toHaveBeenCalled();
		expect(
			Core.node( names.METADATA ).setStateCache.metadata
		).toBeDefined();
	} );
} );

describe( 'useConsoleGraph — TIMER batching', () => {
	// Pull every verb out of a single postBatch call's entries.
	const { VALUE } = require( '../../../runtime/message' );
	const verbsIn = ( entries ) =>
		entries
			.map( ( m ) => m && m[ VALUE ] && m[ VALUE ].name )
			.filter( Boolean );

	it( 'batches dump_metadata + uptime into ONE postBatch on the 5s tick', () => {
		jest.useFakeTimers();
		try {
			const { getCommandClient } = require( '../../utils/commandClient' );
			const calls = [];
			getCommandClient().postBatch = jest.fn( ( entries ) => {
				calls.push( entries );
				return Promise.resolve( null );
			} );
			renderGraph( { topology: 'demo', partition: 0 } );
			act( () => lastConnector.emitConnected( 4242 ) );
			// Drain calls accumulated up to the connected paint.
			calls.length = 0;
			// Advance to the 5s tick (Core.now advances with fake timers, so the
			// uptime 5s throttle releases).
			act( () => jest.advanceTimersByTime( 5000 ) );
			// Exactly one tick batched BOTH verbs into a single postBatch.
			const batched = calls.filter( ( entries ) => {
				const verbs = verbsIn( entries );
				return (
					verbs.includes( 'dump_metadata' ) &&
					verbs.includes( 'uptime' )
				);
			} );
			expect( batched ).toHaveLength( 1 );
		} finally {
			jest.useRealTimers();
		}
	} );

	it( 'a non-5s tick posts only dump_metadata (no uptime)', () => {
		jest.useFakeTimers();
		try {
			const { getCommandClient } = require( '../../utils/commandClient' );
			const calls = [];
			getCommandClient().postBatch = jest.fn( ( entries ) => {
				calls.push( entries );
				return Promise.resolve( null );
			} );
			renderGraph( { topology: 'demo', partition: 0 } );
			act( () => lastConnector.emitConnected( 4242 ) );
			calls.length = 0;
			// One 1s tick (well short of the 5s uptime cadence).
			act( () => jest.advanceTimersByTime( 1000 ) );
			expect( calls ).toHaveLength( 1 );
			const verbs = verbsIn( calls[ 0 ] );
			expect( verbs ).toContain( 'dump_metadata' );
			expect( verbs ).not.toContain( 'uptime' );
		} finally {
			jest.useRealTimers();
		}
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
		for ( const key of Object.values( names ) ) {
			if ( key === names.REPL ) {
				continue; // _repl is server-side only; never mounted here.
			}
			expect( Core.node( key ) ).toBeNull();
		}
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
		expect( Core.node( names.OUTPUT ) ).toBeInstanceOf( Dumper );
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
		expect( Core.node( names.HTTP ) ).toBeNull();
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
		expect( lastConnector.started ).toBe( false );
	} );

	it( 'opens the stream when streamEnabled flips true (cd back onto a worker)', () => {
		const { rerender } = renderGraph( { streamEnabled: false } );
		expect( lastConnector.started ).toBe( false );
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

	it( 'clears the heartbeat slot when the stream is gated off', () => {
		const { rerender } = renderGraph( { streamEnabled: true } );
		act( () => lastConnector.emitConnected( 4242 ) ); // sets slot 1
		expect( Core.node( names.HEARTBEAT ).slot ).toBe( 1 );
		act( () => rerender( rerenderProps( false ) ) );
		expect( Core.node( names.HEARTBEAT ).slot ).toBeNull();
	} );
} );
