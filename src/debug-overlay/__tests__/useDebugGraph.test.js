import { renderHook, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { Node } from '../../runtime/node';
import { Shell } from '../../topology-console/nodes/shell';
import names from '../../runtime/reserved-node-names.json';
import { useDebugGraph } from '../useDebugGraph';

describe( 'useDebugGraph', () => {
	beforeEach( () => {
		Core.reset();
		jest.useFakeTimers();
	} );
	afterEach( () => jest.useRealTimers() );

	it( 'falls back to coreToGraph() when _metadata has not published yet', () => {
		// Without a mounted Metadata, useNodeState returns undefined and the
		// hook falls back to a single coreToGraph() read on first render.
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const { result } = renderHook( () => useDebugGraph() );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			'a'
		);
		teardown();
	} );

	it( 'consumes _metadata.setState(metadata) when published', () => {
		// With Metadata mounted, the hook reads the parsed graph from
		// useNodeState(_metadata, 'metadata').
		const { teardown } = mountExospine();
		// eslint-disable-next-line no-unused-vars
		const { Metadata } = require( '../../runtime/metadata' );
		const metadata = new Metadata();
		metadata.setName( names.METADATA );
		const { result } = renderHook( () => useDebugGraph() );
		act( () => {
			metadata.setState( 'metadata', {
				nodes: [ { id: 'fromMeta', count: 1 } ],
				edges: [],
			} );
		} );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			'fromMeta'
		);
		teardown();
	} );

	it( 'onConnect dispatches connect_node into the local CI', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const b = new Node();
		b.setName( 'b' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( () => useDebugGraph( true, shell ) );
		act( () => result.current.handlers.onConnect( 'a', 'b' ) );
		// connect_node sets the base node's `target` string (command_interpreter
		// _cmdConnect → src.target = target). Assert the real effect.
		expect( Core.node( 'a' ).target ).toBe( 'b' );
		teardown();
	} );

	it( 'onInspectorAction handles tail / disconnect / trace (parity with the console)', () => {
		// The console's handleInspectorAction routes five non-invoke actions:
		// dump → dump_node, tail → connect_node <id> (no target = tail), disconnect
		// → disconnect_node, send → send_node, trace → debug_state. The overlay
		// previously handled only dump + invoke, silently dropping the rest.
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( () => useDebugGraph( true, shell ) );
		// tail = `connect_node a` with NO target — connect_node defaults to the
		// issuing message's FROM, which the overlay stamps as '_output' (the
		// transcript Dumper). So a.target becomes '_output' and a's emissions
		// flow into the transcript, which is the whole point of Tail.
		act( () =>
			result.current.handlers.onInspectorAction( 'tail', 'a', null )
		);
		expect( Core.node( 'a' ).target ).toBe( '_output' );
		// Set a.target so disconnect has something to clear.
		Core.node( 'a' ).target = 'somewhere';
		act( () =>
			result.current.handlers.onInspectorAction( 'disconnect', 'a', null )
		);
		// disconnect_node clears target (a string '').
		expect( Core.node( 'a' ).target ).toBe( '' );
		// trace sets debug_state; payload is the target level (0 or 1).
		act( () =>
			result.current.handlers.onInspectorAction( 'trace', 'a', 1 )
		);
		expect( Core.node( 'a' ).debugState ).toBe( 1 );
		act( () =>
			result.current.handlers.onInspectorAction( 'trace', 'a', 0 )
		);
		expect( Core.node( 'a' ).debugState ).toBe( 0 );
		teardown();
	} );

	it( 'onDropNode accepts the SchematicCanvas {shellName,x,y} envelope and dispatches make_node', () => {
		// SchematicCanvas.handleDrop calls onDropNode({shellName, x, y}) — a
		// single OBJECT, not (shellName, pos). The console's handleDropNode
		// destructures it. The overlay must too; the previous positional
		// implementation got `[object Object]` as the shellName.
		const { teardown } = mountExospine();
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( () => useDebugGraph( true, shell ) );
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Tee',
				x: 0,
				y: 0,
			} )
		);
		// Make_node creates a node whose id starts with 'tee' (generateNodeName
		// lowercases the shell name). The earlier `[object Object]` would have
		// produced a parse error and no node at all.
		const live = [ ...Core.nodes.keys() ];
		expect( live.some( ( n ) => n.startsWith( 'tee' ) ) ).toBe( true );
		teardown();
	} );

	it( 'invoke keys on catalog is_interpreter (interpreter → nodeId)', () => {
		// New contract: the Inspector consults the catalog's per-class
		// is_interpreter flag (NOT a Core.node(`:config`) presence check —
		// in remote scope the browser's Core never holds server-side
		// `:config` siblings, so the old check always fell back to nodeId
		// and misrouted verbs on non-interpreter PHP nodes).
		const { teardown } = mountExospine();
		const interpreter = new Node();
		interpreter.setName( 'my-ci' );
		const fillSpy = jest.spyOn( interpreter, 'fill' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const classes = [ { shell_name: 'Node', is_interpreter: true } ];
		const { result } = renderHook( () =>
			useDebugGraph( true, shell, classes )
		);
		act( () =>
			result.current.handlers.onInspectorAction( 'invoke', 'my-ci', {
				verb: 'help',
				positional: '',
			} )
		);
		expect( fillSpy ).toHaveBeenCalled();
		teardown();
	} );

	it( 'invoke on a non-interpreter class targets the `:config` sibling', () => {
		const { teardown } = mountExospine();
		const node = new Node();
		node.setName( 'my-node' );
		const config = new Node();
		config.setName( 'my-node:config' );
		const nodeFillSpy = jest.spyOn( node, 'fill' );
		const configFillSpy = jest.spyOn( config, 'fill' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		// No catalog entry (or is_interpreter:false) ⇒ target :config sibling.
		const classes = [ { shell_name: 'Node', is_interpreter: false } ];
		const { result } = renderHook( () =>
			useDebugGraph( true, shell, classes )
		);
		act( () =>
			result.current.handlers.onInspectorAction( 'invoke', 'my-node', {
				verb: 'configure',
				positional: 'foo bar',
			} )
		);
		expect( configFillSpy ).toHaveBeenCalled();
		expect( nodeFillSpy ).not.toHaveBeenCalled();
		teardown();
	} );

	it( 'dispatches via the passed-in Shell.sendCommand (not via dispatchLocal)', () => {
		// Task 3: useDebugGraph accepts a Shell as its second argument and
		// routes every gesture through shell.sendCommand(path, name, args).
		// Spying on the shell proves the new wiring; the side-effect on
		// Core.node('a').target proves the dispatch still reaches the CI.
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const b = new Node();
		b.setName( 'b' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const { result } = renderHook( () => useDebugGraph( true, shell ) );
		act( () => result.current.handlers.onConnect( 'a', 'b' ) );
		expect( spy ).toHaveBeenCalledWith( '', 'connect_node', 'a b' );
		expect( Core.node( 'a' ).target ).toBe( 'b' );
		teardown();
	} );
} );
