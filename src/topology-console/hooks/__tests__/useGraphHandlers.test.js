import { readFileSync } from 'fs';
import { join } from 'path';
import { renderHook } from '@testing-library/react';
import { useGraphHandlers } from '../useGraphHandlers';
import {
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	LOCAL,
	TM_BYTESTREAM,
	TM_EOF,
	TM_COMMAND,
	TM_REQUEST,
	TM_STRUCT,
	TM_ERROR,
	TM_INFO,
	TM_RESPONSE,
	TM_NOREPLY,
} from '../../../runtime/message';
import {
	ensureSession,
	forgetSession,
	signCommand,
	__setAuthFetch,
} from '../../../runtime/command-auth';
import { ShellNode, quoteToken, tokenize } from '../../../runtime/shell-node';
import names from '../../../runtime/reserved-node-names.json';
import { Core } from '../../../runtime/core';
import {
	DumperNode,
	formatMessageEnvelope,
} from '../../../runtime/dumper-node';
import { OutgoingGateNode } from '../../core/outgoingGate';

// A real Shell whose sink captures fills; replyFrom can stand in for a wrap.
function makeShell( { path = '', replyFrom } = {} ) {
	const shell = new ShellNode();
	shell.path = path;
	const sink = {
		connected: true,
		fills: [],
		fill: ( m ) => sink.fills.push( m ),
	};
	shell.sink = sink;
	if ( replyFrom ) {
		shell.replyFrom = replyFrom;
	}
	return shell;
}

// A stand-in `_command_interpreter` capturing the local replies filled into it.
function captureInterpreter() {
	const interpreter = {
		name: names.COMMAND_INTERPRETER,
		fills: [],
		fill: ( m ) => interpreter.fills.push( m ),
	};
	Core.registerNode( names.COMMAND_INTERPRETER, interpreter );
	return interpreter;
}

// `_output` mints the command_node commands (both real graphs mount one), so
// the harness registers it before rendering.
const renderHandlers = ( opts ) => {
	if ( ! Core.node( names.OUTPUT ) ) {
		const out = new DumperNode();
		out.name = names.OUTPUT;
	}
	const dispatch = jest.fn();
	const append = jest.fn();
	const onReplSend = jest.fn();
	const onDropStage = jest.fn();
	const shell = opts.shell || makeShell();
	const { result } = renderHook( () =>
		useGraphHandlers( {
			shell,
			graph: { nodes: [], edges: [] },
			catalogClasses: [],
			dispatch,
			append,
			onReplSend,
			onDropStage,
			...opts,
		} )
	);
	return { result, dispatch, append, onReplSend, onDropStage, shell };
};

describe( 'useGraphHandlers — optimistic metadata patch after a mutation', () => {
	let patched;
	let fanned;
	beforeEach( () => {
		Core.reset();
		patched = [];
		fanned = [];
		Core.registerNode( names.METADATA, {
			name: names.METADATA,
			optimisticPatch: ( name, p ) => patched.push( [ name, p ] ),
			optimisticPatchAll: ( p ) => fanned.push( p ),
		} );
	} );
	afterEach( () => Core.reset() );

	it( 'onConnect sets the FROM node target (edge appears at once)', () => {
		const { result } = renderHandlers( {} );
		result.current.onConnect( 'a', 'b' );
		expect( patched ).toEqual( [ [ 'a', { target: 'b' } ] ] );
	} );

	it( 'onConnect APPENDS to a Tee fan-out (array target) instead of replacing it', () => {
		// Optimistic patch must APPEND server-side, else Tee's edges vanish.
		Core.node( names.METADATA ).rawMap = { tee: { target: [ 'x', 'y' ] } };
		const { result } = renderHandlers( {} );
		result.current.onConnect( 'tee', 'z' );
		expect( patched ).toEqual( [
			[ 'tee', { target: [ 'x', 'y', 'z' ] } ],
		] );
	} );

	it( 'onConnect REPLACES on a plain node that declares extra targets', () => {
		// `target` is the routing value, `targets` the display union: a node
		// with extras is not a fan-out, so connect replaces and draws no
		// phantom edge to the superseded target.
		Core.node( names.METADATA ).rawMap = {
			'beacon-relay': {
				target: 'downstream-sump',
				targets: [ 'downstream-sump', 'telemetry-sidecar' ],
			},
		};
		const { result } = renderHandlers( {} );
		result.current.onConnect( 'beacon-relay', 'quarry-sump' );
		expect( patched ).toEqual( [
			[ 'beacon-relay', { target: 'quarry-sump' } ],
		] );
	} );

	it( 'onConnect does not duplicate a target already in the Tee fan-out', () => {
		Core.node( names.METADATA ).rawMap = { tee: { target: [ 'x', 'y' ] } };
		const { result } = renderHandlers( {} );
		result.current.onConnect( 'tee', 'y' );
		expect( patched ).toEqual( [ [ 'tee', { target: [ 'x', 'y' ] } ] ] );
	} );

	it( 'onRemoveNode drops the node (null patch) so it leaves the canvas', () => {
		const { result } = renderHandlers( {} );
		result.current.onRemoveNode( 'x' );
		expect( patched ).toEqual( [ [ 'x', null ] ] );
	} );

	it( 'onRemoveEdge dispatches disconnect_node and drops the target from a Tee array', () => {
		Core.node( names.METADATA ).rawMap = {
			tee: { target: [ 'x', 'y', 'z' ] },
		};
		const { result, dispatch } = renderHandlers( {} );
		result.current.onRemoveEdge( 'tee', 'y' );
		expect( dispatch ).toHaveBeenCalledWith( 'disconnect_node tee y' );
		expect( patched ).toEqual( [ [ 'tee', { target: [ 'x', 'z' ] } ] ] );
	} );

	it( 'onRemoveEdge clears a single-target (string) node to empty', () => {
		Core.node( names.METADATA ).rawMap = { n: { target: 'b' } };
		const { result, dispatch } = renderHandlers( {} );
		result.current.onRemoveEdge( 'n', 'b' );
		expect( dispatch ).toHaveBeenCalledWith( 'disconnect_node n b' );
		expect( patched ).toEqual( [ [ 'n', { target: '' } ] ] );
	} );

	it( 'onInspectorAction tail APPENDS the CANONICAL session pwd to the Tee fan-out', () => {
		// Optimistic append canonicalizes pwd `_metadata` tail to `_output`.
		Core.node( names.METADATA ).rawMap = {
			_header: {
				pwd: '_repl/_output/_sse:c0ffee09c0ffee09c0ffee09c0ffee09/_metadata',
			},
			tee: { target: [ 'request-builder', 'job-router' ] },
		};
		const { result } = renderHandlers( {} );
		result.current.onInspectorAction( 'tail', 'tee', null );
		expect( patched ).toEqual( [
			[
				'tee',
				{
					target: [
						'request-builder',
						'job-router',
						'_repl/_output/_sse:c0ffee09c0ffee09c0ffee09c0ffee09/_output',
					],
				},
			],
		] );
	} );

	it( 'onInspectorAction disconnect REMOVES only the CANONICAL session pwd from the Tee fan-out', () => {
		// Optimistic remove must canonicalize pwd tail before filtering.
		Core.node( names.METADATA ).rawMap = {
			_header: {
				pwd: '_repl/_output/_sse:c0ffee09c0ffee09c0ffee09c0ffee09/_metadata',
			},
			tee: {
				target: [
					'request-builder',
					'_repl/_output/_sse:c0ffee09c0ffee09c0ffee09c0ffee09/_output',
				],
			},
		};
		const { result } = renderHandlers( {} );
		result.current.onInspectorAction( 'disconnect', 'tee', null );
		expect( patched ).toEqual( [
			[ 'tee', { target: [ 'request-builder' ] } ],
		] );
	} );

	it( 'onInspectorAction trace patches debug_state so the Trace button flips at once', () => {
		const { result } = renderHandlers( {} );
		result.current.onInspectorAction( 'trace', 'x', 1 );
		expect( patched ).toEqual( [ [ 'x', { debug_state: 1 } ] ] );
	} );

	it( 'onInspectorAction trace on "*" dispatches trace * and patches EVERY node (no-node Trace flips at once)', () => {
		Core.node( names.METADATA ).rawMap = {
			_header: { pwd: '' },
			alice: { debug_state: 0 },
			bob: { debug_state: 0 },
		};
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'trace', '*', 1 );
		expect( dispatch ).toHaveBeenCalledWith( 'trace * 1' );
		// One fan publish (header exclusion is MetadataNode's own test).
		expect( fanned ).toEqual( [ { debug_state: 1 } ] );
		expect( patched ).toEqual( [] );
	} );

	it( 'a non-mutating inspector action (dump) does NOT patch', () => {
		const { result } = renderHandlers( {} );
		result.current.onInspectorAction( 'dump', 'x', null );
		expect( patched ).toEqual( [] );
	} );
} );

