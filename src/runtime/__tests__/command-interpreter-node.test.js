import { CommandInterpreterNode } from '../command-interpreter-node';
import { Node, parseSchemaArgs } from '../node';
import { Core } from '../core';
import { RouterNode } from '../router-node';
import { TimerNode } from '../timer-node';
import { SseInNode } from '../sse-in-node';
import {
	TYPE,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	LOCAL,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_PING,
	TM_EOF,
	TM_NOREPLY,
	newMessage,
} from '../message';

beforeEach( () => {
	Core.reset();
	RouterNode.profiles( null ); // profiling is static process state; clear per test
} );

test( 'keystone: a quoted multi-word Shell arg survives as ONE token to the verb handler', () => {
	// eslint-disable-next-line global-require
	const { ShellNode } = require( '../shell-node' );

	const interpreter = new CommandInterpreterNode();
	interpreter.name = '_command_interpreter';
	interpreter.sink = { fill: () => {} };
	let received = null;
	interpreter.commands( {
		verb: ( self, args ) => {
			received = args;
			return 'ok';
		},
	} );

	const shell = new ShellNode();
	shell.sink = interpreter;
	// Bare-verb form: TO is the (empty) cwd, so this interpreter interprets it.
	// The quoted `a b` is ONE token; `--flag` a bare flag; `c` a positional.
	shell.fill( "verb 'a b' c --flag" );

	expect( received ).toEqual( [ 'a b', 'c', '--flag' ] );

	// The `cmd <path> <verb>` form slices tokens[2:] into the envelope array.
	const captured = [];
	const shell2 = new ShellNode();
	shell2.sink = { fill: ( m ) => captured.push( m ) };
	shell2.fill( "cmd x verb 'a b' c" );
	expect( captured[ 0 ][ VALUE ] ).toMatchObject( {
		name: 'verb',
		arguments: [ 'a b', 'c' ],
	} );
} );

test( 'non-TM_COMMAND message passes straight through to sink', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const interpreter = new CommandInterpreterNode();
	interpreter.sink = sink;
	interpreter.commands( {} );

	const m = newMessage();
	m[ VALUE ] = 'pass';
	interpreter.fill( m );
	expect( got ).toHaveLength( 1 );
} );

test( 'TM_COMMAND with non-empty TO is forwarded to sink (in transit)', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const interpreter = new CommandInterpreterNode();
	interpreter.sink = sink;
	interpreter.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ TO ] = 'downstream';
	interpreter.fill( m );
	expect( got ).toHaveLength( 1 );
} );

test( 'TM_COMMAND with empty TO dispatches the named verb', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const interpreter = new CommandInterpreterNode();
	interpreter.name = 'test_interpreter';
	interpreter.sink = sink;
	interpreter.commands( {
		echo: ( self, args ) => `echoed: ${ args.join( ' ' ) }`,
	} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ ID ] = 'cmd-1';
	m[ KEY ] = 'gui:typed';
	// VALUE carries the command object directly — no inner JSON layer.
	m[ VALUE ] = {
		name: 'echo',
		arguments: [ 'hi' ],
	};
	m[ LOCAL ] = true; // in-process command — carries the provenance taint
	interpreter.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TYPE ] & TM_RESPONSE ).toBeTruthy();
	expect( got[ 0 ][ TO ] ).toBe( 'caller' );
	expect( got[ 0 ][ ID ] ).toBe( 'cmd-1' );
	expect( got[ 0 ][ KEY ] ).toBe( 'gui:typed' );
	// Response VALUE is the { name, arguments, payload } object, not JSON.
	expect( got[ 0 ][ VALUE ] ).toMatchObject( {
		name: 'echo',
		arguments: [ 'hi' ],
		// Newline-terminated like every string reply — see below.
		payload: 'echoed: hi\n',
	} );
} );

test( 'move_node renames a node in the registry', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );
	const interpreter = new CommandInterpreterNode();
	interpreter.name = 'move_probe';
	interpreter.sink = sink;
	interpreter.makeNode( 'Echo', 'wombat-before' );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ VALUE ] = {
		name: 'move_node',
		arguments: [ 'wombat-before', 'wombat-after' ],
	};
	m[ LOCAL ] = true;
	interpreter.fill( m );

	expect( Core.node( 'wombat-before' ) ).toBeNull();
	expect( Core.node( 'wombat-after' ) ).not.toBeNull();
} );

test( 'move_node without both names returns usage', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );
	const interpreter = new CommandInterpreterNode();
	interpreter.name = 'move_usage_probe';
	interpreter.sink = sink;

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ VALUE ] = { name: 'mv', arguments: [ 'only-one' ] };
	m[ LOCAL ] = true;
	interpreter.fill( m );

	expect( got[ 0 ][ VALUE ].payload ).toContain( 'usage: move_node' );
} );

test( 'a string reply is newline-terminated, and not doubly so', () => {
	// A handler that forgets its terminator leaves the REPL printing the next
	// prompt on the same line. Normalized once, in _respond.
	const cases = [
		[ 'no terminator here', 'no terminator here\n' ],
		[ 'already there\n', 'already there\n' ],
	];
	cases.forEach( ( [ returned, expected ], i ) => {
		const sink = new Node();
		const got = [];
		sink.fill = ( m ) => got.push( [ ...m ] );
		const interpreter = new CommandInterpreterNode();
		interpreter.name = `terminator_probe_${ i }`;
		interpreter.sink = sink;
		interpreter.commands( { probe: () => returned } );

		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = 'caller';
		m[ VALUE ] = { name: 'probe', arguments: [] };
		m[ LOCAL ] = true;
		interpreter.fill( m );

		expect( got[ 0 ][ VALUE ].payload ).toBe( expected );
	} );
} );

test( 'verb throwing returns TM_COMMAND|TM_ERROR with the message', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const interpreter = new CommandInterpreterNode();
	interpreter.name = 'test_interpreter';
	interpreter.sink = sink;
	interpreter.commands( {
		bad: () => {
			throw new Error( 'boom' );
		},
	} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ ID ] = 'cmd-2';
	m[ VALUE ] = {
		name: 'bad',
		arguments: '',
	};
	m[ LOCAL ] = true;
	interpreter.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	// Newline-terminated, as PHP's interpret() sends it — the REPL prints the
	// payload verbatim, so a bare message runs into the next prompt.
	expect( got[ 0 ][ VALUE ].payload ).toBe( 'boom\n' );
} );

test( 'command without LOCAL provenance is refused (unauthorized), verb not run', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	let ran = false;
	const interpreter = new CommandInterpreterNode();
	interpreter.name = 'test_interpreter';
	interpreter.sink = sink;
	interpreter.commands( {
		echo: () => {
			ran = true;
			return 'ok';
		},
	} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ VALUE ] = { name: 'echo', arguments: '' };
	// No LOCAL — an injected/off-process command.
	interpreter.fill( m );

	expect( ran ).toBe( false );
	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	expect( got[ 0 ][ VALUE ].payload ).toContain( 'unauthorized' );
} );

