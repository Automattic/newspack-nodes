/**
 * useGraphReset — the shared graph-dirty + Reset Graph logic for BOTH the debug
 * overlay and the topology console. Structure-dirty is driven by the outgoing
 * gate's forward tap (every graph-mutating command — make_node / connect_node /
 * disconnect_node / remove_node — typed, gestured or composed flips it), so the
 * Reset Graph chip stays in sync regardless of how the edit arrived. resetGraph
 * tears down every node, bumps the graph generation to rebuild, clears dirty,
 * and marks the layout dirty so Reset Layout surfaces.
 */

import { renderHook, act } from '@testing-library/react';
import { useGraphReset } from '../useGraphReset';
import { Core } from '../../runtime/core';
import { ShellNode } from '../../runtime/shell-node';
import { OutgoingGateNode } from '../../topology-console/core/outgoingGate';
import { useGraphHandlers } from '../../topology-console/hooks/useGraphHandlers';
import names from '../../runtime/reserved-node-names.json';
import {
	newMessage,
	TYPE,
	VALUE,
	TM_BYTESTREAM,
	TM_COMMAND,
	TM_ERROR,
} from '../../runtime/message';

// Shell_Node tokenizes before dispatch, so `arguments` is a token array.
function commandMsg( name, args = '' ) {
	const argv = Array.isArray( args )
		? args
		: args.split( /\s+/ ).filter( Boolean );
	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ VALUE ] = { name, arguments: argv };
	return m;
}

function makeGate() {
	const gate = new OutgoingGateNode();
	gate.sink = { fill: () => {} };
	return gate;
}