describe( 'useGraphHandlers', () => {
	it( 'onConnect dispatches a connect_node command line', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onConnect( 'a', 'b' );
		expect( dispatch ).toHaveBeenCalledWith( 'connect_node a b' );
	} );

	it( 'onRemoveNode dispatches a remove_node command line', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onRemoveNode( 'a' );
		expect( dispatch ).toHaveBeenCalledWith( 'remove_node a' );
	} );

	it( 'onInspectorAction dump dispatches dump_node', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'dump', 'a', null );
		expect( dispatch ).toHaveBeenCalledWith( 'dump_node a' );
	} );

	it( 'onInspectorAction dump_config dispatches dump_config', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'dump_config', 'a', null );
		expect( dispatch ).toHaveBeenCalledWith( 'dump_config a' );
	} );

	it( 'onInspectorAction command dispatches a raw server command with its args (no node)', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'command', null, 'trace *' );
		// Args after verb must carry through, else `trace *` is arg-less.
		expect( dispatch ).toHaveBeenCalledWith( 'trace *' );
	} );

	it( 'onInspectorAction command handles a verb with no args', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'command', null, 'dmesg' );
		expect( dispatch ).toHaveBeenCalledWith( 'dmesg' );
	} );

	it( 'onInspectorAction request dispatches request_node with the payload', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'request', 'a', 'hello' );
		expect( dispatch ).toHaveBeenCalledWith( 'request_node a hello' );
	} );

	it( 'onInspectorAction send_struct shell-quotes JSON containing spaces so the tokenizer keeps it intact [#32]', () => {
		const { result, dispatch } = renderHandlers( {} );
		const json = '{ "foo": "bar" }';
		result.current.onInspectorAction( 'send_struct', '_output', json );
		// The composed line wraps the spaced JSON in one quoted token.
		expect( dispatch.mock.calls[ 0 ][ 0 ] ).toBe(
			`send_struct _output '${ json }'`
		);
	} );

	it( 'onInspectorAction send_struct escapes JSON with every quote char so it still round-trips [#32]', () => {
		const { result, dispatch, append } = renderHandlers( {} );
		// Contains ', ` AND " — the escape-aware tokenizer makes it representable.
		result.current.onInspectorAction(
			'send_struct',
			'_output',
			'{"x":"a\'b`c"}'
		);
		expect( append ).not.toHaveBeenCalledWith(
			expect.objectContaining( { kind: 'error' } )
		);
		expect( dispatch ).toHaveBeenCalled();
	} );

	it( 'onInspectorAction send_eof dispatches send_eof', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'send_eof', 'a', '' );
		expect( dispatch ).toHaveBeenCalledWith( 'send_eof a' );
	} );

	it( 'onInspectorAction cmd dispatches a TM_COMMAND to the node with the phrase', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'cmd', 'a', 'trace 1' );
		expect( dispatch ).toHaveBeenCalledWith( 'command_node a trace 1' );
	} );

	it( 'onInspectorAction tell dispatches tell_node with the payload', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'tell', 'a', 'hi there' );
		expect( dispatch ).toHaveBeenCalledWith( 'tell_node a hi there' );
	} );

	it( 'onInspectorAction send_struct dispatches send_struct with the (quoted) JSON payload', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'send_struct', 'a', '{"k":1}' );
		// Single-quoted JSON stays one token for the tokenizer [#32].
		expect( dispatch ).toHaveBeenCalledWith( `send_struct a '{"k":1}'` );
	} );

	it( 'onInspectorAction register dispatches register <source> <target> <event>', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'register', 'src', 'tgt EVT' );
		expect( dispatch ).toHaveBeenCalledWith( 'register src tgt EVT' );
	} );

	it( 'onInspectorAction unregister dispatches unregister <source> <target> <event>', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'unregister', 'src', 'tgt EVT' );
		expect( dispatch ).toHaveBeenCalledWith( 'unregister src tgt EVT' );
	} );

	it( 'onInspectorAction tail dispatches connect_node with no target', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'tail', 'a', null );
		expect( dispatch ).toHaveBeenCalledWith( 'connect_node a' );
	} );

	it( 'onInspectorAction disconnect dispatches disconnect_node', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'disconnect', 'a', null );
		expect( dispatch ).toHaveBeenCalledWith( 'disconnect_node a' );
	} );

	it( 'onInspectorAction send dispatches send_node with id + payload', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'send', 'a', 'hello' );
		expect( dispatch ).toHaveBeenCalledWith( 'send_node a hello' );
	} );

	it( 'onInspectorAction trace uses the numeric payload as the level', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'trace', 'a', 0 );
		expect( dispatch ).toHaveBeenCalledWith( 'trace a 0' );
	} );

	it( 'onInspectorAction trace defaults the level to 1 for a non-numeric payload', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'trace', 'a', undefined );
		expect( dispatch ).toHaveBeenCalledWith( 'trace a 1' );
	} );

	it( 'onDropNode stages the NewNodeModal via onDropStage', () => {
		const { result, onDropStage } = renderHandlers( {
			catalogClasses: [
				{
					shell_name: 'Partition',
					arguments: [ { name: 'topic', required: true } ],
				},
			],
		} );
		result.current.onDropNode( { shellName: 'Partition', x: 12, y: 34 } );
		expect( onDropStage ).toHaveBeenCalledTimes( 1 );
		expect( onDropStage ).toHaveBeenCalledWith(
			expect.objectContaining( {
				shellName: 'Partition',
				defaultName: expect.stringMatching( /^partition\d*$/ ),
				argSchema: [ { name: 'topic', required: true } ],
				x: 12,
				y: 34,
			} )
		);
	} );

	it( 'onDropNode stages an empty argSchema when the class declares no args', () => {
		const { result, onDropStage } = renderHandlers( {
			catalogClasses: [ { shell_name: 'Tee', arguments: [] } ],
		} );
		result.current.onDropNode( { shellName: 'Tee', x: 0, y: 0 } );
		expect( onDropStage ).toHaveBeenCalledWith(
			expect.objectContaining( {
				shellName: 'Tee',
				defaultName: expect.stringMatching( /^tee\d*$/ ),
				argSchema: [],
			} )
		);
	} );

	it( 'invoke (no kind) on a non-interpreter class targets the :config sibling', () => {
		const shell = makeShell();
		const { result, append } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'my-node', class: 'Node' } ], edges: [] },
			catalogClasses: [ { shell_name: 'Node', is_interpreter: false } ],
		} );
		result.current.onInspectorAction( 'invoke', 'my-node', {
			verb: 'configure',
			args: [ 'foo', 'bar' ],
		} );
		expect( shell.sink.fills ).toHaveLength( 1 );
		const m = shell.sink.fills[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( 'my-node:config' );
		expect( m[ FROM ] ).toBe( names.OUTPUT );
		expect( m[ LOCAL ] ).toBe( true );
		expect( m[ VALUE ] ).toMatchObject( {
			name: 'configure',
			arguments: [ 'foo', 'bar' ],
		} );
		expect( append ).toHaveBeenCalledWith(
			expect.objectContaining( {
				kind: 'sent',
				text: 'command_node my-node:config configure foo bar',
			} )
		);
	} );

	it( 'invoke (command kind) on an interpreter class targets the bare node', () => {
		const shell = makeShell();
		const { result, append } = renderHandlers( {
			shell,
			graph: {
				nodes: [ { id: 'n1', class: 'Performance_CI' } ],
				edges: [],
			},
			catalogClasses: [
				{ shell_name: 'Performance_CI', is_interpreter: true },
			],
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'set_is_hub',
			kind: 'command',
			args: [],
		} );
		const m = shell.sink.fills[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( 'n1' );
		expect( m[ VALUE ] ).toMatchObject( {
			name: 'set_is_hub',
			arguments: [],
		} );
		expect( append ).toHaveBeenCalledWith(
			expect.objectContaining( {
				kind: 'sent',
				text: 'command_node n1 set_is_hub',
			} )
		);
	} );

	it( 'invoke (request kind) routes a TM_REQUEST string to the bare node', () => {
		const shell = makeShell();
		const { result, append } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Partition' } ], edges: [] },
			catalogClasses: [
				{ shell_name: 'Partition', is_interpreter: false },
			],
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'GET_HEALTH',
			kind: 'request',
			args: [],
		} );
		const m = shell.sink.fills[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_REQUEST );
		expect( m[ TO ] ).toBe( 'n1' );
		expect( m[ VALUE ] ).toBe( 'GET_HEALTH' );
		expect( append ).toHaveBeenCalledWith(
			expect.objectContaining( {
				kind: 'sent',
				text: 'request_node n1 GET_HEALTH',
			} )
		);
	} );

	it( 'invoke carries a spaced named token whole and quotes it in the echo', () => {
		const shell = makeShell();
		const { result, append } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Sessions_CI' } ], edges: [] },
			catalogClasses: [
				{ shell_name: 'Sessions_CI', is_interpreter: true },
			],
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'create',
			kind: 'command',
			args: [ '--label=kea bot 5528', '--ttl=5528' ],
		} );
		expect( shell.sink.fills[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'create',
			arguments: [ '--label=kea bot 5528', '--ttl=5528' ],
		} );
		expect( append ).toHaveBeenCalledWith(
			expect.objectContaining( {
				kind: 'sent',
				text: "command_node n1 create '--label=kea bot 5528' --ttl=5528",
			} )
		);
	} );

	it( 'invoke (request kind) joins its args into the request words', () => {
		const shell = makeShell();
		const { result, append } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Table' } ], edges: [] },
			catalogClasses: [ { shell_name: 'Table', is_interpreter: false } ],
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'TOUCH',
			kind: 'request',
			args: [ '5528', 'moa-5528' ],
		} );
		expect( shell.sink.fills[ 0 ][ VALUE ] ).toBe( 'TOUCH 5528 moa-5528' );
		expect( append ).toHaveBeenCalledWith(
			expect.objectContaining( {
				kind: 'sent',
				text: 'request_node n1 TOUCH 5528 moa-5528',
			} )
		);
	} );

	it( 'invoke (structured request) sends TM_REQUEST|TM_STRUCT keyed by the verb', () => {
		const shell = makeShell();
		const { result, append } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Table' } ], edges: [] },
			catalogClasses: [ { shell_name: 'Table', is_interpreter: false } ],
		} );
		const map = { 'kea 4417': [ "weka's", 913 ] };
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'MSET',
			kind: 'request',
			struct: map,
		} );
		const m = shell.sink.fills[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_REQUEST | TM_STRUCT );
		expect( m[ VALUE ] ).toEqual( { MSET: map } );
		expect( m[ TO ] ).toBe( 'n1' );
		expect( m[ FROM ] ).toBe( names.OUTPUT );
		expect( m[ LOCAL ] ).toBe( true );
		const json = JSON.stringify( { MSET: map } );
		expect( append ).toHaveBeenCalledWith(
			expect.objectContaining( {
				kind: 'sent',
				text: `request_struct n1 ${ quoteToken( json ) }`,
			} )
		);
	} );

	it( 'the structured echo replays through a Shell to the same message', () => {
		const shell = makeShell();
		const { result, append } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Table' } ], edges: [] },
			catalogClasses: [ { shell_name: 'Table', is_interpreter: false } ],
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'SADD',
			kind: 'request',
			struct: { 'moa "flock"': [ 'tui kōkako', 61 ] },
		} );
		const { text } = append.mock.calls[ 0 ][ 0 ];
		const tokens = tokenize( text );
		expect( tokens.slice( 0, 2 ) ).toEqual( [ 'request_struct', 'n1' ] );
		expect( tokens ).toHaveLength( 3 );
		expect( JSON.parse( tokens[ 2 ] ) ).toEqual(
			shell.sink.fills[ 0 ][ VALUE ]
		);
	} );

	it( "invoke scopes TO and FROM through the Shell's prefix and replyFrom", () => {
		const shell = makeShell( {
			path: 'demo.p0',
			replyFrom: ( n ) => `${ names.SSE }:1234/${ n }`,
		} );
		const { result } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Partition' } ], edges: [] },
			catalogClasses: [
				{ shell_name: 'Partition', is_interpreter: false },
			],
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'set_x',
			kind: 'command',
			args: [],
		} );
		const m = shell.sink.fills[ 0 ];
		expect( m[ TO ] ).toBe( 'demo.p0/n1:config' );
		expect( m[ FROM ] ).toBe( `${ names.SSE }:1234/${ names.OUTPUT }` );
	} );

	it( 'invoke is blocked (with an error append) when sseGuard returns false', () => {
		const shell = makeShell();
		const { result, append } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Partition' } ], edges: [] },
			catalogClasses: [
				{ shell_name: 'Partition', is_interpreter: false },
			],
			sseGuard: () => false,
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'set_x',
			kind: 'command',
			args: [],
		} );
		expect( shell.sink.fills ).toHaveLength( 0 );
		expect( append ).toHaveBeenCalledWith(
			expect.objectContaining( { kind: 'error' } )
		);
	} );

	it( 'a refused UI-bound invoke answers the button, not the transcript', () => {
		const shell = makeShell();
		const interpreter = captureInterpreter();
		const { result, append } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Partition' } ], edges: [] },
			catalogClasses: [
				{ shell_name: 'Partition', is_interpreter: false },
			],
			sseGuard: () => false,
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'dl_list',
			kind: 'command',
			args: [],
			replyTo: '_triage:dl_list',
		} );
		expect( append ).not.toHaveBeenCalled();
		expect( shell.sink.fills ).toHaveLength( 0 );
		expect( interpreter.fills ).toHaveLength( 1 );
		const refusal = interpreter.fills[ 0 ];
		expect( refusal[ TYPE ] ).toBe( TM_COMMAND | TM_ERROR );
		expect( refusal[ TO ] ).toBe( `${ names.UI }/_triage:dl_list` );
		expect( refusal[ VALUE ] ).toMatchObject( { name: 'dl_list' } );
		expect( refusal[ VALUE ].payload ).toMatch( /no SSE session yet/ );
	} );

	it( 'invoke defaults sseGuard to always-allow (overlay parity)', () => {
		const shell = makeShell();
		const { result } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Node' } ], edges: [] },
			catalogClasses: [ { shell_name: 'Node', is_interpreter: false } ],
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'configure',
			args: [],
		} );
		expect( shell.sink.fills ).toHaveLength( 1 );
	} );

	describe( 'a UI-bound invoke (one naming a replyTo)', () => {
		const invokeFor = ( replyTo, debugUi = false ) => {
			const shell = makeShell();
			const { result, append } = renderHandlers( {
				shell,
				graph: { nodes: [ { id: 'n1', class: 'Node' } ], edges: [] },
				catalogClasses: [
					{ shell_name: 'Node', is_interpreter: false },
				],
			} );
			Core.node( names.OUTPUT ).setDebugUi( debugUi );
			result.current.onInspectorAction( 'invoke', 'n1', {
				verb: 'dl_list',
				kind: 'command',
				args: [],
				replyTo,
			} );
			return { m: shell.sink.fills[ 0 ], append };
		};

		it( 'answers through _ui, which hands the reply on to replyTo', () => {
			const { m } = invokeFor( '_triage:dl_list' );
			expect( m[ FROM ] ).toBe( `${ names.UI }/_triage:dl_list` );
		} );

		it( 'names bare _ui when the caller wants no reply of its own', () => {
			const { m } = invokeFor( names.UI );
			expect( m[ FROM ] ).toBe( names.UI );
		} );

		const echoed = () =>
			( Core.node( names.OUTPUT ).transcript ?? [] ).map(
				( e ) => e.text
			);

		it( 'echoes nothing into the transcript while debug_ui is off', () => {
			const { m, append } = invokeFor( '_triage:dl_list' );
			expect( m ).toBeDefined();
			expect( append ).not.toHaveBeenCalled();
			expect( echoed() ).toEqual( [] );
		} );

		it( 'echoes the command like any other while debug_ui is on', () => {
			invokeFor( '_triage:dl_list', true );
			expect( echoed() ).toContain( 'command_node n1:config dl_list' );
		} );
	} );

	it( 'invoke with no shell reports the refusal in the transcript', () => {
		const dispatch = jest.fn();
		const append = jest.fn();
		const { result } = renderHook( () =>
			useGraphHandlers( {
				shell: null,
				graph: { nodes: [], edges: [] },
				catalogClasses: [],
				dispatch,
				append,
				onReplSend: jest.fn(),
				onDropStage: jest.fn(),
			} )
		);
		expect( () =>
			result.current.onInspectorAction( 'invoke', 'n1', {
				verb: 'x',
				args: [],
			} )
		).not.toThrow();
		expect( append ).toHaveBeenCalledTimes( 1 );
		expect( append.mock.calls[ 0 ][ 0 ] ).toEqual( {
			kind: 'error',
			text: 'No console session yet; retry once connected.',
		} );
	} );
} );