test( 'instance authorize override allows a command without LOCAL', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const interpreter = new CommandInterpreterNode();
	interpreter.name = 'test_interpreter';
	interpreter.sink = sink;
	interpreter.authorize = () => true;
	interpreter.commands( { echo: () => 'ok' } );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ VALUE ] = { name: 'echo', arguments: '' };
	interpreter.fill( m );

	expect( got[ 0 ][ TYPE ] & TM_RESPONSE ).toBeTruthy();
	expect( got[ 0 ][ VALUE ].payload ).toBe( 'ok\n' );
} );

test( 'static defaultAuthorize can refuse even with LOCAL set', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	let ran = false;
	const interpreter = new CommandInterpreterNode();
	interpreter.name = 'test_interpreter';
	interpreter.sink = sink;
	interpreter.commands( {
		echo: () => {
			ran = true;
			return 'ok';
		},
	} );

	CommandInterpreterNode.defaultAuthorize = () => false;
	try {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ VALUE ] = { name: 'echo', arguments: '' };
		m[ LOCAL ] = true;
		interpreter.fill( m );
		expect( ran ).toBe( false );
		expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	} finally {
		CommandInterpreterNode.defaultAuthorize = null;
	}
} );

test( 'TM_NOREPLY command suppresses the routed reply on success', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	let ran = false;
	const interpreter = new CommandInterpreterNode();
	interpreter.name = 'test_interpreter';
	interpreter.sink = sink;
	interpreter.commands( {
		echo: () => {
			ran = true;
			return 'echoed';
		},
	} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_NOREPLY;
	m[ FROM ] = '_output/123';
	m[ VALUE ] = { name: 'echo', arguments: 'hi' };
	m[ LOCAL ] = true;
	interpreter.fill( m );

	// The verb still ran; the reply was suppressed (no console at boot).
	expect( ran ).toBe( true );
	expect( got ).toHaveLength( 0 );
} );

test( 'a structurally invalid command warns to stderr (classified, not silent)', () => {
	const warnSpy = jest
		.spyOn( console, 'warn' )
		.mockImplementation( () => {} );
	const interpreter = new CommandInterpreterNode();
	interpreter.name = 'test_interpreter';

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ VALUE ] = {}; // no `name` → invalid struct
	m[ LOCAL ] = true;
	interpreter.fill( m );

	expect( warnSpy ).toHaveBeenCalled();
	expect( warnSpy.mock.calls.at( -1 )[ 0 ] ).toContain( 'WARNING:' );
	expect( warnSpy.mock.calls.at( -1 )[ 0 ] ).toContain(
		'invalid command struct'
	);
	warnSpy.mockRestore();
} );

test( 'TM_NOREPLY command suppresses the reply but surfaces an error to stderr', () => {
	const warnSpy = jest
		.spyOn( console, 'warn' )
		.mockImplementation( () => {} );
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const interpreter = new CommandInterpreterNode();
	interpreter.name = 'test_interpreter';
	interpreter.sink = sink;
	interpreter.commands( {
		bad: () => {
			throw new Error( 'boom' );
		},
	} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND | TM_NOREPLY;
	m[ FROM ] = '_output/123';
	m[ VALUE ] = { name: 'bad', arguments: '' };
	m[ LOCAL ] = true;
	interpreter.fill( m );

	// No routed reply, but the error is visible in stderr (dmesg).
	expect( got ).toHaveLength( 0 );
	expect( warnSpy ).toHaveBeenCalled();
	expect( warnSpy.mock.calls.at( -1 )[ 0 ] ).toContain( 'boom' );
	expect( warnSpy.mock.calls.at( -1 )[ 0 ] ).toContain( 'ERROR:' );
	warnSpy.mockRestore();
} );

test( 'empty verb payload suppresses the routed response', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const interpreter = new CommandInterpreterNode();
	interpreter.name = 'test_interpreter';
	interpreter.sink = sink;
	interpreter.commands( { quiet: () => '' } );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ VALUE ] = { name: 'quiet', arguments: '' };
	m[ LOCAL ] = true;
	interpreter.fill( m );

	expect( got ).toHaveLength( 0 );
} );

test( 'malformed command struct (non-object VALUE) drops the message silently', () => {
	const warnSpy = jest
		.spyOn( console, 'warn' )
		.mockImplementation( () => {} );

	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const interpreter = new CommandInterpreterNode();
	interpreter.sink = sink;
	interpreter.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	// VALUE must be a { name, ... } object; a bare string is not a struct.
	m[ VALUE ] = 'not a command struct';
	interpreter.fill( m );
	expect( got ).toHaveLength( 0 );

	warnSpy.mockRestore();
} );

test( 'TM_PING with empty TO bounces back to FROM via sink', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const interpreter = new CommandInterpreterNode();
	interpreter.sink = sink;
	interpreter.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_PING;
	m[ FROM ] = 'caller';
	m[ VALUE ] = '1700000000.5'; // originating timestamp the caller diffs
	interpreter.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TYPE ] ).toBe( TM_PING );
	expect( got[ 0 ][ TO ] ).toBe( 'caller' );
	// PHP CommandInterpreter::fill leaves FROM untouched on the bounce.
	expect( got[ 0 ][ FROM ] ).toBe( 'caller' );
	expect( got[ 0 ][ VALUE ] ).toBe( '1700000000.5' ); // payload preserved
} );

test( 'TM_EOF with empty TO bounces back to FROM via sink', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const interpreter = new CommandInterpreterNode();
	interpreter.sink = sink;
	interpreter.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_EOF;
	m[ FROM ] = 'producer';
	interpreter.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TYPE ] ).toBe( TM_EOF );
	expect( got[ 0 ][ TO ] ).toBe( 'producer' );
} );

test( 'TM_PING with non-empty TO is forwarded as in-transit (no bounce)', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const interpreter = new CommandInterpreterNode();
	interpreter.sink = sink;
	interpreter.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_PING;
	m[ FROM ] = 'caller';
	m[ TO ] = 'somewhere/else'; // not addressed at us
	interpreter.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TO ] ).toBe( 'somewhere/else' ); // TO unchanged
} );

// Built-in verb table — 1:1 parity with PHP $C, dispatched + asserted directly.

import { TeeNode } from '../tee-node';

// Dispatch a built-in verb by name and return its raw result. Args are the
// pre-split token array the interpreter hands verbs; a string convenience is
// whitespace-tokenized here (verbs never re-split).
const dispatch = ( interpreter, name, args = [], envelope = {} ) => {
	let argv = args;
	if ( ! Array.isArray( args ) ) {
		const trimmed = String( args ).trim();
		argv = '' === trimmed ? [] : trimmed.split( /\s+/ );
	}
	return interpreter.commands()[ name ]( interpreter, argv, envelope );
};