describe( 'useGraphReset', () => {
	beforeEach( () => Core.reset() );

	// One session Shell; a test replaces it to model a graph rebuild.
	const SHELL = new ShellNode();
	const opts = ( gate, over = {} ) => ( {
		gate,
		shell: SHELL,
		nodes: [],
		isLocalScope: true,
		canRebuild: true,
		markDirty: () => {},
		...over,
	} );

	it( 'starts not structure-dirty', () => {
		const { result } = renderHook( () =>
			useGraphReset( opts( makeGate() ) )
		);
		expect( result.current.structureDirty ).toBe( false );
		expect( result.current.canResetGraph ).toBe( false );
	} );

	// Every mutating verb AND its REPL alias (make/rm) flips the chip.
	it.each( [
		'make_node',
		'make',
		'connect_node',
		'connect',
		'disconnect_node',
		'disconnect',
		'remove_node',
		'remove',
		'rm',
		'set_sink',
		'register',
		'unregister',
		'move_node',
		'move',
		'mv',
	] )( "the mutating verb '%s' flips structureDirty", ( verb ) => {
		const gate = makeGate();
		const { result } = renderHook( () => useGraphReset( opts( gate ) ) );
		act( () => gate.fill( commandMsg( verb, 'a b' ) ) );
		expect( result.current.structureDirty ).toBe( true );
	} );

	// Exact match only — merely CONTAINING a mutating word won't dirty.
	it.each( [
		'dump_metadata',
		'uptime',
		'heartbeat',
		'dump_node',
		'connect_worker_input',
		'ls',
	] )(
		"the non-mutating verb '%s' does NOT flip structureDirty",
		( verb ) => {
			const gate = makeGate();
			const { result } = renderHook( () =>
				useGraphReset( opts( gate ) )
			);
			act( () => gate.fill( commandMsg( verb ) ) );
			expect( result.current.structureDirty ).toBe( false );
		}
	);

	it( 'marks the layout dirty on a mutating command (drop / connect / disconnect / remove offer a fresh auto-fit)', () => {
		const gate = makeGate();
		let marked = 0;
		renderHook( () =>
			useGraphReset( opts( gate, { markDirty: () => ( marked += 1 ) } ) )
		);
		act( () => gate.fill( commandMsg( 'connect_node', 'a b' ) ) );
		expect( marked ).toBe( 1 );
	} );

	it( 'does not mark the layout dirty on a non-mutating command', () => {
		const gate = makeGate();
		let marked = 0;
		renderHook( () =>
			useGraphReset( opts( gate, { markDirty: () => ( marked += 1 ) } ) )
		);
		act( () => gate.fill( commandMsg( 'dump_metadata' ) ) );
		expect( marked ).toBe( 0 );
	} );

	it( 'a console-made node lights the chip', () => {
		const gate = makeGate();
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( gate ),
		} );
		act( () => gate.fill( commandMsg( 'make_node', 'Tee my-tee' ) ) );
		rerender( opts( gate, { nodes: [ { id: 'my-tee' } ] } ) );
		expect( result.current.canResetGraph ).toBe( true );
	} );

	it( 'a console-made node stops counting once it is removed', () => {
		const gate = makeGate();
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( gate, { nodes: [ { id: 'my-tee' } ] } ),
		} );
		act( () => gate.fill( commandMsg( 'make_node', 'Tee my-tee' ) ) );
		act( () => gate.fill( commandMsg( 'remove_node', 'my-tee' ) ) );
		// Dirty stays (the removal IS an edit); the node no longer counts.
		rerender( opts( gate, { nodes: [] } ) );
		expect( result.current.canResetGraph ).toBe( true );
		rerender( opts( makeGate(), { nodes: [], shell: new ShellNode() } ) );
		expect( result.current.canResetGraph ).toBe( false );
	} );

	it( 'a console-made node still counts under the name it moved to', () => {
		const gate = makeGate();
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( gate ),
		} );
		act( () => gate.fill( commandMsg( 'make_node', 'Tee my-tee' ) ) );
		act( () => gate.fill( commandMsg( 'move_node', 'my-tee your-tee' ) ) );
		// A rebuild clears dirty; only the renamed node keeps the chip lit.
		rerender(
			opts( gate, {
				nodes: [ { id: 'your-tee' } ],
				shell: new ShellNode(),
			} )
		);
		expect( result.current.canResetGraph ).toBe( true );
		rerender(
			opts( gate, {
				nodes: [ { id: 'my-tee' } ],
				shell: new ShellNode(),
			} )
		);
		expect( result.current.canResetGraph ).toBe( false );
	} );

	it( 'judges the verb a reply_to carries, and records the node it makes', () => {
		const gate = makeGate();
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( gate ),
		} );
		act( () =>
			gate.fill(
				commandMsg( 'reply_to', '_output make_node Echo scratch' )
			)
		);
		expect( result.current.structureDirty ).toBe( true );
		rerender(
			opts( gate, {
				nodes: [ { id: 'scratch' } ],
				shell: new ShellNode(),
			} )
		);
		expect( result.current.canResetGraph ).toBe( true );
	} );

	it( 'leaves a reply_to of a reading verb clean', () => {
		const gate = makeGate();
		const { result } = renderHook( () => useGraphReset( opts( gate ) ) );
		act( () =>
			gate.fill( commandMsg( 'reply_to', '_output dump_node a' ) )
		);
		expect( result.current.structureDirty ).toBe( false );
	} );

	// Machinery the graph mints for itself — none of it is a user edit.
	// `freshness:timer` is a useRouterTick Timer, minted outside any
	// build, and resetGraph's rebuild brings it straight back.
	it.each( [
		names.ROUTER,
		'worker-status:view',
		'combined.p0',
		'freshness:timer',
	] )( 'the machinery node %s does not light the chip', ( id ) => {
		const { result } = renderHook( () =>
			useGraphReset( opts( makeGate(), { nodes: [ { id } ] } ) )
		);
		expect( result.current.canResetGraph ).toBe( false );
	} );

	it( 'a node the console made still counts after the gate is replaced', () => {
		let gate = makeGate();
		const nodes = [ { id: 'my-tee' } ];
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( gate, { nodes } ),
		} );
		act( () => gate.fill( commandMsg( 'make_node', 'Tee my-tee' ) ) );
		// A rebuild swaps Shell and gate and clears dirty; the node outlives it.
		gate = makeGate();
		rerender( opts( gate, { nodes, shell: new ShellNode() } ) );
		expect( result.current.structureDirty ).toBe( false );
		expect( result.current.canResetGraph ).toBe( true );
	} );

	it( 'a user node only counts at the local scope', () => {
		const { result } = renderHook( () =>
			useGraphReset(
				opts( makeGate(), {
					nodes: [ { id: 'my-tee' } ],
					isLocalScope: false,
				} )
			)
		);
		expect( result.current.canResetGraph ).toBe( false );
	} );

	it( 'clears structureDirty when the Shell is replaced (a graph rebuild)', () => {
		let gate = makeGate();
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( gate ),
		} );
		act( () => gate.fill( commandMsg( 'connect_node', 'a b' ) ) );
		expect( result.current.structureDirty ).toBe( true );
		// A fresh Shell each rebuild is canonical, so dirty must clear.
		gate = makeGate();
		rerender( opts( gate, { shell: new ShellNode() } ) );
		expect( result.current.structureDirty ).toBe( false );
	} );

	it( 'keeps structureDirty across a gate rebuild under the same Shell', () => {
		let gate = makeGate();
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( gate ),
		} );
		act( () => gate.fill( commandMsg( 'connect_node', 'a b' ) ) );
		// The overlay rebuilds its gate on a station-tab switch.
		gate = makeGate();
		rerender( opts( gate ) );
		expect( result.current.structureDirty ).toBe( true );
		// The new gate's tap is live.
		act( () => gate.fill( commandMsg( 'make_node', 'Tee late-tee' ) ) );
		rerender( opts( gate, { nodes: [ { id: 'late-tee' } ] } ) );
		expect( result.current.canResetGraph ).toBe( true );
	} );

	it( 'canResetGraph is true only when dirty AND local AND can rebuild', () => {
		const gate = makeGate();
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( gate ),
		} );
		act( () => gate.fill( commandMsg( 'connect_node', 'a b' ) ) );
		expect( result.current.canResetGraph ).toBe( true );

		rerender( opts( gate, { isLocalScope: false } ) );
		expect( result.current.canResetGraph ).toBe( false );

		rerender( opts( gate, { canRebuild: false } ) );
		expect( result.current.canResetGraph ).toBe( false );
	} );

	it( 'resetGraph removes every node, bumps generation, clears dirty, marks layout dirty', () => {
		const gate = makeGate();
		let marked = 0;
		const { result } = renderHook( () =>
			useGraphReset( opts( gate, { markDirty: () => ( marked += 1 ) } ) )
		);
		// Two real-ish nodes whose removeNode unregisters them from Core.
		for ( const name of [ 'a', 'b' ] ) {
			Core.registerNode( name, {
				name,
				removeNode: () => Core.unregisterNode( name ),
			} );
		}
		act( () => gate.fill( commandMsg( 'make_node', 'Tee a' ) ) );
		const genBefore = Core.graphGeneration;
		const markedBefore = marked;

		act( () => result.current.resetGraph() );

		expect( Core.nodes.size ).toBe( 0 );
		expect( Core.graphGeneration ).toBe( genBefore + 1 );
		expect( result.current.structureDirty ).toBe( false );
		expect( marked ).toBe( markedBefore + 1 );
	} );
} );