/**
 * The Compose modal's send: `onCompose` mints the form's message through the
 * Shell's `envelope()`, asks the SSE guard, signs it, echoes the signed copy
 * without the signer's `auth`, and then fills the Shell's sink, which is the
 * console's gate.
 * Every seeded value differs from the mint default it would replace.
 */
describe( 'useGraphHandlers — onCompose', () => {
	const MINT_MS = 1771234567000;
	const replyFrom = ( node ) => `_sse:abc123/${ node }`;
	// A form with FROM, ID and KEY filled and no type bits ticked.
	const form = ( over = {} ) => ( {
		type: TM_BYTESTREAM,
		response: false,
		error: false,
		noreply: false,
		from: 'elsewhere/sink-9',
		to: 'echo',
		id: 'id-4242',
		key: 'key-77',
		timestamp: '',
		value: '',
		name: '',
		arguments: '',
		payload: '',
		...over,
	} );
	// Compose through the hook: the refusal, what the gate got, the echo.
	const compose = ( over, hookOpts = {} ) => {
		const shell = makeShell( { path: 'demo.p3', replyFrom } );
		const { result, append, onReplSend } = renderHandlers( {
			shell,
			...hookOpts,
		} );
		const refusal = result.current.onCompose( form( over ) );
		return { refusal, sent: shell.sink.fills, append, onReplSend };
	};

	// Unsigned: the shape tests read the mint, not the signer's re-anchor.
	beforeEach( () => {
		forgetSession();
		jest.spyOn( Date, 'now' ).mockReturnValue( MINT_MS );
	} );
	afterEach( () => {
		jest.restoreAllMocks();
		Core.reset();
	} );

	it.each( [
		[ 'TM_BYTESTREAM', TM_BYTESTREAM, 'raw bytes', 'raw bytes' ],
		[ 'TM_REQUEST', TM_REQUEST, 'GET_HEALTH now', 'GET_HEALTH now' ],
		[ 'TM_INFO', TM_INFO, 'heads up', 'heads up' ],
		[
			'TM_STRUCT',
			TM_STRUCT,
			'{"depth":3,"on":true}',
			{ depth: 3, on: true },
		],
		[ 'TM_EOF', TM_EOF, 'ignored', '' ],
	] )(
		'fills the gate with the exact positional %s message',
		( label, type, value, expected ) => {
			const { refusal, sent } = compose( { type, value } );
			expect( refusal ).toBeNull();
			expect( sent ).toEqual( [
				[
					type,
					MINT_MS / 1000,
					'elsewhere/sink-9',
					'demo.p3/echo',
					'id-4242',
					'key-77',
					expected,
					true,
				],
			] );
		}
	);

	it( 'fills the gate with the exact positional TM_COMMAND message', () => {
		const { sent } = compose( {
			type: TM_COMMAND,
			name: 'add_target',
			arguments: 'a b',
		} );
		expect( sent ).toEqual( [
			[
				TM_COMMAND,
				MINT_MS / 1000,
				'elsewhere/sink-9',
				'demo.p3/echo',
				'id-4242',
				'key-77',
				{ name: 'add_target', arguments: [ 'a', 'b' ] },
				true,
			],
		] );
	} );

	it( 'sends the seven fields plus LOCAL, and nothing past them', () => {
		const { sent } = compose( {
			type: TM_COMMAND,
			name: 'ls',
			timestamp: '1700000123',
		} );
		expect( sent[ 0 ] ).toHaveLength( LOCAL + 1 );
	} );

	it( 'echoes the message it sent at the Shell prompt', () => {
		const { sent, append } = compose( {
			type: TM_INFO,
			value: 'heads up',
		} );
		expect( append ).toHaveBeenCalledTimes( 1 );
		expect( append ).toHaveBeenCalledWith( {
			kind: 'sent',
			text: formatMessageEnvelope( sent[ 0 ] ),
			prompt: '/demo.p3',
		} );
	} );

	it( 'ORs TM_RESPONSE, TM_ERROR and TM_NOREPLY onto the chosen type', () => {
		const { sent } = compose( {
			type: TM_INFO,
			value: 'x',
			response: true,
			error: true,
			noreply: true,
		} );
		expect( sent[ 0 ][ TYPE ] ).toBe(
			TM_INFO | TM_RESPONSE | TM_ERROR | TM_NOREPLY
		);
	} );

	it( 'sets only the bit each checkbox names', () => {
		const { sent } = compose( {
			type: TM_INFO,
			value: 'x',
			noreply: true,
		} );
		expect( sent[ 0 ][ TYPE ] ).toBe( TM_INFO | TM_NOREPLY );
	} );

	it( 'sends every field as typed; only an empty one is blank', () => {
		const { sent } = compose( {
			type: TM_COMMAND,
			from: ' elsewhere/sink-9 ',
			id: ' ',
			key: ' trace-77 ',
			name: ' make_node ',
			payload: '\n',
		} );
		const [ m ] = sent;
		expect( m[ FROM ] ).toBe( ' elsewhere/sink-9 ' );
		expect( m[ ID ] ).toBe( ' ' );
		expect( m[ KEY ] ).toBe( ' trace-77 ' );
		expect( m[ VALUE ] ).toEqual( {
			name: ' make_node ',
			arguments: [],
			payload: '\n',
		} );
	} );

	it( 'keeps the mint values for blank FROM, ID, KEY and TIMESTAMP', () => {
		const { sent } = compose( {
			type: TM_INFO,
			value: 'x',
			from: '',
			id: '',
			key: '',
		} );
		const [ m ] = sent;
		expect( m[ FROM ] ).toBe( `_sse:abc123/${ names.OUTPUT }` );
		expect( m[ ID ] ).toBe( '' );
		expect( m[ KEY ] ).toBe( '' );
		expect( m[ TIMESTAMP ] ).toBe( MINT_MS / 1000 );
	} );

	it.each( [
		[ 'a bytestream', { type: TM_BYTESTREAM, value: 'x' } ],
		[
			'a command answering',
			{ type: TM_COMMAND, name: 'ls', response: true },
		],
	] )(
		'sets a filled Timestamp on %s, which nothing signs',
		( label, over ) => {
			const { refusal, sent } = compose( {
				...over,
				timestamp: '1700000123.5',
			} );
			expect( refusal ).toBeNull();
			expect( sent[ 0 ][ TIMESTAMP ] ).toBe( '1700000123.5' );
		}
	);

	it( 'tokenizes quoted Arguments as the prompt does', () => {
		const { sent } = compose( {
			type: TM_COMMAND,
			name: 'make_node',
			arguments: 'a "b c" d',
		} );
		expect( sent[ 0 ][ VALUE ].arguments ).toEqual( [ 'a', 'b c', 'd' ] );
	} );

	it( 'leaves payload out of a command whose Payload is empty', () => {
		const { sent } = compose( {
			type: TM_COMMAND,
			name: 'ls',
			payload: '',
		} );
		expect( sent[ 0 ][ VALUE ] ).not.toHaveProperty( 'payload' );
	} );

	it( 'sends a filled Payload as the string typed', () => {
		const { sent } = compose( {
			type: TM_COMMAND,
			name: 'ls',
			payload: ' {"x":1} ',
		} );
		expect( sent[ 0 ][ VALUE ].payload ).toBe( ' {"x":1} ' );
	} );

	it( 'adds no trailing newline to a bytestream', () => {
		const { sent } = compose( {
			type: TM_BYTESTREAM,
			value: 'line one',
		} );
		expect( sent[ 0 ][ VALUE ] ).toBe( 'line one' );
	} );

	it( 'refuses a struct whose Value is not JSON, sending and echoing nothing', () => {
		const { refusal, sent, append } = compose( {
			type: TM_STRUCT,
			value: '{depth: 3',
		} );
		expect( refusal ).toMatch( /^Value is not JSON: / );
		expect( sent ).toEqual( [] );
		expect( append ).not.toHaveBeenCalled();
	} );

	it( 'sends a command with an empty Name, for the server to refuse', () => {
		const { refusal, sent } = compose( {
			type: TM_COMMAND,
			name: '',
		} );
		expect( refusal ).toBeNull();
		expect( sent[ 0 ][ VALUE ] ).toEqual( { name: '', arguments: [] } );
	} );

	it( 'opens the REPL once the echo lands', () => {
		const { refusal, onReplSend, append } = compose( {
			type: TM_INFO,
			value: 'heads up',
		} );
		expect( refusal ).toBeNull();
		expect( append ).toHaveBeenCalledTimes( 1 );
		expect( onReplSend ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'refuses a send to a worker with no SSE session before echoing it', () => {
		const sseGuard = jest.fn( () => false );
		const { refusal, sent, append, onReplSend } = compose(
			{ type: TM_COMMAND, name: 'ls' },
			{ sseGuard }
		);
		expect( refusal ).toBe( '[no SSE session yet] retry once CONNECTED' );
		expect( sseGuard ).toHaveBeenCalledWith( 'demo.p3/echo' );
		expect( sent ).toEqual( [] );
		expect( append ).not.toHaveBeenCalled();
		expect( onReplSend ).not.toHaveBeenCalled();
	} );

	it( 'refuses with no Shell to send through, echoing nothing', () => {
		const { result, append, onReplSend } = renderHandlers( {
			shell: null,
		} );
		expect(
			result.current.onCompose( form( { type: TM_INFO, value: 'x' } ) )
		).toBe( 'No console session yet; retry once connected.' );
		expect( append ).not.toHaveBeenCalled();
		expect( onReplSend ).not.toHaveBeenCalled();
	} );

	it( 'refuses a gate with no sink of its own, echoing nothing', () => {
		const shell = makeShell( { path: 'demo.p3', replyFrom } );
		shell.sink = new OutgoingGateNode();
		const { result, append, onReplSend } = renderHandlers( { shell } );
		expect(
			result.current.onCompose( form( { type: TM_INFO, value: 'x' } ) )
		).toBe( 'No console session yet; retry once connected.' );
		expect( append ).not.toHaveBeenCalled();
		expect( onReplSend ).not.toHaveBeenCalled();
	} );

	it( 'refuses Arguments with an unclosed quote', () => {
		const { refusal, sent, append } = compose( {
			type: TM_COMMAND,
			name: 'make_node',
			arguments: 'Tee "half open',
		} );
		expect( refusal ).toBe( 'Arguments: unclosed quote' );
		expect( sent ).toEqual( [] );
		expect( append ).not.toHaveBeenCalled();
	} );

	it( 'refuses with no sink to send into', () => {
		const shell = makeShell( { path: 'demo.p3', replyFrom } );
		shell.sink = null;
		const { result, append } = renderHandlers( { shell } );
		expect(
			result.current.onCompose( form( { type: TM_INFO, value: 'x' } ) )
		).toBe( 'No console session yet; retry once connected.' );
		expect( append ).not.toHaveBeenCalled();
	} );

	// A sink that routes as the Router does: it peels TO's head in place.
	const routingShell = ( deliver ) => {
		const shell = makeShell( { path: 'demo.p3', replyFrom } );
		shell.sink = {
			connected: true,
			fill: ( m ) => {
				m[ TO ] = m[ TO ].split( '/' ).slice( 1 ).join( '/' );
				deliver( m );
			},
		};
		return shell;
	};

	it( 'echoes the message as sent, before the router peels its TO', () => {
		const shell = routingShell( () => {} );
		const { result, append } = renderHandlers( { shell } );
		result.current.onCompose(
			form( { type: TM_INFO, value: 'heads up' } )
		);
		expect( append.mock.calls[ 0 ][ 0 ].text ).toContain(
			'to:        demo.p3/echo\n'
		);
	} );

	it( 'echoes before the send, so a local reply lands after its echo', () => {
		const log = [];
		const append = ( entry ) => log.push( entry.kind );
		const shell = routingShell( () =>
			append( { kind: 'recv', text: 'local reply' } )
		);
		const { result } = renderHandlers( { shell, append } );
		result.current.onCompose(
			form( { type: TM_INFO, value: 'heads up' } )
		);
		expect( log ).toEqual( [ 'sent', 'recv' ] );
	} );

	it( 'reports a send that raises after its echo, keeping the modal open', () => {
		const log = [];
		const append = ( entry ) => log.push( [ entry.kind, entry.text ] );
		const shell = routingShell( () => {
			throw new Error( 'NOT_AVAILABLE: echo ls' );
		} );
		const { result, onReplSend } = renderHandlers( { shell, append } );
		const refusal = result.current.onCompose(
			form( { type: TM_COMMAND, name: 'ls', noreply: true } )
		);
		expect( log.map( ( [ kind ] ) => kind ) ).toEqual( [
			'sent',
			'error',
		] );
		expect( log[ 1 ][ 1 ] ).toBe( 'NOT_AVAILABLE: echo ls' );
		expect( refusal ).toBe(
			'Sent; the send raised: NOT_AVAILABLE: echo ls'
		);
		// The modal keeps focus: a send that raised does not open the REPL.
		expect( onReplSend ).not.toHaveBeenCalled();
	} );

	it( "echoes a struct's own auth key, which no signer added", () => {
		const { sent, append } = compose( {
			type: TM_STRUCT,
			value: '{"auth":{"sig":"typed-7"}}',
		} );
		expect( sent[ 0 ][ VALUE ] ).toEqual( { auth: { sig: 'typed-7' } } );
		expect( append.mock.calls[ 0 ][ 0 ].text ).toContain( 'typed-7' );
	} );

	describe( 'signing', () => {
		const HANDLE = 'cccc3333dddd4444eeee5555ffff6666';
		// The server's clock runs 300s ahead of the mint's.
		const SERVER_NOW = MINT_MS / 1000 + 300;

		beforeEach( async () => {
			__setAuthFetch( async () => ( {
				handle: HANDLE,
				secret: 'compose-session-key-9090',
				expires_in: 3600,
				now: SERVER_NOW,
			} ) );
			await ensureSession();
		} );

		it( 'stamps a command with a blank Timestamp at the server clock', () => {
			const { sent } = compose( { type: TM_COMMAND, name: 'ls' } );
			expect( sent[ 0 ][ TIMESTAMP ] ).toBe( SERVER_NOW );
		} );

		it.each( [ 'abc', '0x6553F100' ] )(
			'sends a command forged at %s as typed, stamped and unsigned',
			( timestamp ) => {
				const { refusal, sent, append } = compose( {
					type: TM_COMMAND,
					name: 'ls',
					timestamp,
				} );
				expect( refusal ).toBeNull();
				expect( sent[ 0 ][ TIMESTAMP ] ).toBe( timestamp );
				expect( sent[ 0 ][ VALUE ] ).not.toHaveProperty( 'auth' );
				expect( append ).toHaveBeenCalledTimes( 1 );
			}
		);

		it.each( [ '1e13', 'abc' ] )(
			'echoes a message whose TIMESTAMP %s makes no date',
			( timestamp ) => {
				const { sent, append } = compose( {
					type: TM_INFO,
					value: 'x',
					timestamp,
				} );
				expect( sent ).toHaveLength( 1 );
				expect( append.mock.calls[ 0 ][ 0 ].text ).toContain(
					`timestamp: ${ timestamp }\n`
				);
			}
		);

		it( 'signs a composed command the PHP fixture verifies', async () => {
			const fixture = JSON.parse(
				readFileSync(
					join(
						__dirname,
						'../../../../tests/fixtures/signatures.json'
					),
					'utf8'
				)
			);
			const [ vector ] = fixture.vectors;
			forgetSession();
			__setAuthFetch( async () => ( {
				handle: HANDLE,
				secret: vector.key,
				expires_in: 3600,
			} ) );
			await ensureSession();
			const nonce = Uint8Array.from(
				vector.nonce.match( /../g ).map( ( b ) => parseInt( b, 16 ) )
			);
			jest.spyOn( crypto, 'getRandomValues' ).mockImplementation(
				( out ) => {
					out.set( nonce );
					return out;
				}
			);
			const { sent } = compose( {
				type: vector.type,
				name: vector.name,
				arguments: vector.arguments.join( ' ' ),
				timestamp: String( vector.ts ),
			} );

			expect( sent[ 0 ][ TIMESTAMP ] ).toBe( String( vector.ts ) );
			expect( sent[ 0 ][ VALUE ].auth.sig ).toBe(
				fixture.signatures[ 0 ]
			);
		} );

		it( 'signs a command at its typed Timestamp', () => {
			const nonce = Uint8Array.from( { length: 16 }, ( _, i ) => i + 7 );
			jest.spyOn( crypto, 'getRandomValues' ).mockImplementation(
				( out ) => {
					out.set( nonce );
					return out;
				}
			);
			const { refusal, sent } = compose( {
				type: TM_COMMAND,
				name: 'add_target',
				arguments: 'b "c d"',
				timestamp: '1700000123',
			} );
			// The same command, carrying the same TIMESTAMP, signed alike.
			const expected = [ ...sent[ 0 ].slice( 0, VALUE ) ];
			expected[ VALUE ] = {
				name: 'add_target',
				arguments: [ 'b', 'c d' ],
			};
			expected[ TIMESTAMP ] = '1700000123';
			signCommand( expected, true );

			expect( refusal ).toBeNull();
			expect( sent[ 0 ][ TIMESTAMP ] ).toBe( '1700000123' );
			expect( sent[ 0 ][ VALUE ].auth ).toEqual( expected[ VALUE ].auth );
			expect( sent[ 0 ][ VALUE ].auth.sig ).toMatch( /^[0-9a-f]{64}$/ );
		} );
		afterEach( () => {
			forgetSession();
			__setAuthFetch( null );
		} );

		it( 'marks a non-command LOCAL and leaves it unsigned', () => {
			const { sent } = compose( {
				type: TM_REQUEST,
				value: 'GET_HEALTH',
			} );
			expect( sent[ 0 ][ LOCAL ] ).toBe( true );
			expect( sent[ 0 ][ VALUE ] ).toBe( 'GET_HEALTH' );
		} );

		it( 'signs the command it sends, and echoes it without the signature', () => {
			const { sent, append } = compose( {
				type: TM_COMMAND,
				name: 'ls',
				noreply: true,
			} );
			const [ m ] = sent;
			expect( m[ LOCAL ] ).toBe( true );
			expect( m[ VALUE ].auth.handle ).toBe( HANDLE );
			expect( m[ VALUE ].auth.sig ).toMatch( /^[0-9a-f]{64}$/ );
			const { text } = append.mock.calls[ 0 ][ 0 ];
			expect( text ).toContain( '"name": "ls"' );
			expect( text ).not.toMatch( /auth|sig|nonce/ );
			expect( text ).not.toContain( HANDLE );
		} );

		it( 'echoes the TIMESTAMP the wire carries, server-aligned', () => {
			const { sent, append } = compose( {
				type: TM_COMMAND,
				name: 'ls',
			} );
			const { text } = append.mock.calls[ 0 ][ 0 ];
			expect( sent[ 0 ][ TIMESTAMP ] ).toBe( SERVER_NOW );
			expect( text ).toContain( `timestamp: ${ SERVER_NOW } (` );
			expect( text ).not.toMatch( /auth|sig|nonce/ );
		} );
	} );
} );

/**
 * One "shows in the REPL" rule: an Inspector action, a REPL-bound invoke among
 * them, and a sent compose each tell the host once. A canvas gesture and a
 * UI-bound invoke, whose traffic the transcript hides, tell it nothing.
 */
describe( 'useGraphHandlers — onReplSend', () => {
	afterEach( () => Core.reset() );

	it( 'leaves canvas gestures off the REPL and follows an Inspector action', () => {
		const { result, dispatch, onReplSend } = renderHandlers( {} );
		result.current.onConnect( 'tee-9', 'echo-4' );
		result.current.onRemoveEdge( 'tee-9', 'echo-4' );
		result.current.onRemoveNode( 'tee-9' );
		expect( dispatch ).toHaveBeenCalledTimes( 3 );
		expect( onReplSend ).not.toHaveBeenCalled();
		result.current.onInspectorAction( 'dump', 'tee-9', null );
		expect( dispatch ).toHaveBeenCalledTimes( 4 );
		expect( onReplSend ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'follows a REPL-bound invoke and skips a UI-bound one', () => {
		const shell = makeShell( { path: 'demo.p3' } );
		const { result, onReplSend } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Node' } ], edges: [] },
			catalogClasses: [ { shell_name: 'Node', is_interpreter: false } ],
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'dl_list',
			args: [],
			replyTo: '_triage:dl_list',
		} );
		expect( onReplSend ).not.toHaveBeenCalled();
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'configure',
			args: [],
		} );
		expect( onReplSend ).toHaveBeenCalledTimes( 1 );
		expect( shell.sink.fills ).toHaveLength( 2 );
	} );
} );