describe( 'built-in verbs — defaults installed on every interpreter', () => {
	const makeInterpreter = () => {
		const interpreter = new CommandInterpreterNode();
		interpreter.name = '_command_interpreter';
		return interpreter;
	};

	it( 'a fresh interpreter ships the full PHP verb set (canonical + aliases)', () => {
		const interpreter = makeInterpreter();
		const cmds = interpreter.commands();
		for ( const verb of [
			'make_node',
			'make',
			'pwd',
			'set_sink',
			'connect_node',
			'connect',
			'disconnect_node',
			'disconnect',
			'remove_node',
			'remove',
			'rm',
			'list_nodes',
			'ls',
			'log',
			'dmesg',
			'dump_node',
			'dump',
			'dump_metadata',
			'stats',
			'uptime',
			'trace',
			'help',
		] ) {
			expect( typeof cmds[ verb ] ).toBe( 'function' );
		}
	} );

	it( 'commands( table ) merges over the built-ins, not replaces', () => {
		const interpreter = makeInterpreter();
		interpreter.commands( { custom: () => 'x' } );
		expect( typeof interpreter.commands().custom ).toBe( 'function' );
		expect( typeof interpreter.commands().ls ).toBe( 'function' );
	} );

	describe( 'pwd', () => {
		it( 'returns " <cwd> -> <from>" from args + envelope FROM', () => {
			const interpreter = makeInterpreter();
			const env = newMessage();
			env[ FROM ] = 'caller';
			expect( dispatch( interpreter, 'pwd', '/foo', env ) ).toBe(
				' /foo -> caller'
			);
		} );
		it( 'empty args yields the root cwd', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'pwd', '', newMessage() ) ).toBe(
				' / -> '
			);
		} );
	} );

	describe( 'set_sink', () => {
		it( 'points one node sink at another', () => {
			const interpreter = makeInterpreter();
			const a = new Node();
			a.name = 'a';
			const b = new Node();
			b.name = 'b';
			expect( dispatch( interpreter, 'set_sink', 'a b' ) ).toBe( 'ok' );
			expect( a.sink ).toBe( b );
		} );
		it( 'usage when an operand is missing', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'set_sink', 'a' ) ).toBe(
				'usage: set_sink <node> <target>'
			);
		} );
		it( 'reports unknown node', () => {
			const interpreter = makeInterpreter();
			new Node().name = 'a';
			expect( dispatch( interpreter, 'set_sink', 'a nope' ) ).toBe(
				'unknown node'
			);
		} );
	} );

	describe( 'connect_node / disconnect_node', () => {
		it( 'connects a Tee target', () => {
			const interpreter = makeInterpreter();
			const tee = new TeeNode();
			tee.name = 't';
			expect( dispatch( interpreter, 'connect_node', 't dest' ) ).toBe(
				'ok'
			);
			expect( tee.target ).toContain( 'dest' );
		} );
		it( 'defaults the target to the envelope FROM', () => {
			const interpreter = makeInterpreter();
			const tee = new TeeNode();
			tee.name = 't';
			const env = newMessage();
			env[ FROM ] = 'session';
			expect( dispatch( interpreter, 'connect_node', 't', env ) ).toBe(
				'ok'
			);
			expect( tee.target ).toContain( 'session' );
		} );
		it( 'connect usage when no target and no envelope FROM are available', () => {
			const interpreter = makeInterpreter();
			const tee = new TeeNode();
			tee.name = 't';
			expect( dispatch( interpreter, 'connect_node', 't' ) ).toBe(
				'usage: connect_node <node> [<target>]'
			);
		} );
		it( 'connects a non-Tee node by setting its string target (no crash)', () => {
			// Base connectNode sets a string target; Tee overrides to array.
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'plain';
			expect(
				dispatch( interpreter, 'connect_node', 'plain dest' )
			).toBe( 'ok' );
			expect( n.target ).toBe( 'dest' );
		} );
		it( 'connect usage with no node', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'connect_node', '' ) ).toBe(
				'usage: connect_node <node> [<target>]'
			);
		} );
		it( 'connect reports unknown node', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'connect_node', 'ghost x' ) ).toBe(
				'unknown node: ghost'
			);
		} );
		it( 'disconnect removes a Tee target', () => {
			const interpreter = makeInterpreter();
			const tee = new TeeNode();
			tee.name = 't';
			tee.connectNode( 'dest' );
			expect( dispatch( interpreter, 'disconnect_node', 't dest' ) ).toBe(
				'ok'
			);
			expect( tee.target ).not.toContain( 'dest' );
		} );
		it( 'disconnect defaults a Tee target to envelope FROM', () => {
			const interpreter = makeInterpreter();
			const tee = new TeeNode();
			tee.name = 't';
			tee.connectNode( 'session' );
			const env = newMessage();
			env[ FROM ] = 'session';
			expect( dispatch( interpreter, 'disconnect_node', 't', env ) ).toBe(
				'ok'
			);
			expect( tee.target ).toEqual( [] );
		} );
		it( 'disconnect usage when a Tee has no target and no envelope FROM', () => {
			const interpreter = makeInterpreter();
			const tee = new TeeNode();
			tee.name = 't';
			tee.connectNode( 'session' );
			expect( dispatch( interpreter, 'disconnect_node', 't' ) ).toBe(
				'usage: disconnect_node <node> [<target>]'
			);
		} );
		it( 'disconnect calls the node disconnectNode lifecycle method', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'plain';
			n.target = 'dest';
			const spy = jest.spyOn( n, 'disconnectNode' );
			expect(
				dispatch( interpreter, 'disconnect_node', 'plain dest' )
			).toBe( 'ok' );
			expect( spy ).toHaveBeenCalledWith( 'dest' );
			expect( n.target ).toBe( '' );
		} );
	} );

	describe( 'register / unregister', () => {
		it( 'wires target as a node-name listener for the event on source', () => {
			const interpreter = makeInterpreter();
			const src = new Node();
			src.name = 'src';
			src.registrations = { EVT: {} };
			new Node().name = 'tgt';
			expect( dispatch( interpreter, 'register', 'src tgt EVT' ) ).toBe(
				'ok'
			);
			expect( src.registeredListeners() ).toEqual( { EVT: [ 'tgt' ] } );
		} );
		it( 'register reports unknown source', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'register', 'ghost tgt EVT' ) ).toBe(
				'unknown node: ghost'
			);
		} );
		it( 'register reports unknown target', () => {
			const interpreter = makeInterpreter();
			const src = new Node();
			src.name = 'src';
			src.registrations = { EVT: {} };
			expect( dispatch( interpreter, 'register', 'src ghost EVT' ) ).toBe(
				'unknown node: ghost'
			);
		} );
		it( 'register usage with no source', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'register', '' ) ).toBe(
				'usage: register <source name> <target name> <event>'
			);
		} );
		it( 'register usage with no target', () => {
			const interpreter = makeInterpreter();
			new Node().name = 'src';
			expect( dispatch( interpreter, 'register', 'src' ) ).toBe(
				'usage: register <source name> <target name> <event>'
			);
		} );
		it( 'register on an undeclared event surfaces as a thrown error', () => {
			const interpreter = makeInterpreter();
			new Node().name = 'src';
			new Node().name = 'tgt';
			expect( () =>
				dispatch( interpreter, 'register', 'src tgt NOPE' )
			).toThrow( 'no such event: NOPE' );
		} );
		it( 'unregister removes a previously-registered listener', () => {
			const interpreter = makeInterpreter();
			const src = new Node();
			src.name = 'src';
			src.registrations = { EVT: {} };
			new Node().name = 'tgt';
			dispatch( interpreter, 'register', 'src tgt EVT' );
			expect( dispatch( interpreter, 'unregister', 'src tgt EVT' ) ).toBe(
				'ok'
			);
			expect( src.registeredListeners() ).toEqual( {} );
		} );
		it( 'unregister reports unknown source', () => {
			const interpreter = makeInterpreter();
			expect(
				dispatch( interpreter, 'unregister', 'ghost tgt EVT' )
			).toBe( 'unknown node: ghost' );
		} );
		it( 'unregister usage with no target', () => {
			const interpreter = makeInterpreter();
			new Node().name = 'src';
			expect( dispatch( interpreter, 'unregister', 'src' ) ).toBe(
				'usage: unregister <source name> <target name> <event>'
			);
		} );
	} );

	describe( 'remove_node', () => {
		it( 'unregisters a named node from Core', () => {
			const interpreter = makeInterpreter();
			new Node().name = 'gone';
			expect( dispatch( interpreter, 'remove_node', 'gone' ) ).toBe(
				'removed gone'
			);
			expect( Core.node( 'gone' ) ).toBeNull();
		} );
		it( 'calls the node removeNode lifecycle method (full teardown, not bare unregister)', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'gone';
			n.sink = new Node();
			const spy = jest.spyOn( n, 'removeNode' );
			expect( dispatch( interpreter, 'remove_node', 'gone' ) ).toBe(
				'removed gone'
			);
			expect( spy ).toHaveBeenCalledTimes( 1 );
			expect( n.sink ).toBeNull();
			expect( Core.node( 'gone' ) ).toBeNull();
		} );
		it( 'removes the interpreter itself (no safety rails — breaking the graph is a lesson)', () => {
			const interpreter = makeInterpreter();
			expect(
				dispatch( interpreter, 'remove_node', '_command_interpreter' )
			).toBe( 'removed _command_interpreter' );
			expect( Core.node( '_command_interpreter' ) ).toBeNull();
		} );
		it( 'removes formerly-protected scaffolding (_router/_output)', () => {
			const interpreter = makeInterpreter();
			new Node().name = '_router';
			new Node().name = '_output';
			expect( dispatch( interpreter, 'remove_node', '_router' ) ).toBe(
				'removed _router'
			);
			expect( Core.node( '_router' ) ).toBeNull();
			expect( dispatch( interpreter, 'remove_node', '_output' ) ).toBe(
				'removed _output'
			);
			expect( Core.node( '_output' ) ).toBeNull();
		} );
		it( 'reports an unknown node', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'remove_node', 'nope' ) ).toBe(
				'can\'t find node "nope"'
			);
		} );
		it( '-a removes by anchored regex', () => {
			const interpreter = makeInterpreter();
			new Node().name = 'worker_a';
			new Node().name = 'worker_b';
			const out = dispatch( interpreter, 'remove_node', '-a worker_.*' );
			expect( out ).toContain( 'removed worker_a' );
			expect( out ).toContain( 'removed worker_b' );
			expect( Core.node( 'worker_a' ) ).toBeNull();
		} );
		it( '-a with no regex returns usage', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'remove_node', '-a' ) ).toBe(
				'usage: remove_node -a <anchored regex glob>'
			);
		} );
		it( '-a reports no matches for valid regexes that match nothing', () => {
			const interpreter = makeInterpreter();
			expect(
				dispatch( interpreter, 'remove_node', '-a worker_.*' )
			).toBe( 'no matches' );
		} );
		it( 'usage on empty args', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'remove_node', '' ) ).toBe(
				'usage: remove_node <node name>'
			);
		} );
	} );

	describe( 'list_nodes / ls', () => {
		it( 'default lists sibling node names (sink === this interpreter)', () => {
			const interpreter = makeInterpreter();
			const a = new Node();
			a.name = 'a';
			a.sink = interpreter;
			const b = new Node();
			b.name = 'b';
			b.sink = interpreter;
			const orphan = new Node();
			orphan.name = 'orphan';
			const out = dispatch( interpreter, 'ls', '' );
			expect( out.split( '\n' ).sort() ).toEqual( [ 'a', 'b' ] );
		} );
		it( '-a lists all nodes', () => {
			const interpreter = makeInterpreter();
			new Node().name = 'x';
			const out = dispatch( interpreter, 'ls', '-a' );
			expect( out ).toContain( 'x' );
			expect( out ).toContain( '_command_interpreter' );
		} );
		it( '-c adds a COUNT column header', () => {
			const interpreter = makeInterpreter();
			const a = new Node();
			a.name = 'a';
			a.sink = interpreter;
			const out = dispatch( interpreter, 'ls', '-c' );
			expect( out ).toContain( 'COUNT' );
			expect( out ).toContain( 'NAME' );
		} );
		it( '-lst shows sink and target columns for string and array targets', () => {
			const interpreter = makeInterpreter();
			const sink = new Node();
			sink.name = 'sink';
			const a = new Node();
			a.name = 'a';
			a.sink = sink;
			a.target = 'one';
			const b = new TeeNode();
			b.name = 'b';
			b.sink = sink;
			b.target = [ 'two', 'three' ];
			const out = dispatch( interpreter, 'ls', '-alst' );
			expect( out ).toContain( 'SINK' );
			expect( out ).toContain( 'TARGET' );
			expect( out ).toContain( '> sink' );
			expect( out ).toContain( '-> one' );
			expect( out ).toContain( '-> two, three' );
		} );
		it( '-a with a regex reports no matches per glob', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'ls', '-a nope$' ) ).toContain(
				'no matches'
			);
		} );
		it( 'reports an unknown explicit node', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'ls', 'nope' ) ).toBe(
				'can\'t find node "nope"'
			);
		} );
	} );

	describe( 'reply_to', () => {
		it( 'runs the verb locally and routes its reply to the path', () => {
			const interpreter = makeInterpreter();
			const sink = new Node();
			const got = [];
			sink.fill = ( m ) => got.push( [ ...m ] );
			interpreter.sink = sink;
			dispatch( interpreter, 'reply_to', 'some/target uptime' );
			expect( got ).toHaveLength( 1 );
			expect( got[ 0 ][ TO ] ).toBe( 'some/target' );
			expect( got[ 0 ][ VALUE ].name ).toBe( 'uptime' );
		} );
		it( 'returns usage when no command is given', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'reply_to', 'some/target' ) ).toBe(
				'usage: reply_to <node path> <command>'
			);
		} );
		it( 'refuses to nest reply_to (no unbounded recursion)', () => {
			const interpreter = makeInterpreter();
			expect(
				dispatch( interpreter, 'reply_to', 'a reply_to a uptime' )
			).toBe( 'reply_to cannot invoke reply_to' );
		} );
	} );

	describe( 'log / dmesg', () => {
		it( 'log emits a prefixed, node-tagged line via the interpreter node stderr and returns empty', () => {
			const interpreter = makeInterpreter();
			const spy = jest
				.spyOn( console, 'warn' )
				.mockImplementation( () => {} );
			expect( dispatch( interpreter, 'log', 'hello' ) ).toBe( '' );
			expect( spy ).toHaveBeenCalled();
			expect( spy.mock.calls.at( -1 )[ 0 ] ).toMatch(
				/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC browser: .*hello$/
			);
			spy.mockRestore();
		} );
		it( 'dmesg returns a string', () => {
			const interpreter = makeInterpreter();
			expect( typeof dispatch( interpreter, 'dmesg', '' ) ).toBe(
				'string'
			);
		} );
		it( 'dmesg returns the buffered, prefixed recentLog tail joined (line-separated)', () => {
			const interpreter = makeInterpreter();
			const spy = jest
				.spyOn( console, 'warn' )
				.mockImplementation( () => {} );
			Core.stderr( 'one' );
			Core.stderr( 'two' );
			expect( dispatch( interpreter, 'dmesg', '' ) ).toMatch(
				/UTC browser: one\n.*UTC browser: two\n$/s
			);
			spy.mockRestore();
		} );
	} );

	describe( 'dump_node / dump', () => {
		it( 'returns a class-header + pretty-JSON string', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'd';
			const out = dispatch( interpreter, 'dump_node', 'd' );
			expect( out.startsWith( 'Node ' ) ).toBe( true );
			const body = JSON.parse( out.slice( 'Node '.length ) );
			expect( body.name ).toBe( 'd' );
			expect( body.class ).toBeUndefined(); // header, not a body key
		} );
		it( 'still shows a private with no public accessor', () => {
			// Hiding `_defaultSink` must not hide the internals an operator
			// reads at the REPL — a Dumper's ring, a Request's queue.
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'priv';
			n._ring = [ 'a', 'b' ];

			expect( dispatch( interpreter, 'dump_node', 'priv' ) ).toContain(
				'_ring'
			);
		} );

		it( 'does not expose the sink make_node recorded', () => {
			// `make_node` records the sink it wired so dump_config can tell an
			// implicit sink from a stated one. That is bookkeeping, not state
			// an operator inspects — and PHP's dump_node has no such row.
			const interpreter = makeInterpreter();
			dispatch( interpreter, 'make_node', 'Echo made' );

			const out = dispatch( interpreter, 'dump_node', 'made' );

			expect( out ).not.toContain( '_defaultSink' );
		} );

		it( 'includes the sink as the sink node name, and `dump <node> sink` works', () => {
			// PHP keeps `sink` as sink's name; requesting it must not error.
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'd';
			const downstream = new Node();
			downstream.name = 'downstream';
			n.sink = downstream;
			expect( dispatch( interpreter, 'dump_node', 'd' ) ).toContain(
				'"sink": "downstream"'
			);
			const filtered = dispatch( interpreter, 'dump_node', 'd sink' );
			expect( filtered ).toContain( '"sink": "downstream"' );
			expect( filtered ).not.toContain( "can't find key" );
		} );
		it( 'no node specified', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'dump_node', '' ) ).toBe(
				'no node specified'
			);
		} );
		it( 'unknown node', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'dump_node', 'nope' ) ).toBe(
				'can\'t find node "nope"'
			);
		} );
		it( 'masks the interpreter verb table and auth closure (non-node internals)', () => {
			// Interpreter masks its non-node internals (_commands, authorize).
			const interpreter = makeInterpreter();
			interpreter.name = 'ci';
			const out = dispatch( interpreter, 'dump_node', 'ci' );
			const body = JSON.parse( out.slice( out.indexOf( '{' ) ) );
			expect( body._commands ).toBe( '{...}' );
			expect( body.authorize ).toBe( '{...}' );
		} );

		it( 'key filter narrows the body, unknown key errors', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'd';
			const out = dispatch( interpreter, 'dump_node', 'd name' );
			const body = JSON.parse( out.slice( 'Node '.length ) );
			expect( Object.keys( body ) ).toEqual( [ 'name' ] );
			expect( dispatch( interpreter, 'dump_node', 'd bogus' ) ).toBe(
				'can\'t find key "bogus"'
			);
		} );
	} );

	describe( 'dump_metadata', () => {
		it( 'returns the per-node object the canvas parseMetadata expects', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'm';
			n.sink = interpreter;
			const meta = dispatch( interpreter, 'dump_metadata', '' );
			expect( meta.m ).toEqual(
				expect.objectContaining( {
					class: 'Node',
					counter: 0,
					sink: '_command_interpreter',
					target: '',
					debug_state: 0,
					arguments: [],
				} )
			);
		} );
		it( 'skips patron-linked plumbing nodes', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'plumb';
			n.patron = interpreter;
			const meta = dispatch( interpreter, 'dump_metadata', '' );
			expect( meta.plumb ).toBeUndefined();
		} );
	} );

	describe( 'stats', () => {
		it( 'tabulates sibling counters with the canonical header', () => {
			const interpreter = makeInterpreter();
			const a = new Node();
			a.name = 'a';
			a.sink = interpreter;
			const out = dispatch( interpreter, 'stats', '' );
			expect( out ).toContain( 'NAME' );
			expect( out ).toContain( 'COUNT' );
			expect( out ).toContain( 'LGST_MSG' );
			expect( out ).toContain( 'a' );
		} );
		it( '-a with an invalid regex yields just the header', () => {
			const interpreter = makeInterpreter();
			new Node().name = 'a';
			const out = dispatch( interpreter, 'stats', '-a [' );
			expect( out ).toContain( 'NAME' );
			expect( out ).not.toMatch( /\na\b/ );
		} );
	} );

	describe( 'uptime', () => {
		it( 'returns a clock + "up" string', () => {
			const interpreter = makeInterpreter();
			const out = dispatch( interpreter, 'uptime', '' );
			expect( out ).toMatch( /up/ );
		} );
		it( 'reports elapsed time since initTime that grows with the clock', () => {
			const interpreter = makeInterpreter();
			const nowSpy = jest.spyOn( Core, 'now' );

			// reset() captures initTime at 1000; advance the clock to 1090.
			nowSpy.mockReturnValue( 1000 );
			Core.reset();
			nowSpy.mockReturnValue( 1090 );

			expect( dispatch( interpreter, 'uptime', '' ) ).toMatch(
				/up 1m 30s/
			);

			// Advance further; elapsed must grow.
			nowSpy.mockReturnValue( 1000 + 3661 );
			expect( dispatch( interpreter, 'uptime', '' ) ).toMatch(
				/up 1h 01m/
			);

			nowSpy.mockRestore();
		} );
		it( 'formats day-scale uptime with a day count and clock remainder', () => {
			const interpreter = makeInterpreter();
			const nowSpy = jest.spyOn( Core, 'now' );
			nowSpy.mockReturnValue( 1000 );
			Core.reset();
			nowSpy.mockReturnValue( 1000 + 90061 );
			expect( dispatch( interpreter, 'uptime', '' ) ).toMatch(
				/up 1d 01:01:01/
			);
			nowSpy.mockRestore();
		} );
	} );

	// The verb is `trace` (renamed from `debug_state`); the reply strings still
	// report the underlying `debug_state` node property, which is unchanged.
	describe( 'trace (formerly debug_state)', () => {
		it( 'the old `debug_state` verb name no longer resolves', () => {
			const interpreter = makeInterpreter();
			expect( () => interpreter.dispatch( 'debug_state' ) ).toThrow(
				'unknown command: debug_state'
			);
		} );
		it( 'no args toggles this interpreter', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'trace', '' ) ).toBe(
				'_command_interpreter debug_state: 1'
			);
			expect( dispatch( interpreter, 'trace', '' ) ).toBe(
				'_command_interpreter debug_state: 0'
			);
		} );
		it( 'numeric arg sets this interpreter', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'trace', '3' ) ).toBe(
				'_command_interpreter debug_state: 3'
			);
		} );
		it( 'name + level sets that node', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'n';
			expect( dispatch( interpreter, 'trace', 'n 2' ) ).toBe(
				'n debug_state: 2'
			);
			expect( n.debugState ).toBe( 2 );
		} );
		it( 'name without level toggles that node', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'n';
			expect( dispatch( interpreter, 'trace', 'n' ) ).toBe(
				'n debug_state: 1'
			);
			expect( dispatch( interpreter, 'trace', 'n' ) ).toBe(
				'n debug_state: 0'
			);
		} );
		it( '* sets every node and returns a terse summary, not a per-node roster', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'n';
			// Level 2 (distinct from the toggle default 1) over 2 nodes.
			const out = dispatch( interpreter, 'trace', '* 2' );
			expect( out ).toBe( 'debug_state 2 on 2 nodes' );
			expect( out ).not.toContain( 'n debug_state' );
			expect( interpreter.debugState ).toBe( 2 );
			expect( n.debugState ).toBe( 2 );
		} );
		it( 'unknown node errors', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'trace', 'nope' ) ).toBe(
				'unknown node: nope'
			);
		} );
	} );

	describe( 'help', () => {
		it( 'no topic lists the unified commands section', () => {
			const interpreter = makeInterpreter();
			const out = dispatch( interpreter, 'help', '' );
			expect( out ).toContain( '### COMMANDS ###' );
			expect( out ).toContain( 'make_node' );
		} );
		it( 'a topic returns that command help (alias resolves)', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'help', 'ls' ) ).toContain(
				'list_nodes'
			);
		} );
		it( 'a class topic renders its nodeSchema exactly like PHP help', () => {
			const interpreter = makeInterpreter();
			CommandInterpreterNode.includeNodes.SchemaProbe = class extends (
				Node
			) {
				static nodeSchema() {
					return {
						category: 'Diagnostics',
						description: 'Inspects non-default widgets.',
						accepts_fill: false,
						has_target: true,
						arguments: [
							{
								name: 'source_endpoint',
								type: 'string',
								required: true,
								description: 'Distinct source.',
							},
							{
								name: 'retry_budget',
								type: 'int',
								default: 37,
								description: 'Distinct retry budget.',
							},
							{
								name: 'labels',
								type: 'array',
								default: [ 'non-default' ],
								description: 'Labels.',
							},
						],
						commands: [
							{ name: 'probe', description: 'Inspect state.' },
						],
						requests: [
							{ name: 'snapshot', description: 'Read snapshot.' },
						],
						registrations: [ 'non_default_event', 'other_event' ],
					};
				}
			};
			try {
				expect( dispatch( interpreter, 'help', 'SchemaProbe' ) ).toBe(
					[
						'### SchemaProbe — Diagnostics ###',
						'Inspects non-default widgets.',
						'accepts_fill=false  has_target=true',
						'ARGUMENTS',
						'source_endpoint string required Distinct source.',
						'retry_budget    int    =37      Distinct retry budget.',
						'labels          array  =[]      Labels.',
						'COMMANDS',
						'probe Inspect state.',
						'REQUESTS',
						'snapshot Read snapshot.',
						'REGISTRATIONS: non_default_event, other_event',
					].join( '\n' )
				);
			} finally {
				delete CommandInterpreterNode.includeNodes.SchemaProbe;
			}
		} );
		it( 'renders the CommandInterpreter schema with PHP parity', () => {
			const interpreter = makeInterpreter();
			expect(
				dispatch( interpreter, 'help', 'CommandInterpreter' )
			).toBe(
				[
					'### CommandInterpreter — Hidden ###',
					'Command dispatch — placed implicitly as sibling of patron nodes; not draggable.',
					'accepts_fill=false  has_target=false',
				].join( '\n' )
			);
		} );
		it( 'does not expose inherited object properties as node classes', () => {
			const interpreter = makeInterpreter();
			for ( const topic of [ 'constructor', 'toString', '__proto__' ] ) {
				expect( dispatch( interpreter, 'help', topic ) ).toBe(
					`no such topic: "${ topic }"`
				);
			}
		} );
		it( 'an unknown topic errors', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'help', 'zzz' ) ).toBe(
				'no such topic: "zzz"'
			);
		} );
	} );

	describe( 'completion (KEY=completion bare-list mode)', () => {
		const completionEnv = () => {
			const env = newMessage();
			env[ KEY ] = 'completion';
			return env;
		};

		it( 'help with KEY=completion returns bare sorted verb names, no help text', () => {
			const interpreter = makeInterpreter();
			const out = dispatch( interpreter, 'help', '', completionEnv() );
			const lines = out.split( '\n' );
			// Bare verb names, one per line — sorted, no section headers.
			expect( lines ).toContain( 'list_nodes' );
			expect( lines ).toContain( 'make_node' );
			expect( lines ).toContain( 'help' );
			// Aliases are typeable too, so completion offers them.
			expect( lines ).toContain( 'ls' );
			expect( lines ).toContain( 'rm' );
			expect( lines ).toContain( 'make' );
			expect( out ).not.toContain( '###' );
			expect( out ).not.toContain( 'SERVER COMMANDS' );
			expect( out ).not.toContain( 'TM_PING' );
			// Sorted.
			expect( [ ...lines ].sort() ).toEqual( lines );
		} );

		it( 'help WITHOUT the completion key returns the full tabulated help, one section', () => {
			const interpreter = makeInterpreter();
			const out = dispatch( interpreter, 'help', '' );
			// One unified section; the old SHELL BUILTINS list is folded in.
			expect( out ).toContain( '### COMMANDS ###' );
			expect( out ).not.toContain( '### SHELL BUILTINS ###' );
			// Shell builtins now appear in the single command table.
			expect( out ).toContain( 'send_struct' );
			expect( out ).toContain( 'debug_level' );
		} );

		it( 'ls with KEY=completion returns all bare node names (like -a), no columns', () => {
			const interpreter = makeInterpreter();
			const a = new Node();
			a.name = 'a';
			a.sink = interpreter;
			const b = new Node();
			b.name = 'b';
			b.sink = interpreter;
			const out = dispatch( interpreter, 'ls', '-c', completionEnv() );
			const lines = out.split( '\n' );
			expect( lines ).toContain( 'a' );
			expect( lines ).toContain( 'b' );
			expect( lines ).toContain( '_command_interpreter' );
			expect( out ).not.toContain( 'COUNT' );
			expect( out ).not.toContain( 'NAME' );
		} );

		it( 'ls -a with KEY=completion returns all bare node names', () => {
			const interpreter = makeInterpreter();
			new Node().name = 'x';
			const out = dispatch( interpreter, 'ls', '-a', completionEnv() );
			const lines = out.split( '\n' );
			expect( lines ).toContain( 'x' );
			expect( lines ).toContain( '_command_interpreter' );
			expect( out ).not.toContain( 'NAME' );
		} );

		it( 'ls WITHOUT the completion key is unchanged', () => {
			const interpreter = makeInterpreter();
			const a = new Node();
			a.name = 'a';
			a.sink = interpreter;
			const out = dispatch( interpreter, 'ls', '-c' );
			expect( out ).toContain( 'COUNT' );
			expect( out ).toContain( 'NAME' );
		} );
	} );

	describe( 'make_node (constructs in-browser, mirrors PHP)', () => {
		// Mirrors PHP make_node: split args, spread trailing tokens to ctor.
		it( 'constructs a registered type, names it, and sinks it into the interpreter', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'make_node', 'Tee mytee' ) ).toBe(
				'ok'
			);
			const node = Core.node( 'mytee' );
			expect( node ).toBeInstanceOf( TeeNode );
			expect( node.sink ).toBe( interpreter );
		} );

		it( 'resolves the base Node type', () => {
			const interpreter = makeInterpreter();
			dispatch( interpreter, 'make_node', 'Node n' );
			expect( Core.node( 'n' ) ).toBeInstanceOf( Node );
		} );

		it( 'requires both a type and a name (PHP needs ≥2 parts)', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'make_node', 'Tee' ) ).toMatch(
				/usage/i
			);
			expect( Core.node( 'Tee' ) ).toBeNull();
		} );

		it( 'feeds trailing tokens to the arguments setter as a token array (no implicit walk)', () => {
			// A node that skips parseSchemaArgs gets the raw tokens, no walk.
			const interpreter = makeInterpreter();
			CommandInterpreterNode.includeNodes.ArgSpy = class extends Node {
				constructor() {
					super();
					this.alpha_field = '';
				}
				static nodeSchema() {
					return {
						arguments: [ { name: 'alpha_field', type: 'string' } ],
						commands: [],
					};
				}
			};
			dispatch( interpreter, 'make_node', 'ArgSpy s alpha beta' );
			const node = Core.node( 's' );
			expect( node.arguments ).toEqual( [ 'alpha', 'beta' ] );
			expect( node.alpha_field ).toBe( '' );
			delete CommandInterpreterNode.includeNodes.ArgSpy;
		} );

		it( 'a node that opts into parseSchemaArgs gets its positional config walked', () => {
			// Schema_Reflection path: opt-in setter assigns declared props.
			const interpreter = makeInterpreter();
			CommandInterpreterNode.includeNodes.ArgWalk = class extends Node {
				constructor() {
					super();
					this.alpha_field = '';
					this.beta_field = '';
				}
				get arguments() {
					return super.arguments;
				}
				set arguments( value ) {
					super.arguments = value;
					parseSchemaArgs( this, value );
				}
				static nodeSchema() {
					return {
						arguments: [
							{ name: 'alpha_field', type: 'string' },
							{ name: 'beta_field', type: 'string' },
						],
						commands: [],
					};
				}
			};
			dispatch( interpreter, 'make_node', 'ArgWalk w alpha beta' );
			const node = Core.node( 'w' );
			expect( node.arguments ).toEqual( [ 'alpha', 'beta' ] );
			expect( node.alpha_field ).toBe( 'alpha' );
			expect( node.beta_field ).toBe( 'beta' );
			delete CommandInterpreterNode.includeNodes.ArgWalk;
		} );

		it( 'returns "unknown class" for an unregistered type and builds nothing', () => {
			const interpreter = makeInterpreter();
			const out = dispatch( interpreter, 'make_node', 'Nope x' );
			expect( out ).toMatch( /unknown class/i );
			expect( Core.node( 'x' ) ).toBeNull();
		} );

		it( 'lets a name collision throw (no pre-check; interpret() wraps it)', () => {
			const interpreter = makeInterpreter();
			dispatch( interpreter, 'make_node', 'Tee dup' );
			expect( () =>
				dispatch( interpreter, 'make_node', 'Node dup' )
			).toThrow( /collision/i );
		} );
	} );

	describe( 'makeNode() (public programmatic graph construction)', () => {
		it( 'creates a registered class, names + sinks it, and returns the node', () => {
			const interp = makeInterpreter();
			const tee = interp.makeNode( 'Tee', 'mytee' );
			expect( Core.node( 'mytee' ) ).toBe( tee );
			expect( tee ).toBeInstanceOf( TeeNode );
			expect( tee.sink ).toBe( interp );
		} );

		it( 'throws unknown class for an unregistered type', () => {
			const interp = makeInterpreter();
			expect( () => interp.makeNode( 'Nope', 'x' ) ).toThrow(
				/unknown class/i
			);
			expect( Core.node( 'x' ) ).toBeNull();
		} );

		it( 'rejects inherited object properties as unregistered types', () => {
			const interp = makeInterpreter();
			for ( const type of [ 'constructor', 'toString', '__proto__' ] ) {
				expect( () =>
					interp.makeNode( type, `prototype-${ type }` )
				).toThrow( `unknown class: ${ type }` );
				expect( Core.node( `prototype-${ type }` ) ).toBeNull();
			}
		} );

		it( 'feeds trailing args through the arguments setter', () => {
			const interp = makeInterpreter();
			const node = interp.makeNode( 'Tee', 't', [ 'a', 'b' ] );
			expect( node.arguments ).toEqual( [ 'a', 'b' ] );
		} );

		it( 'inherits the interpreter debug state for newly-made nodes', () => {
			const interp = makeInterpreter();
			interp.debugState = 3;
			const node = interp.makeNode( 'Tee', 'debugtee' );
			expect( node.debugState ).toBe( 3 );
		} );

		it( '_cmdMakeNode delegates to makeNode (still names + sinks)', () => {
			const interp = makeInterpreter();
			expect( dispatch( interp, 'make_node', 'Tee delegated' ) ).toBe(
				'ok'
			);
			const node = Core.node( 'delegated' );
			expect( node ).toBeInstanceOf( TeeNode );
			expect( node.sink ).toBe( interp );
		} );
	} );

	describe( 'includeNodes substrate registry', () => {
		it( 'registers every substrate node class for make_node', () => {
			for ( const t of [
				'Dumper',
				'Completion',
				'Metadata',
				'Uptime',
				'SseIn',
				'HttpOut',
				'Heartbeat',
			] ) {
				expect(
					CommandInterpreterNode.includeNodes[ t ]
				).toBeDefined();
			}
		} );

		it( 'registerNodeClasses merges plugin classes into includeNodes', () => {
			class FooNode extends Node {}
			CommandInterpreterNode.registerNodeClasses( { Foo: FooNode } );
			try {
				expect( CommandInterpreterNode.includeNodes.Foo ).toBe(
					FooNode
				);
				// Existing substrate entries survive the merge.
				expect( CommandInterpreterNode.includeNodes.Tee ).toBe(
					TeeNode
				);
			} finally {
				delete CommandInterpreterNode.includeNodes.Foo;
			}
		} );
	} );

	describe( 'dump_config (mirrors PHP)', () => {
		it( 'emits a make_node line carrying the arguments', () => {
			const interpreter = makeInterpreter();
			dispatch( interpreter, 'make_node', 'Tee t a b' );
			expect( dispatch( interpreter, 'dump_config' ) ).toContain(
				'make_node Tee t a b'
			);
		} );

		it( 'omits nodes with a patron set (the patron recreates them)', () => {
			const interpreter = makeInterpreter();
			dispatch( interpreter, 'make_node', 'Tee owner' );
			dispatch( interpreter, 'make_node', 'Tee sidecar' );
			Core.node( 'sidecar' ).patron = Core.node( 'owner' );
			const out = dispatch( interpreter, 'dump_config' );
			expect( out ).toContain( 'make_node Tee owner' );
			expect( out ).not.toContain( 'sidecar' );
		} );

		it( 'emits set_sink only when the sink is not the interpreter', () => {
			const interpreter = makeInterpreter();
			dispatch( interpreter, 'make_node', 'Tee a' );
			dispatch( interpreter, 'make_node', 'Node b' );
			dispatch( interpreter, 'set_sink', 'a b' );
			const out = dispatch( interpreter, 'dump_config' );
			expect( out ).toContain( 'set_sink a b' );
			// `b` sinks into the interpreter by default → no set_sink line.
			expect( out ).not.toContain( 'set_sink b' );
		} );

		it( 'emits connect_node for a target', () => {
			const interpreter = makeInterpreter();
			dispatch( interpreter, 'make_node', 'Tee a' );
			dispatch( interpreter, 'connect_node', 'a dest' );
			expect( dispatch( interpreter, 'dump_config' ) ).toContain(
				'connect_node a dest'
			);
		} );

		it( 'skips only the backbone (_command_interpreter / _router)', () => {
			const interpreter = makeInterpreter();
			new Node().name = '_router';
			const out = dispatch( interpreter, 'dump_config' );
			expect( out ).not.toContain( '_command_interpreter' );
			expect( out ).not.toContain( '_router' );
		} );

		it( 'dumps _output (a real node, no longer skipped scaffolding)', () => {
			const interpreter = makeInterpreter();
			new Node().name = '_output';
			expect( dispatch( interpreter, 'dump_config' ) ).toContain(
				'_output'
			);
		} );

		it( 'filters node names by a regex glob argument (mirrors PHP)', () => {
			const interpreter = makeInterpreter();
			dispatch( interpreter, 'make_node', 'Tee alpha' );
			dispatch( interpreter, 'make_node', 'Tee beta' );
			const out = dispatch( interpreter, 'dump_config', 'alph' );
			expect( out ).toContain( 'make_node Tee alpha' );
			expect( out ).not.toContain( 'beta' );
		} );

		it( 'a malformed glob matches nothing (empty dump), not a throw', () => {
			const interpreter = makeInterpreter();
			dispatch( interpreter, 'make_node', 'Tee alpha' );
			// PHP: a bad pattern preg_matches false → matches nothing.
			expect( dispatch( interpreter, 'dump_config', '(' ) ).toBe( '' );
		} );
	} );

	describe( 'dispatch / table helpers', () => {
		it( 'dispatch throws for unknown command names', () => {
			const interpreter = makeInterpreter();
			expect( () => interpreter.dispatch( 'nope' ) ).toThrow(
				'unknown command: nope'
			);
		} );

		it( '_tabulate ignores cells beyond the declared column count', () => {
			expect(
				CommandInterpreterNode._tabulate(
					[ 'left' ],
					[ 'ONLY' ],
					[ [ 'value', 'extra' ] ]
				)
			).toBe( 'ONLY\nvalue' );
		} );

		it( 'dump_node skips function-valued node fields', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.name = 'd';
			n.helper = () => 'skip me';
			const out = dispatch( interpreter, 'dump_node', 'd' );
			expect( out ).not.toContain( 'helper' );
		} );
	} );
} );

