import { renderHook } from '@testing-library/react';
import { useGraphHandlers } from '../useGraphHandlers';
import {
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
	TM_REQUEST,
} from '../../../runtime/message';
import names from '../../../runtime/reserved-node-names.json';
import { Core } from '../../../runtime/core';

// A minimal Shell stand-in whose sink captures every filled message and whose
// prefix/replyFrom can be injected per-test (the console uses cwd-prefixing).
function makeShell( { path = '', prefix, replyFrom } = {} ) {
	const sink = { fills: [], fill: ( m ) => sink.fills.push( m ) };
	return {
		path,
		sink,
		prefix: prefix || ( ( x ) => x ),
		replyFrom: replyFrom || ( ( x ) => x ),
	};
}

const renderHandlers = ( opts ) => {
	const dispatch = jest.fn();
	const append = jest.fn();
	const onDropStage = jest.fn();
	const shell = opts.shell || makeShell();
	const { result } = renderHook( () =>
		useGraphHandlers( {
			shell,
			graph: { nodes: [], edges: [] },
			catalogClasses: [],
			dispatch,
			append,
			onDropStage,
			...opts,
		} )
	);
	return { result, dispatch, append, onDropStage, shell };
};

describe( 'useGraphHandlers — targeted metadata refresh after a mutation', () => {
	let refreshed;
	beforeEach( () => {
		Core.reset();
		refreshed = [];
		Core.registerNode( names.METADATA, {
			name: names.METADATA,
			refreshNode: ( n ) => refreshed.push( n ),
		} );
	} );
	afterEach( () => Core.reset() );

	it( 'onConnect refreshes the FROM node (its target changed)', () => {
		const { result } = renderHandlers( {} );
		result.current.onConnect( 'a', 'b' );
		expect( refreshed ).toEqual( [ 'a' ] );
	} );

	it( 'onRemoveNode refreshes the removed node (so it leaves the canvas)', () => {
		const { result } = renderHandlers( {} );
		result.current.onRemoveNode( 'x' );
		expect( refreshed ).toEqual( [ 'x' ] );
	} );

	it( 'onInspectorAction disconnect refreshes the node', () => {
		const { result } = renderHandlers( {} );
		result.current.onInspectorAction( 'disconnect', 'x', null );
		expect( refreshed ).toEqual( [ 'x' ] );
	} );

	it( 'onInspectorAction tail refreshes the node (its target changed)', () => {
		const { result } = renderHandlers( {} );
		result.current.onInspectorAction( 'tail', 'x', null );
		expect( refreshed ).toEqual( [ 'x' ] );
	} );

	it( 'a non-mutating inspector action (dump) does NOT refresh', () => {
		const { result } = renderHandlers( {} );
		result.current.onInspectorAction( 'dump', 'x', null );
		expect( refreshed ).toEqual( [] );
	} );
} );