/**
 * The REPL shows by one rule decided before the send, and invoke shares the
 * compose's send tail: a send that raises is reported, never thrown.
 */
describe( 'useGraphHandlers — the send tail', () => {
	afterEach( () => Core.reset() );

	it( 'opens the REPL for an Inspector action whose send raises', () => {
		const dispatch = jest.fn( () => {
			throw new Error( 'line refused' );
		} );
		const { result, onReplSend } = renderHandlers( { dispatch } );
		expect( () =>
			result.current.onInspectorAction( 'dump', 'tee-9', null )
		).toThrow( 'line refused' );
		expect( onReplSend ).toHaveBeenCalledTimes( 1 );
	} );

	it( 'reports an invoke whose send raises after delivering', () => {
		const shell = makeShell( { path: 'demo.p3' } );
		const delivered = [];
		shell.sink = {
			connected: true,
			fill: ( m ) => {
				delivered.push( m );
				throw new Error( 'tap copy failed' );
			},
		};
		const { result, append, onReplSend } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Node' } ], edges: [] },
			catalogClasses: [ { shell_name: 'Node', is_interpreter: false } ],
		} );
		expect( () =>
			result.current.onInspectorAction( 'invoke', 'n1', {
				verb: 'configure',
				args: [],
			} )
		).not.toThrow();
		expect( delivered ).toHaveLength( 1 );
		expect( append.mock.calls.map( ( [ e ] ) => e.kind ) ).toEqual( [
			'sent',
			'error',
		] );
		expect( append.mock.calls[ 1 ][ 0 ].text ).toBe( 'tap copy failed' );
		expect( onReplSend ).toHaveBeenCalledTimes( 1 );
	} );
} );

