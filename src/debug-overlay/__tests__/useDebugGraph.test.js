import { renderHook, act } from '@testing-library/react';
import { Core } from '../../runtime/core';
import { mountExospine } from '../../runtime/exospine';
import { Node } from '../../runtime/node';
import { DumperNode } from '../../runtime/dumper-node';
import { ShellNode } from '../../runtime/shell-node';
import names from '../../runtime/reserved-node-names.json';
import {
	TYPE,
	TO,
	FROM,
	LOCAL,
	VALUE,
	TM_PING,
	TM_BYTESTREAM,
	TM_RESPONSE,
	TM_ERROR,
	newMessage,
} from '../../runtime/message';
import { useDebugGraph } from '../useDebugGraph';
import { useDebugRepl } from '../useDebugRepl';
import { markLocal } from '../../runtime/command-auth';

// Mount _output Dumper so transcript echoes are observable in tests.
function mountOutput() {
	const dumper = new DumperNode();
	dumper.name = names.OUTPUT;
	dumper.sink = Core.node( names.COMMAND_INTERPRETER );
	return dumper;
}

// The `sent` echo entries the transcript should carry (the command lines).
function sentLines( dumper ) {
	return dumper._transcript
		.filter( ( e ) => 'sent' === e.kind )
		.map( ( e ) => e.text );
}

// InspectorTab composes these two: useDebugRepl owns the ONE dispatch path,
// useDebugGraph's handlers hand it command lines. Wiring them the same way
// here keeps these tests over the real path.
function withRepl( shell, classes = [], onPositionChange = null ) {
	return () => {
		const { sendLine } = useDebugRepl( true, shell );
		return useDebugGraph(
			true,
			shell,
			classes,
			onPositionChange,
			sendLine
		);
	};
}