describe( 'useGraphHandlers', () => {
	it( 'onConnect dispatches a connect_node command line', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onConnect( 'a', 'b' );
		expect( dispatch ).toHaveBeenCalledWith(
			'connect_node a b',
			'connect_node',
			'a b'
		);
	} );

	it( 'onRemoveNode dispatches a remove_node command line', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onRemoveNode( 'a' );
		expect( dispatch ).toHaveBeenCalledWith(
			'remove_node a',
			'remove_node',
			'a'
		);
	} );

	it( 'onInspectorAction dump dispatches dump_node', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'dump', 'a', null );
		expect( dispatch ).toHaveBeenCalledWith(
			'dump_node a',
			'dump_node',
			'a'
		);
	} );

	it( 'onInspectorAction tail dispatches connect_node with no target', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'tail', 'a', null );
		expect( dispatch ).toHaveBeenCalledWith(
			'connect_node a',
			'connect_node',
			'a'
		);
	} );

	it( 'onInspectorAction disconnect dispatches disconnect_node', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'disconnect', 'a', null );
		expect( dispatch ).toHaveBeenCalledWith(
			'disconnect_node a',
			'disconnect_node',
			'a'
		);
	} );

	it( 'onInspectorAction send dispatches send_node with id + payload', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'send', 'a', 'hello' );
		expect( dispatch ).toHaveBeenCalledWith(
			'send_node a hello',
			'send_node',
			'a hello'
		);
	} );

	it( 'onInspectorAction trace uses the numeric payload as the level', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'trace', 'a', 0 );
		expect( dispatch ).toHaveBeenCalledWith(
			'debug_state a 0',
			'debug_state',
			'a 0'
		);
	} );

	it( 'onInspectorAction trace defaults the level to 1 for a non-numeric payload', () => {
		const { result, dispatch } = renderHandlers( {} );
		result.current.onInspectorAction( 'trace', 'a', undefined );
		expect( dispatch ).toHaveBeenCalledWith(
			'debug_state a 1',
			'debug_state',
			'a 1'
		);
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
			positional: 'foo bar',
		} );
		expect( shell.sink.fills ).toHaveLength( 1 );
		const m = shell.sink.fills[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( 'my-node:config' );
		expect( m[ FROM ] ).toBe( names.OUTPUT );
		expect( m[ LOCAL ] ).toBe( true );
		expect( m[ VALUE ] ).toEqual( {
			name: 'configure',
			arguments: 'foo bar',
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
			positional: '',
		} );
		const m = shell.sink.fills[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( 'n1' );
		expect( m[ VALUE ] ).toEqual( { name: 'set_is_hub', arguments: '' } );
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
			verb: 'GET_LAG',
			kind: 'request',
			positional: '',
		} );
		const m = shell.sink.fills[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_REQUEST );
		expect( m[ TO ] ).toBe( 'n1' );
		expect( m[ VALUE ] ).toBe( 'GET_LAG' );
		expect( append ).toHaveBeenCalledWith(
			expect.objectContaining( {
				kind: 'sent',
				text: 'request_node n1 GET_LAG',
			} )
		);
	} );

	it( 'invoke applies the injected prefix/replyFrom to TO/FROM', () => {
		const shell = makeShell( {
			path: '_sse/demo.p0',
			prefix: ( p ) => `_sse/demo.p0/${ p }`,
			replyFrom: ( n ) => `${ names.SSE }:1234/${ n }`,
		} );
		const { result } = renderHandlers( {
			shell,
			graph: { nodes: [ { id: 'n1', class: 'Partition' } ], edges: [] },
			catalogClasses: [
				{ shell_name: 'Partition', is_interpreter: false },
			],
			prefix: shell.prefix,
			replyFrom: shell.replyFrom,
		} );
		result.current.onInspectorAction( 'invoke', 'n1', {
			verb: 'set_x',
			kind: 'command',
			positional: '',
		} );
		const m = shell.sink.fills[ 0 ];
		expect( m[ TO ] ).toBe( '_sse/demo.p0/n1:config' );
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
			positional: '',
		} );
		expect( shell.sink.fills ).toHaveLength( 0 );
		expect( append ).toHaveBeenCalledWith(
			expect.objectContaining( { kind: 'error' } )
		);
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
			positional: '',
		} );
		expect( shell.sink.fills ).toHaveLength( 1 );
	} );

	it( 'invoke is a no-op when there is no shell', () => {
		const dispatch = jest.fn();
		const append = jest.fn();
		const { result } = renderHook( () =>
			useGraphHandlers( {
				shell: null,
				graph: { nodes: [], edges: [] },
				catalogClasses: [],
				dispatch,
				append,
				onDropStage: jest.fn(),
			} )
		);
		expect( () =>
			result.current.onInspectorAction( 'invoke', 'n1', {
				verb: 'x',
				positional: '',
			} )
		).not.toThrow();
		expect( append ).not.toHaveBeenCalled();
	} );
} );