/**
 * An invoke never drops in silence: a REPL-bound one writes its refusal to the
 * transcript once, and a UI-bound one answers its button with a TM_ERROR on
 * the reply path, as it does for a refused SSE send.
 */
describe( 'useGraphHandlers — invoke refusals', () => {
	afterEach( () => Core.reset() );

	const NO_SESSION = 'No console session yet; retry once connected.';
	const graph = { nodes: [ { id: 'n1', class: 'Node' } ], edges: [] };
	const catalogClasses = [ { shell_name: 'Node', is_interpreter: false } ];
	const disconnected = () => {
		const shell = makeShell( { path: 'demo.p5' } );
		shell.sink = new OutgoingGateNode();
		return shell;
	};
	const raising = () => {
		const shell = makeShell( { path: 'demo.p5' } );
		shell.sink = {
			connected: true,
			fill: () => {
				throw new Error( 'tap copy failed' );
			},
		};
		return shell;
	};
	const uiInvoke = ( shell ) => {
		const interpreter = captureInterpreter();
		const { result, append } = renderHandlers( {
			shell,
			graph,
			catalogClasses,
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'dl_purge',
			kind: 'command',
			args: [],
			replyTo: '_triage:dl_purge',
		} );
		return { interpreter, append };
	};
	const expectUiRefusal = ( interpreter, text ) => {
		expect( interpreter.fills ).toHaveLength( 1 );
		const err = interpreter.fills[ 0 ];
		expect( err[ TYPE ] ).toBe( TM_COMMAND | TM_ERROR );
		expect( err[ TO ] ).toBe( `${ names.UI }/_triage:dl_purge` );
		expect( err[ VALUE ] ).toEqual( {
			name: 'dl_purge',
			payload: `${ text }\n`,
		} );
	};

	it( 'writes the refusal once when the gate has no sink', () => {
		const { result, append } = renderHandlers( {
			shell: disconnected(),
			graph,
			catalogClasses,
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'set_x',
			args: [],
		} );
		expect( append.mock.calls ).toEqual( [
			[ { kind: 'error', text: NO_SESSION } ],
		] );
	} );

	it( 'writes the refusal when no session can sign the command', () => {
		const { result, append } = renderHandlers( { graph, catalogClasses } );
		Core.node( names.OUTPUT ).command = () => null;
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'set_x',
			args: [],
		} );
		expect( append.mock.calls ).toEqual( [
			[ { kind: 'error', text: NO_SESSION } ],
		] );
	} );

	it( 'answers a UI-bound invoke on a gate with no sink', () => {
		const { interpreter, append } = uiInvoke( disconnected() );
		expect( append ).not.toHaveBeenCalled();
		expectUiRefusal( interpreter, NO_SESSION );
	} );

	it( 'answers a UI-bound invoke with no shell', () => {
		const { interpreter, append } = uiInvoke( null );
		expect( append ).not.toHaveBeenCalled();
		expectUiRefusal( interpreter, NO_SESSION );
	} );

	it( 'answers a UI-bound invoke whose send raises', () => {
		const { interpreter, append } = uiInvoke( raising() );
		expect( append ).not.toHaveBeenCalled();
		expectUiRefusal(
			interpreter,
			'Sent; the send raised: tap copy failed'
		);
	} );
} );
