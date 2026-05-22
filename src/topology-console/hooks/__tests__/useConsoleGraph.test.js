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
import { HttpOut } from '../../nodes/httpOut';
import { Shell } from '../../nodes/shell';
import names from '../../../runtime/reserved-node-names.json';

let lastConnector = null;

jest.mock( '../../nodes/sseIn', () => {
	// Extend the REAL SseIn so the session wrap/routing logic is exercised; only
	// the EventSource bits (start/close/pid) are stubbed.
	const { SseIn: RealSseIn } = jest.requireActual( '../../nodes/sseIn' );
	class FakeSseIn extends RealSseIn {
		constructor( opts ) {
			super( opts );
			this.opts = opts;
			this.started = false;
			this.closed = false;
			this._pid = null;
			// eslint-disable-next-line no-undef
			lastConnector = this;
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
		expect( Core.node( names.HTTP ) ).toBeInstanceOf( HttpOut );
		expect( Core.node( names.SSE ) ).toBe( lastConnector );
	} );

	it( 'wires _sse.sink → _router', () => {
		renderGraph();
		expect( lastConnector.sink ).toBe( Core.node( names.ROUTER ) );
		expect( lastConnector.started ).toBe( true );
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

	it( 'pokes workers/heartbeat (with this partition) to keep the SSE slot alive', () => {
		jest.useFakeTimers();
		try {
			renderGraph( { topology: 'demo', partition: 0 } );
			const { getCommandClient } = require( '../../utils/commandClient' );
			const send = jest.fn().mockResolvedValue( null );
			getCommandClient().send = send;
			act( () => lastConnector.emitConnected( 777 ) ); // payload { pid, slot: 1 }
			act( () => jest.advanceTimersByTime( 5000 ) );
			expect( send ).toHaveBeenCalledWith(
				expect.objectContaining( {
					to: 'workers',
					verb: 'heartbeat',
					payload: expect.objectContaining( {
						slot: 1,
						partition: 0,
					} ),
				} )
			);
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
		expect( batch[ 1 ][ FROM ] ).toBe(
			`_http/${ names.SSE }:4242/_output`
		);
	} );

	it( 'ls at the local root (cd /) lists the in-browser nodes in the transcript', () => {
		const { result } = renderGraph();
		act( () => result.current.shell.fill( 'cd /' ) ); // empty cwd → local CI
		act( () => result.current.shell.fill( 'ls' ) );
		const transcript = Core.node( names.OUTPUT ).setStateCache.transcript;
		const recv = transcript.find( ( e ) => e.kind === 'recv' );
		expect( recv ).toBeTruthy();
		expect( recv.text ).toContain( names.COMMAND_INTERPRETER );
		expect( recv.text ).toContain( names.OUTPUT );
		expect( recv.text ).toContain( names.SSE );
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