describe( 'list_timers / list_handles introspection verbs', () => {
	test( 'list_timers lists active + inactive timers with an ACTIVE column', () => {
		const timer = new TimerNode();
		timer.name = 'tick0';
		timer.setTimer( 250 );
		const idle = new TimerNode(); // never armed -> inactive
		idle.name = 'idle0';

		const out = dispatch( new CommandInterpreterNode(), 'list_timers' );
		timer.stopTimer();

		expect( out ).toContain( 'ACTIVE' );
		expect( out ).toContain( 'FIRES' );
		expect( out ).toContain( 'tick0' );
		expect( out ).toContain( '250' );
		expect( out ).toContain( 'idle0' );
		expect( out ).toContain( 'no' );
	} );

	test( 'list_handles lists nodes holding an EventSource', () => {
		const sse = new SseInNode();
		sse.name = 'sse0';
		sse._es = { readyState: 1 }; // fake OPEN EventSource

		const out = dispatch( new CommandInterpreterNode(), 'list_handles' );

		expect( out ).toContain( 'sse0' );
		expect( out ).toContain( 'COUNT' );
	} );

	test( 'list_timers -s and list_handles -s return the text tables as keyed rows', () => {
		const timer = new TimerNode();
		timer.name = 'tick0';
		timer.setTimer( 250 ); // own-slot: distinct interval, active
		const sse = new SseInNode();
		sse.name = 'sse0';
		sse._es = { readyState: 1 }; // OPEN

		const ci = new CommandInterpreterNode();
		const timers = dispatch( ci, 'list_timers', [ '-s' ] );
		const handles = dispatch( ci, 'list_handles', [ '-s' ] );
		timer.stopTimer();

		const tick = timers.find( ( r ) => r.name === 'tick0' );
		expect( Object.keys( tick ) ).toEqual( [
			'id',
			'active',
			'interval_ms',
			'mode',
			'next_ms',
			'oneshot',
			'fires',
			'type',
			'name',
		] );
		expect( tick.active ).toBe( true );
		expect( tick.interval_ms ).toBe( 250 );
		expect( tick.mode ).toBe( 'event_framework' );
		expect( tick.next_ms ).toBeNull(); // browser has no event-framework next-fire clock
		expect( tick.oneshot ).toBe( false );
		expect( tick.type ).toBe( 'TimerNode' );

		expect( handles ).toHaveLength( 1 );
		expect( Object.keys( handles[ 0 ] ) ).toEqual( [
			'id',
			'count',
			'type',
			'name',
		] );
		expect( handles[ 0 ].name ).toBe( 'sse0' );
		expect( handles[ 0 ].id ).toBe( 'OPEN' ); // EventSource readyState label
	} );

	test( 'list_timers -s and the text table are the same rows', () => {
		const timer = new TimerNode();
		timer.name = 'tick0';
		timer.setTimer( 250 );

		const ci = new CommandInterpreterNode();
		const text = dispatch( ci, 'list_timers' );
		const rows = dispatch( ci, 'list_timers', [ '-s' ] );
		timer.stopTimer();

		// Every struct row's NAME appears in the rendered table, and the header
		// names the same facts — one source, two renderings.
		for ( const row of rows ) {
			expect( text ).toContain( row.name );
		}
		expect( text ).toContain( '250' );
	} );

	test( 'list_profiles -s is null-free when profiling is off', () => {
		const router = new RouterNode();
		router.name = '_router';
		router.stopTimer();
		RouterNode.profiles( null );
		const rows = dispatch( new CommandInterpreterNode(), 'list_profiles', [
			'-s',
		] );

		// No profiles: just the --total-- row, all zeroes — never null, so a
		// view renders an empty table rather than guarding every field.
		expect( rows ).toHaveLength( 1 );
		expect( rows[ 0 ].what ).toBe( '--total--' );
		expect( rows[ 0 ].count ).toBe( 0 );
	} );
} );