describe( 'useDebugGraph', () => {
	beforeEach( () => {
		Core.reset();
		jest.useFakeTimers();
	} );
	afterEach( () => jest.useRealTimers() );

	it( 'falls back to coreToGraph when NO metadata is published but Core holds nodes', () => {
		// Before metadata publishes, canvas paints from Core (coreToGraph).
		const { teardown } = mountExospine();
		const a = new Node();
		a.name = 'a';
		const { result } = renderHook( () => useDebugGraph() );
		expect( result.current.ready ).toBe( true );
		expect( result.current.graph.nodes.map( ( n ) => n.id ) ).toContain(
			'a'
		);
		teardown();
	} );

	it( 'reports ready=false with an empty graph when Core is empty and no _metadata', () => {
		// Bare exospine: backbone hidden, no metadata → ready=false.
		const { teardown } = mountExospine();
		const { result } = renderHook( () => useDebugGraph() );
		expect( result.current.ready ).toBe( false );
		// Backbone fixtures excluded from readiness; pwd is _output.
		expect(
			result.current.graph.nodes.map( ( n ) => n.id ).sort()
		).toEqual( [ '_heartbeat', '_http', '_shell' ] );
		// The backbone's two permanent edges: the heartbeat's poke, and
		// _http's target for unaddressed reply-leg output.
		expect( result.current.graph.edges ).toEqual( [
			{ from: '_http', to: '_output' },
			{ from: '_heartbeat', to: '_http' },
		] );
		expect( result.current.graph.pwd ).toBe( '_output' );
		teardown();
	} );

	it( 'published metadata-with-nodes takes precedence over the coreToGraph fallback, and flips ready true', () => {
		// _metadata with ≥1 node wins over coreToGraph; ready=true.
		const { teardown } = mountExospine();
		const a = new Node();
		a.name = 'a';
		const { MetadataNode } = require( '../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.name = names.METADATA;
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
		// With Metadata mounted, the hook reads it from useNodeState.
		const { teardown } = mountExospine();
		const { MetadataNode } = require( '../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.name = names.METADATA;
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
		// Empty metadata graph → fall back to coreToGraph, not blank canvas.
		const { teardown } = mountExospine();
		const { MetadataNode } = require( '../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.name = names.METADATA;
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
		a.name = 'a';
		const b = new Node();
		b.name = 'b';
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( withRepl( shell ) );
		act( () => result.current.handlers.onConnect( 'a', 'b' ) );
		// connect_node sets src.target (command_interpreter _cmdConnect).
		expect( Core.node( 'a' ).target ).toBe( 'b' );
		teardown();
	} );

	it( 'onInspectorAction handles tail / disconnect / trace (parity with the console)', () => {
		// Routes 5 non-invoke actions like console; overlay used to drop them.
		const { teardown } = mountExospine();
		const a = new Node();
		a.name = 'a';
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( withRepl( shell ) );
		// tail = connect_node with no target → defaults to FROM (_output).
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

	it( 'onInspectorAction command "ping" parses to a TM_PING (not a no-such-verb command)', () => {
		const { teardown } = mountExospine();
		// The ping button must produce TM_PING, not a TM_COMMAND name=ping.
		const captured = [];
		const shell = new ShellNode();
		const { result } = renderHook( withRepl( shell ) );
		// useDebugRepl binds shell.sink to the `_shell` Tap; capture there.
		Core.node( names.CONSOLE_TAP ).fill = ( m ) => captured.push( m );
		act( () =>
			result.current.handlers.onInspectorAction( 'command', null, 'ping' )
		);
		expect( captured ).toHaveLength( 1 );
		expect( captured[ 0 ][ TYPE ] & TM_PING ).toBeTruthy();
		teardown();
	} );

	it( 'onDropNode + commitDrop end-to-end: SchematicCanvas {shellName,x,y} envelope → modal → make_node', () => {
		// onDropNode takes one {shellName,x,y} object, not positional args.
		const { teardown } = mountExospine();
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( withRepl( shell ) );
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
		// Without this the node renders at autoLayout's spot, not the drop.
		const { teardown } = mountExospine();
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const calls = [];
		const onPositionChange = ( id, pos ) => calls.push( { id, pos } );
		const { result } = renderHook( () =>
			useDebugGraph( true, shell, [], onPositionChange )
		);
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Tee',
				// (398,232) = col2/row2 center; snap → top-left (300,190).
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
		// Back-compat: no onPositionChange must not crash; make_node fires.
		const { teardown } = mountExospine();
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( withRepl( shell ) );
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
		// Inspector reads catalog is_interpreter, not Core.node(:config).
		const { teardown } = mountExospine();
		mountOutput(); // `_output` mints the invoke commands
		const { MetadataNode } = require( '../../runtime/metadata-node' );
		const metadata = new MetadataNode();
		metadata.name = names.METADATA;
		const interpreter = new Node();
		interpreter.name = 'my-interpreter';
		const fillSpy = jest
			.spyOn( interpreter, 'fill' )
			.mockImplementation( () => {} );
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const classes = [ { shell_name: 'Node', is_interpreter: true } ];
		const { result } = renderHook( withRepl( shell, classes ) );
		// Publish my-interpreter so invoke resolves its class.
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
		mountOutput(); // `_output` mints the invoke commands
		const node = new Node();
		node.name = 'my-node';
		const config = new Node();
		config.name = 'my-node:config';
		const nodeFillSpy = jest
			.spyOn( node, 'fill' )
			.mockImplementation( () => {} );
		const configFillSpy = jest
			.spyOn( config, 'fill' )
			.mockImplementation( () => {} );
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		// No catalog entry (or is_interpreter:false) ⇒ target :config sibling.
		const classes = [ { shell_name: 'Node', is_interpreter: false } ];
		const { result } = renderHook( withRepl( shell, classes ) );
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
		a.name = 'a';
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( withRepl( shell ) );
		act( () => result.current.handlers.onRemoveNode( 'a' ) );
		// Side-effect of remove_node verb: node leaves Core.
		expect( Core.node( 'a' ) ).toBeNull();
		teardown();
	} );

	it( 'onInspectorAction `dump` dispatches dump_node for the target id', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.name = 'a';
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		// Every parsed message routes through shell.dispatch — spy there.
		const spy = jest.spyOn( shell, 'dispatch' );
		const { result } = renderHook( withRepl( shell ) );
		act( () =>
			result.current.handlers.onInspectorAction( 'dump', 'a', null )
		);
		expect( spy ).toHaveBeenCalledTimes( 1 );
		expect( spy.mock.calls[ 0 ][ 0 ][ VALUE ] ).toMatchObject( {
			name: 'dump_node',
			arguments: [ 'a' ],
		} );
		teardown();
	} );

	it( 'onInspectorAction `send` dispatches a TM_BYTESTREAM payload to the node (send_node)', () => {
		const { teardown } = mountExospine();
		// send_node parses to a TM_BYTESTREAM to the node, not a TM_COMMAND.
		const captured = [];
		const shell = new ShellNode();
		const { result } = renderHook( withRepl( shell ) );
		// useDebugRepl binds shell.sink to the `_shell` Tap; capture there.
		Core.node( names.CONSOLE_TAP ).fill = ( m ) => captured.push( m );
		act( () =>
			result.current.handlers.onInspectorAction( 'send', 'a', 'hello' )
		);
		expect( captured ).toHaveLength( 1 );
		expect( captured[ 0 ][ TYPE ] & TM_BYTESTREAM ).toBeTruthy();
		expect( captured[ 0 ][ TO ] ).toBe( 'a' );
		// send_node is line-oriented — value carries a trailing \n.
		expect( captured[ 0 ][ VALUE ] ).toBe( 'hello\n' );
		teardown();
	} );

	it( 'onInspectorAction `cmd` with reply-flags ORs TM_RESPONSE / TM_ERROR onto the dispatched TYPE (Compose modal)', () => {
		const { teardown } = mountExospine();
		const captured = [];
		const shell = new ShellNode();
		const { result } = renderHook( withRepl( shell ) );
		// useDebugRepl binds shell.sink to the `_shell` Tap; capture there.
		Core.node( names.CONSOLE_TAP ).fill = ( m ) => captured.push( m );
		act( () =>
			result.current.handlers.onInspectorAction( 'cmd', 'a', 'hi', {
				response: true,
				error: true,
			} )
		);
		expect( captured ).toHaveLength( 1 );
		expect( captured[ 0 ][ TYPE ] & TM_RESPONSE ).toBeTruthy();
		expect( captured[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
		teardown();
	} );

	it( 'onInspectorAction `cmd` with no flags leaves TYPE unmodified (no accidental TM_RESPONSE/TM_ERROR)', () => {
		const { teardown } = mountExospine();
		const captured = [];
		const shell = new ShellNode();
		const { result } = renderHook( withRepl( shell ) );
		// useDebugRepl binds shell.sink to the `_shell` Tap; capture there.
		Core.node( names.CONSOLE_TAP ).fill = ( m ) => captured.push( m );
		act( () =>
			result.current.handlers.onInspectorAction( 'cmd', 'a', 'hi' )
		);
		expect( captured ).toHaveLength( 1 );
		expect( captured[ 0 ][ TYPE ] & TM_RESPONSE ).toBeFalsy();
		expect( captured[ 0 ][ TYPE ] & TM_ERROR ).toBeFalsy();
		teardown();
	} );

	it( 'onInspectorAction `trace` defaults level to 1 when payload is not numeric', () => {
		const { teardown } = mountExospine();
		const a = new Node();
		a.name = 'a';
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'dispatch' );
		const { result } = renderHook( withRepl( shell ) );
		// Non-numeric payload triggers the `level = 1` default branch.
		act( () =>
			result.current.handlers.onInspectorAction( 'trace', 'a', undefined )
		);
		expect( spy ).toHaveBeenCalledTimes( 1 );
		expect( spy.mock.calls[ 0 ][ 0 ][ VALUE ] ).toMatchObject( {
			name: 'trace',
			arguments: [ 'a', '1' ],
		} );
		teardown();
	} );

	it( 'onDropNode on a class that DECLARES arguments stages pendingDrop instead of dispatching', () => {
		const { teardown } = mountExospine();
		const shell = new ShellNode();
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
		const { result } = renderHook( withRepl( shell, classes ) );
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
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		// A real browser class (Tee) so make_node actually constructs a node.
		const classes = [
			{
				shell_name: 'Tee',
				arguments: [ { name: 'topic', required: true } ],
			},
		];
		const positionCalls = [];
		const onPositionChange = ( id, pos ) =>
			positionCalls.push( { id, pos } );
		const { result } = renderHook(
			withRepl( shell, classes, onPositionChange )
		);
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Tee',
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
		// make_node side-effect: node exists in Core with modal-provided args.
		expect( Core.node( 'mypart' ) ).not.toBeNull();
		expect( Core.node( 'mypart' ).arguments ).toEqual( [
			'mytopic',
			'8192',
		] );
		// Position recorded under the user-chosen name (not the default).
		expect( positionCalls ).toEqual( [
			{ id: 'mypart', pos: { x: 60, y: 80 } },
		] );
		expect( result.current.pendingDrop ).toBeNull();
		teardown();
	} );

	it( 'commitDrop with empty-trimmed args omits the trailing arg portion', () => {
		const { teardown } = mountExospine();
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const classes = [
			{
				shell_name: 'Tee',
				arguments: [ { name: 'topic' } ],
			},
		];
		const { result } = renderHook( withRepl( shell, classes ) );
		act( () =>
			result.current.handlers.onDropNode( {
				shellName: 'Tee',
				x: 0,
				y: 0,
			} )
		);
		act( () => result.current.commitDrop( { name: 'p1', args: '   ' } ) );
		// Node is created with EMPTY args — whitespace-only args were trimmed.
		expect( Core.node( 'p1' ) ).not.toBeNull();
		expect( Core.node( 'p1' ).arguments ).toEqual( [] );
		teardown();
	} );

	it( 'cancelDrop clears pendingDrop and never dispatches make_node', () => {
		const { teardown } = mountExospine();
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const classes = [
			{
				shell_name: 'Partition',
				arguments: [ { name: 'topic', required: true } ],
			},
		];
		const { result } = renderHook( withRepl( shell, classes ) );
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
		// Args-less classes still get NewNodeModal to override the auto name.
		const { teardown } = mountExospine();
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'sendCommand' );
		const classes = [ { shell_name: 'Tee', arguments: [] } ];
		const { result } = renderHook( withRepl( shell, classes ) );
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
		// Bug: Inspector command dispatched the verb but never echoed it.
		const { teardown } = mountExospine();
		const dumper = mountOutput();
		const a = new Node();
		a.name = 'a';
		// give `a` a sink so the send dispatch doesn't throw.
		a.sink = { fill: () => {} };
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( withRepl( shell ) );

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
		expect( sentLines( dumper ) ).toContain( 'trace a 1' );
		teardown();
	} );

	it( 'onInspectorAction invoke echoes command_node with the resolved target', () => {
		const { teardown } = mountExospine();
		const dumper = mountOutput();
		const node = new Node();
		node.name = 'my-node';
		node.sink = { fill: () => {} };
		const config = new Node();
		config.name = 'my-node:config';
		config.sink = { fill: () => {} };
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const classes = [ { shell_name: 'Node', is_interpreter: false } ];
		const { result } = renderHook( withRepl( shell, classes ) );
		act( () =>
			result.current.handlers.onInspectorAction( 'invoke', 'my-node', {
				verb: 'configure',
				positional: 'foo bar',
			} )
		);
		// Non-interpreter class ⇒ targets :config; echoes command_node.
		expect( sentLines( dumper ) ).toContain(
			'command_node my-node:config configure foo bar'
		);
		teardown();
	} );

	it( 'onConnect / onRemoveNode echo the equivalent commandline into the transcript', () => {
		const { teardown } = mountExospine();
		const dumper = mountOutput();
		const a = new Node();
		a.name = 'a';
		const b = new Node();
		b.name = 'b';
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( withRepl( shell ) );
		act( () => result.current.handlers.onConnect( 'a', 'b' ) );
		expect( sentLines( dumper ) ).toContain( 'connect_node a b' );
		act( () => result.current.handlers.onRemoveNode( 'a' ) );
		expect( sentLines( dumper ) ).toContain( 'remove_node a' );
		teardown();
	} );

	it( 'commitDrop echoes make_node into the transcript', () => {
		const { teardown } = mountExospine();
		const dumper = mountOutput();
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( withRepl( shell ) );
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

	it( 'dispatches via the passed-in Shell.dispatch (not a separate local dispatch)', () => {
		// Every gesture routes through the passed-in shell.dispatch.
		const { teardown } = mountExospine();
		const a = new Node();
		a.name = 'a';
		const b = new Node();
		b.name = 'b';
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'dispatch' );
		const { result } = renderHook( withRepl( shell ) );
		act( () => result.current.handlers.onConnect( 'a', 'b' ) );
		expect( spy ).toHaveBeenCalledTimes( 1 );
		expect( spy.mock.calls[ 0 ][ 0 ][ VALUE ] ).toMatchObject( {
			name: 'connect_node',
			arguments: [ 'a', 'b' ],
		} );
		expect( Core.node( 'a' ).target ).toBe( 'b' );
		teardown();
	} );

	it( 'invoke honors the shell cwd prefix at a non-root scope (Path-menu cd)', () => {
		// Overlay injects shell.prefix so invoke honors a non-root cwd.
		const { teardown } = mountExospine();
		mountOutput(); // `_output` mints the invoke commands
		const node = new Node();
		node.name = 'my-node';
		const config = new Node();
		config.name = 'my-node:config';
		// Capture at fill time — routing peels TO; stub sink snapshots it.
		const captured = [];
		const shell = new ShellNode();
		shell.path = '_http';
		const classes = [ { shell_name: 'Node', is_interpreter: false } ];
		const { result } = renderHook( withRepl( shell, classes ) );
		// useDebugRepl binds shell.sink to the `_shell` Tap; capture there.
		Core.node( names.CONSOLE_TAP ).fill = ( m ) =>
			captured.push( Array.isArray( m ) ? m.slice() : m );
		act( () =>
			result.current.handlers.onInspectorAction( 'invoke', 'my-node', {
				verb: 'configure',
				positional: '',
			} )
		);
		expect( captured ).toHaveLength( 1 );
		expect( captured[ 0 ][ TO ] ).toBe( '_http/my-node:config' );
		teardown();
	} );

	it( 'dispatch backfills FROM=_output, leaving the Shell-set LOCAL intact', () => {
		// A real parse() completes every branch through stampNoreply, so the
		// message arrives LOCAL-marked and signed; sendVerb only backfills FROM.
		const { teardown } = mountExospine();
		const dispatched = [];
		const shell = {
			path: '',
			hasPending: () => false,
			parse: () => markLocal( newMessage() ),
			dispatch: ( m ) => dispatched.push( m ),
			prefix: ( t ) => t,
			replyFrom: ( n ) => n,
		};
		const { result } = renderHook( withRepl( shell ) );
		act( () => result.current.handlers.onConnect( 'a', 'b' ) );
		expect( dispatched ).toHaveLength( 1 );
		expect( dispatched[ 0 ][ FROM ] ).toBe( names.OUTPUT );
		expect( dispatched[ 0 ][ LOCAL ] ).toBe( true );
		teardown();
	} );

	it( 'surfaces a parse error instead of sending the line anyway', () => {
		// The overlay's old dispatcher fell back to shell.sendCommand on a
		// non-Message parse, which sent the command and swallowed the error.
		// One path means console parity: the error reaches the transcript.
		const { teardown } = mountExospine();
		const calls = [];
		const shell = {
			path: '',
			hasPending: () => false,
			parse: () => ( { kind: 'error', text: 'nope' } ),
			sendCommand: ( path, name, args ) =>
				calls.push( { path, name, args } ),
			prefix: ( t ) => t,
			replyFrom: ( n ) => n,
		};
		const { result } = renderHook( withRepl( shell ) );
		act( () => result.current.handlers.onRemoveNode( 'a' ) );
		expect( calls ).toEqual( [] );
		expect(
			Core.node( names.OUTPUT )._transcript.some(
				( e ) => 'error' === e.kind && 'nope' === e.text
			)
		).toBe( true );
		teardown();
	} );

	it( 'commitDrop with no staged pendingDrop is a no-op (early return, no dispatch)', () => {
		// commitDrop with nothing staged early-returns, no make_node dispatch.
		const { teardown } = mountExospine();
		const shell = new ShellNode();
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const spy = jest.spyOn( shell, 'dispatch' );
		const { result } = renderHook( withRepl( shell ) );
		expect( result.current.pendingDrop ).toBeNull();
		act( () =>
			result.current.commitDrop( { name: 'whatever', args: '' } )
		);
		expect( spy ).not.toHaveBeenCalled();
		teardown();
	} );

	it( 'GUI dispatch rides the `_shell` Tap, so `connect _shell` observes it', () => {
		// useDebugRepl binds shell.sink to the Tap at build (rule #2): every
		// command the GUI mints is observable at the same point a typed one is.
		const { teardown } = mountExospine();
		const a = new Node();
		a.name = 'a';
		const b = new Node();
		b.name = 'b';
		const shell = new ShellNode();
		shell.path = '';
		shell.sink = Core.node( names.COMMAND_INTERPRETER );
		const { result } = renderHook( withRepl( shell ) );
		const tap = Core.node( names.CONSOLE_TAP );
		const before = tap.counter;
		act( () => result.current.handlers.onConnect( 'a', 'b' ) );
		expect( shell.sink ).toBe( tap );
		expect( tap.counter ).toBeGreaterThan( before );
		expect( Core.node( 'a' ).target ).toBe( 'b' );
		teardown();
	} );
} );
