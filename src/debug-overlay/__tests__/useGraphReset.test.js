/**
 * useGraphReset — the shared graph-dirty + Reset Graph logic for BOTH the debug
 * overlay and the topology console. Structure-dirty is driven by a tap on the
 * Shell's dispatch (every graph-mutating command — make_node / connect_node /
 * disconnect_node / remove_node — from GUI or REPL flips it), so the Reset Graph
 * chip stays in sync regardless of how the edit arrived. resetGraph tears down
 * every node, bumps the graph generation to rebuild, clears dirty, and marks the
 * layout dirty so Reset Layout surfaces.
 */

import { renderHook, act } from '@testing-library/react';
import { useGraphReset } from '../useGraphReset';
import { Core } from '../../runtime/core';
import { ShellNode } from '../../runtime/shell-node';
import names from '../../runtime/reserved-node-names.json';
import { newMessage, TYPE, VALUE, TM_COMMAND } from '../../runtime/message';

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

function makeShell() {
	const shell = new ShellNode();
	shell.sink = { fill: () => {} };
	return shell;
}

describe( 'useGraphReset', () => {
	beforeEach( () => Core.reset() );

	const opts = ( shell, over = {} ) => ( {
		shell,
		nodes: [],
		isLocalScope: true,
		canRebuild: true,
		markDirty: () => {},
		...over,
	} );

	it( 'starts not structure-dirty', () => {
		const { result } = renderHook( () =>
			useGraphReset( opts( makeShell() ) )
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
	] )( "the mutating verb '%s' flips structureDirty", ( verb ) => {
		const shell = makeShell();
		const { result } = renderHook( () => useGraphReset( opts( shell ) ) );
		act( () => shell.dispatch( commandMsg( verb, 'a b' ) ) );
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
			const shell = makeShell();
			const { result } = renderHook( () =>
				useGraphReset( opts( shell ) )
			);
			act( () => shell.dispatch( commandMsg( verb ) ) );
			expect( result.current.structureDirty ).toBe( false );
		}
	);

	it( 'marks the layout dirty on a mutating command (drop / connect / disconnect / remove offer a fresh auto-fit)', () => {
		const shell = makeShell();
		let marked = 0;
		renderHook( () =>
			useGraphReset( opts( shell, { markDirty: () => ( marked += 1 ) } ) )
		);
		act( () => shell.dispatch( commandMsg( 'connect_node', 'a b' ) ) );
		expect( marked ).toBe( 1 );
	} );

	it( 'does not mark the layout dirty on a non-mutating command', () => {
		const shell = makeShell();
		let marked = 0;
		renderHook( () =>
			useGraphReset( opts( shell, { markDirty: () => ( marked += 1 ) } ) )
		);
		act( () => shell.dispatch( commandMsg( 'dump_metadata' ) ) );
		expect( marked ).toBe( 0 );
	} );

	it( 'a shell-made node lights the chip', () => {
		const shell = makeShell();
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( shell ),
		} );
		act( () => shell.dispatch( commandMsg( 'make_node', 'Tee my-tee' ) ) );
		rerender( opts( shell, { nodes: [ { id: 'my-tee' } ] } ) );
		expect( result.current.canResetGraph ).toBe( true );
	} );

	it( 'a shell-made node stops counting once it is removed', () => {
		const shell = makeShell();
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( shell, { nodes: [ { id: 'my-tee' } ] } ),
		} );
		act( () => shell.dispatch( commandMsg( 'make_node', 'Tee my-tee' ) ) );
		act( () => shell.dispatch( commandMsg( 'remove_node', 'my-tee' ) ) );
		// Dirty stays (the removal IS an edit); the node no longer counts.
		rerender( opts( shell, { nodes: [] } ) );
		expect( result.current.canResetGraph ).toBe( true );
		rerender( opts( makeShell(), { nodes: [] } ) );
		expect( result.current.canResetGraph ).toBe( false );
	} );

	// Machinery the graph mints for itself — none of it is a user edit.
	// `topologymanager:freshness` is a useRouterTick Timer, minted outside any
	// build, and resetGraph's rebuild brings it straight back.
	it.each( [
		names.ROUTER,
		'workerstatus:view',
		'combined.p0',
		'topologymanager:freshness',
	] )( 'the machinery node %s does not light the chip', ( id ) => {
		const { result } = renderHook( () =>
			useGraphReset( opts( makeShell(), { nodes: [ { id } ] } ) )
		);
		expect( result.current.canResetGraph ).toBe( false );
	} );

	it( 'a node the shell made still counts after the shell is replaced', () => {
		let shell = makeShell();
		const nodes = [ { id: 'my-tee' } ];
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( shell, { nodes } ),
		} );
		act( () => shell.dispatch( commandMsg( 'make_node', 'Tee my-tee' ) ) );
		// A rebuild swaps the shell and clears dirty; the node outlives it.
		shell = makeShell();
		rerender( opts( shell, { nodes } ) );
		expect( result.current.structureDirty ).toBe( false );
		expect( result.current.canResetGraph ).toBe( true );
	} );

	it( 'a user node only counts at the local scope', () => {
		const { result } = renderHook( () =>
			useGraphReset(
				opts( makeShell(), {
					nodes: [ { id: 'my-tee' } ],
					isLocalScope: false,
				} )
			)
		);
		expect( result.current.canResetGraph ).toBe( false );
	} );

	it( 'clears structureDirty when the shell is replaced (a graph rebuild)', () => {
		let shell = makeShell();
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( shell ),
		} );
		act( () => shell.dispatch( commandMsg( 'connect_node', 'a b' ) ) );
		expect( result.current.structureDirty ).toBe( true );
		// A fresh Shell each rebuild is canonical, so dirty must clear.
		shell = makeShell();
		rerender( opts( shell ) );
		expect( result.current.structureDirty ).toBe( false );
	} );

	it( 'canResetGraph is true only when dirty AND local AND can rebuild', () => {
		const shell = makeShell();
		const { result, rerender } = renderHook( ( p ) => useGraphReset( p ), {
			initialProps: opts( shell ),
		} );
		act( () => shell.dispatch( commandMsg( 'connect_node', 'a b' ) ) );
		expect( result.current.canResetGraph ).toBe( true );

		rerender( opts( shell, { isLocalScope: false } ) );
		expect( result.current.canResetGraph ).toBe( false );

		rerender( opts( shell, { canRebuild: false } ) );
		expect( result.current.canResetGraph ).toBe( false );
	} );

	it( 'resetGraph removes every node, bumps generation, clears dirty, marks layout dirty', () => {
		const shell = makeShell();
		let marked = 0;
		const { result } = renderHook( () =>
			useGraphReset( opts( shell, { markDirty: () => ( marked += 1 ) } ) )
		);
		// Two real-ish nodes whose removeNode unregisters them from Core.
		for ( const name of [ 'a', 'b' ] ) {
			Core.registerNode( name, {
				name,
				removeNode: () => Core.unregisterNode( name ),
			} );
		}
		act( () => shell.dispatch( commandMsg( 'make_node', 'Tee a' ) ) );
		const genBefore = Core.graphGeneration;
		const markedBefore = marked;

		act( () => result.current.resetGraph() );

		expect( Core.nodes.size ).toBe( 0 );
		expect( Core.graphGeneration ).toBe( genBefore + 1 );
		expect( result.current.structureDirty ).toBe( false );
		expect( marked ).toBe( markedBefore + 1 );
	} );
} );
