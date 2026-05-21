/**
 * useConsoleGraph — mounts the per-session in-browser node graph that
 * carries the topology console's live SSE-in + command-out path:
 *
 *   SseConnector --fill--> SessionSink (registered as `session`)
 *   CommandOut   (registered as `command-out`), driven by the poll + REPL
 *
 * The hook constructs + registers the three nodes in Core, wires
 * connector.setSink(session), starts the stream, derives status/pid from
 * the connector's `connected` state, and tears everything down on unmount
 * or when `enabled` flips false (edit mode).
 *
 * The runtime SseConnector is mocked with a fake EventSource so tests can
 * drive the connected envelope deterministically; SessionSink, CommandOut,
 * and Core are real.
 */

import { renderHook, act } from '@testing-library/react';
import { Core } from '../../../runtime/core';
import { SessionSink } from '../../nodes/SessionSink';

let lastConnector = null;

jest.mock( '../../../runtime/sse_connector', () => {
	const { Node } = require( '../../../runtime/node' );
	class FakeSseConnector extends Node {
		constructor( opts ) {
			super();
			this.opts = opts;
			this.started = false;
			this.closed = false;
			this._pid = null;
			this.registrations.connected = {};
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
		// Test helper: simulate the connected envelope arriving.
		emitConnected( pid ) {
			this._pid = pid;
			this.setState( 'connected', { pid, slot: 1 } );
		}
	}
	return { SseConnector: FakeSseConnector };
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

describe( 'useConsoleGraph', () => {
	it( 'registers SessionSink as `session` and CommandOut as `command-out`', () => {
		renderGraph();
		expect( Core.node( 'session' ) ).toBeInstanceOf( SessionSink );
		expect( Core.node( 'command-out' ) ).not.toBeNull();
	} );

	it( 'subscribes the connector to {topology}.p{N} with baseUrl + nonce', () => {
		renderGraph( { topology: 'demo', partition: 3 } );
		expect( lastConnector.opts.subscribe ).toEqual( [ 'demo.p3' ] );
		expect( lastConnector.opts.baseUrl ).toBe( '/wp-json/' );
		expect( lastConnector.opts.nonce ).toBe( 'NONCE' );
	} );

	it( 'wires the connector sink to the session node and starts the stream', () => {
		renderGraph();
		expect( lastConnector.sink ).toBe( Core.node( 'session' ) );
		expect( lastConnector.started ).toBe( true );
	} );

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

	it( 'returns the live session node so the console can append/clear', () => {
		const { result } = renderGraph();
		expect( result.current.sessionNode ).toBe( Core.node( 'session' ) );
		expect( result.current.commandOutName ).toBe( 'command-out' );
	} );

	it( 'CommandOut reads its reply pivot from the connector pid', () => {
		renderGraph();
		act( () => lastConnector.emitConnected( 777 ) );
		// The console fills command-out; the pid must be the connector's.
		const postBatch = jest.fn().mockResolvedValue( null );
		Core.node( 'command-out' ).client.postBatch = postBatch;
		act( () => {
			Core.node( 'command-out' ).fill( {
				commands: [ { type: 'command', name: 'ls' } ],
			} );
		} );
		// FROM on the worker command (2nd batch line) carries the pid.
		expect( postBatch.mock.calls[ 0 ][ 0 ][ 1 ][ 2 ] ).toBe( '_http/777' );
	} );

	it( 'short-circuits when enabled=false: no nodes, status closed', () => {
		const { result } = renderGraph( { enabled: false } );
		expect( result.current.status ).toBe( 'closed' );
		expect( result.current.ssePid ).toBeNull();
		expect( Core.node( 'session' ) ).toBeNull();
		expect( Core.node( 'command-out' ) ).toBeNull();
		expect( lastConnector ).toBeNull();
	} );

	it( 'closes the connector and unregisters nodes on unmount', () => {
		const { unmount } = renderGraph();
		const connector = lastConnector;
		unmount();
		expect( connector.closed ).toBe( true );
		expect( Core.node( 'session' ) ).toBeNull();
		expect( Core.node( 'command-out' ) ).toBeNull();
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
		// Old connector closed, a fresh one opened on the new partition.
		expect( first.closed ).toBe( true );
		expect( lastConnector ).not.toBe( first );
		expect( lastConnector.opts.subscribe ).toEqual( [ 'demo.p1' ] );
		expect( Core.node( 'session' ) ).toBeInstanceOf( SessionSink );
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
		expect( Core.node( 'session' ) ).toBeNull();
		expect( Core.node( 'command-out' ) ).toBeNull();
	} );
} );
