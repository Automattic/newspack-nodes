import { renderHook, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { Node } from '../../runtime/node';
import { DumperNode } from '../../runtime/dumper-node';
import { Shell } from '../../topology-console/nodes/shell';
import names from '../../runtime/reserved-node-names.json';
import { useDebugGraph } from '../useDebugGraph';

// Mount the `_output` Dumper so transcript echoes are observable, mirroring the
// real overlay where useDebugRepl owns it. Returns the live transcript array.
function mountOutput() {
	const dumper = new DumperNode();
	dumper.setName( names.OUTPUT );
	dumper.sink = Core.node( names.COMMAND_INTERPRETER );
	return dumper;
}

// The `sent` echo entries the transcript should carry (the command lines).
function sentLines( dumper ) {
	return dumper._transcript
		.filter( ( e ) => 'sent' === e.kind )
		.map( ( e ) => e.text );
}

describe( 'useDebugGraph', () => {
	beforeEach( () => {
		Core.reset();
		jest.useFakeTimers();
	} );
	afterEach( () => jest.useRealTimers() );

	it( 'falls back to coreToGraph when NO metadata is published but Core holds nodes', () => {
		// Instant local paint: before the first dump_metadata poll publishes,
		// the canvas reads the in-process graph straight off Core via
		// coreToGraph(). With a live node in Core (and no metadata), graph comes
		// from coreToGraph and ready is true synchronously.
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const { result } = renderHook( () => useDebugGraph() );
		expect( result.current.ready ).toBe( true );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			'a'
		);
		teardown();
	} );

	it( 'reports ready=false with an empty graph when Core is empty and no _metadata', () => {
		// Bare exospine: _router/_command_interpreter are SCAFFOLDING-hidden, so
		// coreToGraph() is empty and no metadata is published — ready=false.
		const { teardown } = mountExospine();
		const { result } = renderHook( () => useDebugGraph() );
		expect( result.current.ready ).toBe( false );
		expect( result.current.graph ).toEqual( { nodes: [], edges: [] } );
		teardown();
	} );

	it( 'published metadata-with-nodes takes precedence over the coreToGraph fallback, and flips ready true', () => {
		// Core holds a live node `a` (coreToGraph would show it). Once _metadata
		// publishes a graph with ≥1 node, the metadata source wins and ready=true.
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const { MetadataNode } = require( '../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.setName( names.METADATA );
		const { result } = renderHook( () => useDebugGraph() );
		act( () => {
			metadata.setState( 'metadata', {
				nodes: [ { id: 'fromMeta' } ],
				edges: [],
			} );
		} );
		expect( result.current.ready ).toBe( true );
		const ids = result.current.graph.nodes.map( ( n ) => n.id );
		expect( ids ).toContain( 'fromMeta' );
		expect( ids ).not.toContain( 'a' );
		teardown();
	} );

	it( 'consumes _metadata.setState(metadata) when published', () => {
		// With Metadata mounted, the hook reads the parsed graph from
		// useNodeState(_metadata, 'metadata').
		const { teardown } = mountExospine();
		const { MetadataNode } = require( '../../runtime/metadata-node' );
		const metadata = new MetadataNode();
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

	it( 'an empty metadata graph (no nodes) falls back to coreToGraph', () => {
		// An empty metadata graph (nodes:[]) is treated as "not yet populated":
		// the hook falls back to coreToGraph() rather than blanking the canvas.
		// Here Core holds the mounted _metadata node, so coreToGraph is non-empty
		// and ready stays true.
		const { teardown } = mountExospine();
		const { MetadataNode } = require( '../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.setName( names.METADATA );
		const { result } = renderHook( () => useDebugGraph() );
		act( () => {
			metadata.setState( 'metadata', { nodes: [], edges: [] } );
		} );
		expect( result.current.ready ).toBe( true );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			names.METADATA
		);
		teardown();
	} );

	it( 'onConnect dispatches connect_node into the local interpreter', () => {
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

	it( 'onDropNode + commitDrop end-to-end: SchematicCanvas {shellName,x,y} envelope → modal → make_node', () => {
		// SchematicCanvas.handleDrop calls onDropNode({shellName, x, y}) — a
		// single OBJECT, not (shellName, pos). The hook stages pendingDrop;
		// commitDrop dispatches once the modal confirms. Earlier the positional
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
		// Modal stages first.
		expect( result.current.pendingDrop ).not.toBeNull();
		act( () =>
			result.current.commitDrop( {
				name: result.current.pendingDrop.defaultName,
				args: '',
			} )
		);
		// Make_node creates a node whose id starts with 'tee'.
		const live = [ ...Core.nodes.keys() ];
		expect( live.some( ( n ) => n.startsWith( 'tee' ) ) ).toBe( true );
		teardown();
	} );

	it( 'commitDrop records the drop position via onPositionChange (snapped to grid)', () => {
		// Without this, a freshly-dropped node renders at autoLayout's choice
		// (e.g. column 0, row 0 of the depth grid), not where the user dropped
		// it. The console records the drop position via handlePositionChange
		// after sendLine('make_node …'); the overlay does the same via the
		// onPositionChange callback the consumer passes in.
		const { teardown } = mountExospine();
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const calls = [];
		const onPositionChange = ( id, pos ) => calls.push( { id, pos } );
		const { result } = renderHook( () =>
			useDebugGraph( true, shell, [], onPositionChange )
		);
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Tee',
				// (398, 232) is the second-column second-row node's center
				// (col=2: X_PAD+X_STEP+NODE_W/2 = 60+240+98; row=2:
				// Y_PAD+Y_STEP+NODE_H/2 = 80+110+42). The snap returns the
				// top-left = (X_PAD+X_STEP, Y_PAD+Y_STEP) = (300, 190).
				x: 398,
				y: 232,
			} )
		);
		act( () =>
			result.current.commitDrop( {
				name: result.current.pendingDrop.defaultName,
				args: '',
			} )
		);
		expect( calls ).toHaveLength( 1 );
		expect( calls[ 0 ].id ).toMatch( /^tee/ );
		expect( calls[ 0 ].pos.x ).toBe( 60 + 240 ); // X_PAD + X_STEP
		expect( calls[ 0 ].pos.y ).toBe( 80 + 110 ); // Y_PAD + Y_STEP
		teardown();
	} );

	it( 'commitDrop is silent on position when no onPositionChange is provided', () => {
		// Back-compat: passing no onPositionChange (e.g., from tests that
		// don't care about layout) MUST NOT crash; make_node still fires.
		const { teardown } = mountExospine();
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( () => useDebugGraph( true, shell ) );
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Tee',
				x: 100,
				y: 100,
			} )
		);
		expect( () =>
			act( () =>
				result.current.commitDrop( {
					name: result.current.pendingDrop.defaultName,
					args: '',
				} )
			)
		).not.toThrow();
		teardown();
	} );

	it( 'invoke keys on catalog is_interpreter (interpreter → nodeId)', () => {
		// New contract: the Inspector consults the catalog's per-class
		// is_interpreter flag (NOT a Core.node(`:config`) presence check —
		// in remote scope the browser's Core never holds server-side
		// `:config` siblings, so the old check always fell back to nodeId
		// and misrouted verbs on non-interpreter PHP nodes).
		const { teardown } = mountExospine();
		const { MetadataNode } = require( '../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.setName( names.METADATA );
		const interpreter = new Node();
		interpreter.setName( 'my-interpreter' );
		const fillSpy = jest.spyOn( interpreter, 'fill' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const classes = [ { shell_name: 'Node', is_interpreter: true } ];
		const { result } = renderHook( () =>
			useDebugGraph( true, shell, classes )
		);
		// The graph comes only from _metadata now (no coreToGraph fallback);
		// publish my-interpreter so the invoke logic can resolve its class.
		act( () => {
			metadata.setState( 'metadata', {
				nodes: [ { id: 'my-interpreter', class: 'Node' } ],
				edges: [],
			} );
		} );
		act( () =>
			result.current.handlers.onInspectorAction(
				'invoke',
				'my-interpreter',
				{
					verb: 'help',
					positional: '',
				}
			)
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

	it( 'onRemoveNode dispatches remove_node with the node id', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const { result } = renderHook( () => useDebugGraph( true, shell ) );
		act( () => result.current.handlers.onRemoveNode( 'a' ) );
		expect( spy ).toHaveBeenCalledWith( '', 'remove_node', 'a' );
		// Side-effect of remove_node verb: node leaves Core.
		expect( Core.node( 'a' ) ).toBeNull();
		teardown();
	} );

	it( 'onInspectorAction `dump` dispatches dump_node for the target id', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const { result } = renderHook( () => useDebugGraph( true, shell ) );
		act( () =>
			result.current.handlers.onInspectorAction( 'dump', 'a', null )
		);
		expect( spy ).toHaveBeenCalledWith( '', 'dump_node', 'a' );
		teardown();
	} );

	it( 'onInspectorAction `send` dispatches send_node with id + payload', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const { result } = renderHook( () => useDebugGraph( true, shell ) );
		act( () =>
			result.current.handlers.onInspectorAction( 'send', 'a', 'hello' )
		);
		expect( spy ).toHaveBeenCalledWith( '', 'send_node', 'a hello' );
		teardown();
	} );

	it( 'onInspectorAction `trace` defaults level to 1 when payload is not numeric', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.setName( 'a' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const { result } = renderHook( () => useDebugGraph( true, shell ) );
		// Non-numeric payload triggers the `level = 1` default branch.
		act( () =>
			result.current.handlers.onInspectorAction( 'trace', 'a', undefined )
		);
		expect( spy ).toHaveBeenCalledWith( '', 'debug_state', 'a 1' );
		teardown();
	} );

	it( 'onDropNode on a class that DECLARES arguments stages pendingDrop instead of dispatching', () => {
		const { teardown } = mountExospine();
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const classes = [
			{
				shell_name: 'Partition',
				arguments: [
					{ name: 'topic', required: true },
					{ name: 'segment_size', default: '4096' },
				],
			},
		];
		const { result } = renderHook( () =>
			useDebugGraph( true, shell, classes )
		);
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Partition',
				x: 12,
				y: 34,
			} )
		);
		// No make_node yet — modal first.
		expect(
			spy.mock.calls.filter( ( c ) => c[ 1 ] === 'make_node' )
		).toHaveLength( 0 );
		// pendingDrop carries everything the modal needs.
		expect( result.current.pendingDrop ).toEqual(
			expect.objectContaining( {
				shellName: 'Partition',
				defaultName: expect.stringMatching( /^partition\d*$/ ),
				argSchema: classes[ 0 ].arguments,
				x: 12,
				y: 34,
			} )
		);
		teardown();
	} );

	it( 'commitDrop dispatches make_node with the modal-provided name + args and records the drop position', () => {
		const { teardown } = mountExospine();
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const classes = [
			{
				shell_name: 'Partition',
				arguments: [ { name: 'topic', required: true } ],
			},
		];
		const positionCalls = [];
		const onPositionChange = ( id, pos ) =>
			positionCalls.push( { id, pos } );
		const { result } = renderHook( () =>
			useDebugGraph( true, shell, classes, onPositionChange )
		);
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Partition',
				x: 60 + 196 / 2,
				y: 80 + 84 / 2,
			} )
		);
		act( () =>
			result.current.commitDrop( {
				name: 'mypart',
				args: 'mytopic 8192',
			} )
		);
		const calls = spy.mock.calls.filter( ( c ) => c[ 1 ] === 'make_node' );
		expect( calls ).toHaveLength( 1 );
		expect( calls[ 0 ][ 2 ] ).toBe( 'Partition mypart mytopic 8192' );
		// Position recorded under the user-chosen name (not the default).
		expect( positionCalls ).toEqual( [
			{ id: 'mypart', pos: { x: 60, y: 80 } },
		] );
		expect( result.current.pendingDrop ).toBeNull();
		teardown();
	} );

	it( 'commitDrop with empty-trimmed args omits the trailing arg portion', () => {
		const { teardown } = mountExospine();
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const classes = [
			{
				shell_name: 'Partition',
				arguments: [ { name: 'topic' } ],
			},
		];
		const { result } = renderHook( () =>
			useDebugGraph( true, shell, classes )
		);
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Partition',
				x: 0,
				y: 0,
			} )
		);
		act( () => result.current.commitDrop( { name: 'p1', args: '   ' } ) );
		const calls = spy.mock.calls.filter( ( c ) => c[ 1 ] === 'make_node' );
		expect( calls ).toHaveLength( 1 );
		expect( calls[ 0 ][ 2 ] ).toBe( 'Partition p1' );
		teardown();
	} );

	it( 'cancelDrop clears pendingDrop and never dispatches make_node', () => {
		const { teardown } = mountExospine();
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const classes = [
			{
				shell_name: 'Partition',
				arguments: [ { name: 'topic', required: true } ],
			},
		];
		const { result } = renderHook( () =>
			useDebugGraph( true, shell, classes )
		);
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Partition',
				x: 0,
				y: 0,
			} )
		);
		expect( result.current.pendingDrop ).not.toBeNull();
		act( () => result.current.cancelDrop() );
		expect( result.current.pendingDrop ).toBeNull();
		const calls = spy.mock.calls.filter( ( c ) => c[ 1 ] === 'make_node' );
		expect( calls ).toHaveLength( 0 );
		teardown();
	} );

	it( 'onDropNode on an args-LESS class still stages pendingDrop (name modal always shows in live mode)', () => {
		// Even classes with no positional args get the NewNodeModal so the
		// user can override the auto-generated name on the way in. The modal
		// just shows the empty args row with no placeholder.
		const { teardown } = mountExospine();
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const classes = [ { shell_name: 'Tee', arguments: [] } ];
		const { result } = renderHook( () =>
			useDebugGraph( true, shell, classes )
		);
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Tee',
				x: 0,
				y: 0,
			} )
		);
		// No make_node yet — modal first.
		expect(
			spy.mock.calls.filter( ( c ) => c[ 1 ] === 'make_node' )
		).toHaveLength( 0 );
		expect( result.current.pendingDrop ).toEqual(
			expect.objectContaining( {
				shellName: 'Tee',
				defaultName: expect.stringMatching( /^tee\d*$/ ),
				argSchema: [],
			} )
		);
		teardown();
	} );

	it( 'onInspectorAction echoes the equivalent commandline into the transcript (parity with the console)', () => {
		// The reported bug: clicking an Inspector command dispatched the verb but
		// never echoed the commandline, so only the reply showed up — unlike a
		// typed REPL line (useDebugRepl appends `kind: 'sent'`) and unlike
		// TopologyConsole.handleInspectorAction (appendTranscript `kind: 'sent'`).
		const { teardown } = mountExospine();
		const dumper = mountOutput();
		const a = new Node();
		a.setName( 'a' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( () => useDebugGraph( true, shell ) );

		act( () =>
			result.current.handlers.onInspectorAction( 'dump', 'a', null )
		);
		expect( sentLines( dumper ) ).toContain( 'dump_node a' );

		act( () =>
			result.current.handlers.onInspectorAction( 'tail', 'a', null )
		);
		expect( sentLines( dumper ) ).toContain( 'connect_node a' );

		act( () =>
			result.current.handlers.onInspectorAction( 'disconnect', 'a', null )
		);
		expect( sentLines( dumper ) ).toContain( 'disconnect_node a' );

		act( () =>
			result.current.handlers.onInspectorAction( 'send', 'a', 'hello' )
		);
		expect( sentLines( dumper ) ).toContain( 'send_node a hello' );

		act( () =>
			result.current.handlers.onInspectorAction( 'trace', 'a', 1 )
		);
		expect( sentLines( dumper ) ).toContain( 'debug_state a 1' );
		teardown();
	} );

	it( 'onInspectorAction invoke echoes command_node with the resolved target', () => {
		const { teardown } = mountExospine();
		const dumper = mountOutput();
		const node = new Node();
		node.setName( 'my-node' );
		const config = new Node();
		config.setName( 'my-node:config' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
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
		// Non-interpreter class ⇒ targets the `:config` sibling; the echo mirrors
		// the console's `command_node <target> <verb> <args>`.
		expect( sentLines( dumper ) ).toContain(
			'command_node my-node:config configure foo bar'
		);
		teardown();
	} );

	it( 'onConnect / onRemoveNode echo the equivalent commandline into the transcript', () => {
		const { teardown } = mountExospine();
		const dumper = mountOutput();
		const a = new Node();
		a.setName( 'a' );
		const b = new Node();
		b.setName( 'b' );
		const shell = new Shell();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( () => useDebugGraph( true, shell ) );
		act( () => result.current.handlers.onConnect( 'a', 'b' ) );
		expect( sentLines( dumper ) ).toContain( 'connect_node a b' );
		act( () => result.current.handlers.onRemoveNode( 'a' ) );
		expect( sentLines( dumper ) ).toContain( 'remove_node a' );
		teardown();
	} );

	it( 'commitDrop echoes make_node into the transcript', () => {
		const { teardown } = mountExospine();
		const dumper = mountOutput();
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
		const dropName = result.current.pendingDrop.defaultName;
		act( () => result.current.commitDrop( { name: dropName, args: '' } ) );
		expect( sentLines( dumper ) ).toContain(
			`make_node Tee ${ dropName }`
		);
		teardown();
	} );

	it( 'dispatches via the passed-in Shell.sendCommand (not via dispatchLocal)', () => {
		// Task 3: useDebugGraph accepts a Shell as its second argument and
		// routes every gesture through shell.sendCommand(path, name, args).
		// Spying on the shell proves the new wiring; the side-effect on
		// Core.node('a').target proves the dispatch still reaches the interpreter.
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