describe( 'useGraphReset — every producer reaches the gate tap', () => {
	beforeEach( () => Core.reset() );

	const opts = ( gate ) => ( {
		gate,
		nodes: [ { id: 'composed-tee' } ],
		isLocalScope: true,
		canRebuild: true,
		markDirty: () => {},
	} );

	it( 'a statement typed into the Shell dirties the graph through its gate', () => {
		const gate = makeGate();
		const shell = new ShellNode();
		shell.sink = gate;
		const { result } = renderHook( () => useGraphReset( opts( gate ) ) );
		const line = newMessage();
		line[ TYPE ] = TM_BYTESTREAM;
		line[ VALUE ] = 'make_node Tee composed-tee';
		act( () => shell.fill( line ) );
		expect( result.current.structureDirty ).toBe( true );
		expect( result.current.canResetGraph ).toBe( true );
	} );

	it( 'a composed make_node sent through the gate marks the graph dirty', () => {
		const gate = makeGate();
		const shell = new ShellNode();
		shell.sink = gate;
		const { result } = renderHook( () => ( {
			reset: useGraphReset( opts( gate ) ),
			handlers: useGraphHandlers( {
				shell,
				graph: { nodes: [], edges: [] },
				catalogClasses: [],
				dispatch: () => {},
				append: () => {},
				onReplSend: () => {},
				onDropStage: () => {},
			} ),
		} ) );
		act( () =>
			result.current.handlers.onCompose( {
				type: TM_COMMAND,
				response: false,
				error: false,
				noreply: false,
				from: '',
				to: '',
				id: '',
				key: '',
				timestamp: '',
				value: '',
				name: 'make_node',
				arguments: 'Tee composed-tee',
				payload: '',
			} )
		);
		expect( result.current.reset.structureDirty ).toBe( true );
		expect( result.current.reset.canResetGraph ).toBe( true );
	} );
} );

describe( 'useGraphReset — only a request command is an edit', () => {
	beforeEach( () => Core.reset() );

	it( 'a local make_node under a non-numeric forged timestamp dirties the graph', () => {
		const gate = makeGate();
		const shell = new ShellNode();
		shell.sink = gate;
		const { result } = renderHook( () =>
			useGraphReset( {
				gate,
				shell,
				nodes: [ { id: 'forged-tee' } ],
				isLocalScope: true,
				canRebuild: true,
				markDirty: () => {},
			} )
		);
		for ( const text of [
			'var message.timestamp = abc',
			'make_node Tee forged-tee',
		] ) {
			const line = newMessage();
			line[ TYPE ] = TM_BYTESTREAM;
			line[ VALUE ] = text;
			act( () => shell.fill( line ) );
		}
		expect( result.current.structureDirty ).toBe( true );
		expect( result.current.canResetGraph ).toBe( true );
	} );

	it( 'a refused UI-bound make_node does not dirty the graph', () => {
		const gate = makeGate();
		const { result } = renderHook( () =>
			useGraphReset( {
				gate,
				nodes: [ { id: 'refused-tee' } ],
				isLocalScope: true,
				canRebuild: true,
				markDirty: () => {},
			} )
		);
		const refusal = commandMsg( 'make_node', 'Tee refused-tee' );
		refusal[ TYPE ] = TM_COMMAND | TM_ERROR;
		act( () => gate.fill( refusal ) );
		expect( result.current.structureDirty ).toBe( false );
		expect( result.current.canResetGraph ).toBe( false );
	} );
} );

describe( 'useGraphReset — the tap reads any VALUE', () => {
	beforeEach( () => Core.reset() );

	it( 'a command with a null VALUE passes the gate without throwing', () => {
		const gate = makeGate();
		const { result } = renderHook( () =>
			useGraphReset( {
				gate,
				shell: new ShellNode(),
				nodes: [],
				isLocalScope: true,
				canRebuild: true,
				markDirty: () => {},
			} )
		);
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ VALUE ] = null;
		expect( () => act( () => gate.fill( m ) ) ).not.toThrow();
		expect( result.current.structureDirty ).toBe( false );
	} );
} );
