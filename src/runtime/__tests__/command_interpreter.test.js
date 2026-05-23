import { CommandInterpreter } from '../command_interpreter';
import { Node } from '../node';
import { Core } from '../core';
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
	newMessage,
} from '../message';

beforeEach( () => Core.reset() );

test( 'non-TM_COMMAND message passes straight through to sink', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ VALUE ] = 'pass';
	ci.fill( m );
	expect( got ).toHaveLength( 1 );
} );

test( 'TM_COMMAND with non-empty TO is forwarded to sink (in transit)', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ TO ] = 'downstream';
	ci.fill( m );
	expect( got ).toHaveLength( 1 );
} );

test( 'TM_COMMAND with empty TO dispatches the named verb', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.setName( 'test_ci' );
	ci.sink = sink;
	ci.commands( {
		echo: ( self, args ) => `echoed: ${ args }`,
	} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ ID ] = 'cmd-1';
	m[ KEY ] = 'gui:typed';
	// VALUE carries the structured command object directly — no inner JSON layer.
	m[ VALUE ] = {
		name: 'echo',
		arguments: 'hi',
		payload: '',
	};
	m[ LOCAL ] = true; // in-process command — carries the provenance taint
	ci.fill( m );

	expect( got ).toHaveLength( 1 );
	// eslint-disable-next-line no-bitwise
	expect( got[ 0 ][ TYPE ] & TM_RESPONSE ).toBeTruthy();
	expect( got[ 0 ][ TO ] ).toBe( 'caller' );
	expect( got[ 0 ][ ID ] ).toBe( 'cmd-1' );
	expect( got[ 0 ][ KEY ] ).toBe( 'gui:typed' );
	// Response VALUE is the { name, payload } object itself, not a JSON string.
	expect( got[ 0 ][ VALUE ] ).toEqual( {
		name: 'echo',
		payload: 'echoed: hi',
	} );
} );

test( 'verb throwing returns TM_COMMAND|TM_ERROR with the message', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.setName( 'test_ci' );
	ci.sink = sink;
	ci.commands( {
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
		payload: '',
	};
	m[ LOCAL ] = true;
	ci.fill( m );

	expect( got ).toHaveLength( 1 );
	// eslint-disable-next-line no-bitwise
	expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	expect( got[ 0 ][ VALUE ].payload ).toBe( 'boom' );
} );

test( 'command without LOCAL provenance is refused (unauthorized), verb not run', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	let ran = false;
	const ci = new CommandInterpreter();
	ci.setName( 'test_ci' );
	ci.sink = sink;
	ci.commands( {
		echo: () => {
			ran = true;
			return 'ok';
		},
	} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ FROM ] = 'caller';
	m[ VALUE ] = { name: 'echo', arguments: '', payload: '' };
	// No LOCAL — an injected/off-process command.
	ci.fill( m );

	expect( ran ).toBe( false );
	expect( got ).toHaveLength( 1 );
	// eslint-disable-next-line no-bitwise
	expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	expect( got[ 0 ][ VALUE ].payload ).toContain( 'unauthorized' );
} );

test( 'instance authorize override allows a command without LOCAL', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.setName( 'test_ci' );
	ci.sink = sink;
	ci.authorize = () => true;
	ci.commands( { echo: () => 'ok' } );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ VALUE ] = { name: 'echo', arguments: '', payload: '' };
	ci.fill( m );

	// eslint-disable-next-line no-bitwise
	expect( got[ 0 ][ TYPE ] & TM_RESPONSE ).toBeTruthy();
	expect( got[ 0 ][ VALUE ].payload ).toBe( 'ok' );
} );

test( 'static defaultAuthorize can refuse even with LOCAL set', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	let ran = false;
	const ci = new CommandInterpreter();
	ci.setName( 'test_ci' );
	ci.sink = sink;
	ci.commands( {
		echo: () => {
			ran = true;
			return 'ok';
		},
	} );

	CommandInterpreter.defaultAuthorize = () => false;
	try {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ VALUE ] = { name: 'echo', arguments: '', payload: '' };
		m[ LOCAL ] = true;
		ci.fill( m );
		expect( ran ).toBe( false );
		// eslint-disable-next-line no-bitwise
		expect( got[ 0 ][ TYPE ] & TM_ERROR ).toBeTruthy();
	} finally {
		CommandInterpreter.defaultAuthorize = null;
	}
} );

test( 'malformed command struct (non-object VALUE) drops the message silently', () => {
	const warnSpy = jest
		.spyOn( console, 'warn' )
		.mockImplementation( () => {} );

	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	// VALUE must be a { name, ... } object; a bare string is not a command struct.
	m[ VALUE ] = 'not a command struct';
	ci.fill( m );
	expect( got ).toHaveLength( 0 );

	warnSpy.mockRestore();
} );

test( 'TM_PING with empty TO bounces back to FROM via sink', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_PING;
	m[ FROM ] = 'caller';
	m[ VALUE ] = '1700000000.5'; // originating timestamp the caller will diff against
	ci.fill( m );

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

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_EOF;
	m[ FROM ] = 'producer';
	ci.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TYPE ] ).toBe( TM_EOF );
	expect( got[ 0 ][ TO ] ).toBe( 'producer' );
} );

test( 'TM_PING with non-empty TO is forwarded as in-transit (no bounce)', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	const ci = new CommandInterpreter();
	ci.sink = sink;
	ci.commands( {} );

	const m = newMessage();
	m[ TYPE ] = TM_PING;
	m[ FROM ] = 'caller';
	m[ TO ] = 'somewhere/else'; // not addressed at us
	ci.fill( m );

	expect( got ).toHaveLength( 1 );
	expect( got[ 0 ][ TO ] ).toBe( 'somewhere/else' ); // TO unchanged
} );

// ---------------------------------------------------------------------------
// Built-in verb table (1:1 parity with PHP CommandInterpreter $C). Each verb is
// dispatched directly (no envelope plumbing) and asserted on its return value.
// ---------------------------------------------------------------------------

import { Tee } from '../tee';

// Dispatch a built-in verb by name and return its raw result.
const dispatch = ( ci, name, args = '', envelope = {} ) =>
	ci.commands()[ name ]( ci, args, envelope );

describe( 'built-in verbs — defaults installed on every CI', () => {
	const makeCi = () => {
		const ci = new CommandInterpreter();
		ci.setName( '_command_interpreter' );
		return ci;
	};

	it( 'a fresh CI ships the full PHP verb set (canonical + aliases)', () => {
		const ci = makeCi();
		const cmds = ci.commands();
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
			'dump_config',
			'dump_metadata',
			'stats',
			'uptime',
			'debug_state',
			'help',
		] ) {
			expect( typeof cmds[ verb ] ).toBe( 'function' );
		}
	} );

	it( 'commands( table ) merges over the built-ins, not replaces', () => {
		const ci = makeCi();
		ci.commands( { custom: () => 'x' } );
		expect( typeof ci.commands().custom ).toBe( 'function' );
		expect( typeof ci.commands().ls ).toBe( 'function' );
	} );

	describe( 'pwd', () => {
		it( 'returns " <cwd> -> <from>" from args + envelope FROM', () => {
			const ci = makeCi();
			const env = newMessage();
			env[ FROM ] = 'caller';
			expect( dispatch( ci, 'pwd', '/foo', env ) ).toBe(
				' /foo -> caller'
			);
		} );
		it( 'empty args yields the root cwd', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'pwd', '', newMessage() ) ).toBe( ' / -> ' );
		} );
	} );

	describe( 'set_sink', () => {
		it( 'points one node sink at another', () => {
			const ci = makeCi();
			const a = new Node();
			a.setName( 'a' );
			const b = new Node();
			b.setName( 'b' );
			expect( dispatch( ci, 'set_sink', 'a b' ) ).toBe( 'ok' );
			expect( a.sink ).toBe( b );
		} );
		it( 'usage when an operand is missing', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'set_sink', 'a' ) ).toBe(
				'usage: set_sink <node> <target>'
			);
		} );
		it( 'reports unknown node', () => {
			const ci = makeCi();
			new Node().setName( 'a' );
			expect( dispatch( ci, 'set_sink', 'a nope' ) ).toBe(
				'unknown node'
			);
		} );
	} );

	describe( 'connect_node / disconnect_node', () => {
		it( 'connects a Tee target', () => {
			const ci = makeCi();
			const tee = new Tee();
			tee.setName( 't' );
			expect( dispatch( ci, 'connect_node', 't dest' ) ).toBe( 'ok' );
			expect( tee.target ).toContain( 'dest' );
		} );
		it( 'defaults the target to the envelope FROM', () => {
			const ci = makeCi();
			const tee = new Tee();
			tee.setName( 't' );
			const env = newMessage();
			env[ FROM ] = 'session';
			expect( dispatch( ci, 'connect_node', 't', env ) ).toBe( 'ok' );
			expect( tee.target ).toContain( 'session' );
		} );
		it( 'connects a non-Tee node by setting its string target (no crash)', () => {
			// Base Node has no connectNode (only Tee does); the verb must fall back
			// to setting a single string target — matching PHP Node::connect_node.
			const ci = makeCi();
			const n = new Node();
			n.setName( 'plain' );
			expect( dispatch( ci, 'connect_node', 'plain dest' ) ).toBe( 'ok' );
			expect( n.target ).toBe( 'dest' );
		} );
		it( 'connect usage with no node', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'connect_node', '' ) ).toBe(
				'usage: connect_node <node> [<target>]'
			);
		} );
		it( 'connect reports unknown node', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'connect_node', 'ghost x' ) ).toBe(
				'unknown node: ghost'
			);
		} );
		it( 'disconnect removes a Tee target', () => {
			const ci = makeCi();
			const tee = new Tee();
			tee.setName( 't' );
			tee.connectNode( 'dest' );
			expect( dispatch( ci, 'disconnect_node', 't dest' ) ).toBe( 'ok' );
			expect( tee.target ).not.toContain( 'dest' );
		} );
		it( 'disconnect calls the node disconnectNode lifecycle method', () => {
			const ci = makeCi();
			const n = new Node();
			n.setName( 'plain' );
			n.target = 'dest';
			const spy = jest.spyOn( n, 'disconnectNode' );
			expect( dispatch( ci, 'disconnect_node', 'plain dest' ) ).toBe(
				'ok'
			);
			expect( spy ).toHaveBeenCalledWith( 'dest' );
			expect( n.target ).toBe( '' );
		} );
	} );

	describe( 'remove_node', () => {
		it( 'unregisters a named node from Core', () => {
			const ci = makeCi();
			new Node().setName( 'gone' );
			expect( dispatch( ci, 'remove_node', 'gone' ) ).toBe(
				'removed gone'
			);
			expect( Core.node( 'gone' ) ).toBeNull();
		} );
		it( 'calls the node removeNode lifecycle method (full teardown, not bare unregister)', () => {
			const ci = makeCi();
			const n = new Node();
			n.setName( 'gone' );
			n.sink = new Node();
			const spy = jest.spyOn( n, 'removeNode' );
			expect( dispatch( ci, 'remove_node', 'gone' ) ).toBe(
				'removed gone'
			);
			expect( spy ).toHaveBeenCalledTimes( 1 );
			expect( n.sink ).toBeNull();
			expect( Core.node( 'gone' ) ).toBeNull();
		} );
		it( 'refuses to destroy the interpreter', () => {
			const ci = makeCi();
			expect(
				dispatch( ci, 'remove_node', '_command_interpreter' )
			).toBe( 'refusing to destroy interpreter' );
		} );
		it( 'refuses baseline scaffolding (_router/_output)', () => {
			const ci = makeCi();
			new Node().setName( '_router' );
			expect( dispatch( ci, 'remove_node', '_router' ) ).toBe(
				'refusing to destroy baseline scaffolding: _router'
			);
		} );
		it( 'reports an unknown node', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'remove_node', 'nope' ) ).toBe(
				'can\'t find node "nope"'
			);
		} );
		it( '-a removes by anchored regex', () => {
			const ci = makeCi();
			new Node().setName( 'worker_a' );
			new Node().setName( 'worker_b' );
			const out = dispatch( ci, 'remove_node', '-a worker_.*' );
			expect( out ).toContain( 'removed worker_a' );
			expect( out ).toContain( 'removed worker_b' );
			expect( Core.node( 'worker_a' ) ).toBeNull();
		} );
		it( 'usage on empty args', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'remove_node', '' ) ).toBe(
				'usage: remove_node <node name>'
			);
		} );
	} );

	describe( 'list_nodes / ls', () => {
		it( 'default lists sibling node names (sink === this CI)', () => {
			const ci = makeCi();
			const a = new Node();
			a.setName( 'a' );
			a.sink = ci;
			const b = new Node();
			b.setName( 'b' );
			b.sink = ci;
			const orphan = new Node();
			orphan.setName( 'orphan' );
			const out = dispatch( ci, 'ls', '' );
			expect( out.split( '\n' ).sort() ).toEqual( [ 'a', 'b' ] );
		} );
		it( '-a lists all nodes', () => {
			const ci = makeCi();
			new Node().setName( 'x' );
			const out = dispatch( ci, 'ls', '-a' );
			expect( out ).toContain( 'x' );
			expect( out ).toContain( '_command_interpreter' );
		} );
		it( '-c adds a COUNT column header', () => {
			const ci = makeCi();
			const a = new Node();
			a.setName( 'a' );
			a.sink = ci;
			const out = dispatch( ci, 'ls', '-c' );
			expect( out ).toContain( 'COUNT' );
			expect( out ).toContain( 'NAME' );
		} );
		it( 'reports an unknown explicit node', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'ls', 'nope' ) ).toBe(
				'can\'t find node "nope"'
			);
		} );
	} );

	describe( 'log / dmesg', () => {
		it( 'log emits to Core.stderr and returns empty', () => {
			const ci = makeCi();
			const spy = jest
				.spyOn( console, 'warn' )
				.mockImplementation( () => {} );
			expect( dispatch( ci, 'log', 'hello' ) ).toBe( '' );
			expect( spy ).toHaveBeenCalledWith( 'hello' );
			spy.mockRestore();
		} );
		it( 'dmesg returns a string', () => {
			const ci = makeCi();
			expect( typeof dispatch( ci, 'dmesg', '' ) ).toBe( 'string' );
		} );
		it( 'dmesg returns the buffered Core.recentLog tail joined', () => {
			const ci = makeCi();
			const spy = jest
				.spyOn( console, 'warn' )
				.mockImplementation( () => {} );
			Core.stderr( 'one\n' );
			Core.stderr( 'two\n' );
			expect( dispatch( ci, 'dmesg', '' ) ).toBe( 'one\ntwo\n' );
			spy.mockRestore();
		} );
	} );

	describe( 'dump_node / dump', () => {
		it( 'returns a class-header + pretty-JSON string', () => {
			const ci = makeCi();
			const n = new Node();
			n.setName( 'd' );
			const out = dispatch( ci, 'dump_node', 'd' );
			expect( out.startsWith( 'Node ' ) ).toBe( true );
			const body = JSON.parse( out.slice( 'Node '.length ) );
			expect( body.name ).toBe( 'd' );
			expect( body.class ).toBeUndefined(); // class is the header, not a body key
		} );
		it( 'includes the sink as the sink node name, and `dump <node> sink` works', () => {
			// PHP keeps `sink` (coerced to the sink's name); requesting it must not error.
			const ci = makeCi();
			const n = new Node();
			n.setName( 'd' );
			const downstream = new Node();
			downstream.setName( 'downstream' );
			n.sink = downstream;
			expect( dispatch( ci, 'dump_node', 'd' ) ).toContain(
				'"sink": "downstream"'
			);
			const filtered = dispatch( ci, 'dump_node', 'd sink' );
			expect( filtered ).toContain( '"sink": "downstream"' );
			expect( filtered ).not.toContain( "can't find key" );
		} );
		it( 'no node specified', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'dump_node', '' ) ).toBe(
				'no node specified'
			);
		} );
		it( 'unknown node', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'dump_node', 'nope' ) ).toBe(
				'can\'t find node "nope"'
			);
		} );
		it( 'key filter narrows the body, unknown key errors', () => {
			const ci = makeCi();
			const n = new Node();
			n.setName( 'd' );
			const out = dispatch( ci, 'dump_node', 'd name' );
			const body = JSON.parse( out.slice( 'Node '.length ) );
			expect( Object.keys( body ) ).toEqual( [ 'name' ] );
			expect( dispatch( ci, 'dump_node', 'd bogus' ) ).toBe(
				'can\'t find key "bogus"'
			);
		} );
	} );

	describe( 'dump_metadata', () => {
		it( 'returns the per-node object the canvas parseMetadata expects', () => {
			const ci = makeCi();
			const n = new Node();
			n.setName( 'm' );
			n.sink = ci;
			const meta = dispatch( ci, 'dump_metadata', '' );
			expect( meta.m ).toEqual(
				expect.objectContaining( {
					class: 'Node',
					counter: 0,
					sink: '_command_interpreter',
					target: '',
					debug_state: 0,
					arguments: '',
				} )
			);
		} );
		it( 'skips patron-linked plumbing nodes', () => {
			const ci = makeCi();
			const n = new Node();
			n.setName( 'plumb' );
			n.patron = ci;
			const meta = dispatch( ci, 'dump_metadata', '' );
			expect( meta.plumb ).toBeUndefined();
		} );
	} );

	describe( 'dump_config', () => {
		it( 'returns a string excluding baseline scaffolding', () => {
			const ci = makeCi();
			new Node().setName( '_router' );
			const out = dispatch( ci, 'dump_config', '' );
			expect( typeof out ).toBe( 'string' );
			expect( out ).not.toContain( '_router' );
		} );
	} );

	describe( 'stats', () => {
		it( 'tabulates sibling counters with the canonical header', () => {
			const ci = makeCi();
			const a = new Node();
			a.setName( 'a' );
			a.sink = ci;
			const out = dispatch( ci, 'stats', '' );
			expect( out ).toContain( 'NAME' );
			expect( out ).toContain( 'COUNT' );
			expect( out ).toContain( 'LGST_MSG' );
			expect( out ).toContain( 'a' );
		} );
	} );

	describe( 'uptime', () => {
		it( 'returns a clock + "up" string', () => {
			const ci = makeCi();
			const out = dispatch( ci, 'uptime', '' );
			expect( out ).toMatch( /up/ );
		} );
		it( 'reports elapsed time since initTime that grows with the clock', () => {
			const ci = makeCi();
			const nowSpy = jest.spyOn( Core, 'now' );

			// reset() captures initTime at 1000; advance the clock to 1090.
			nowSpy.mockReturnValue( 1000 );
			Core.reset();
			nowSpy.mockReturnValue( 1090 );

			expect( dispatch( ci, 'uptime', '' ) ).toMatch( /up 1m 30s/ );

			// Advance further; elapsed must grow.
			nowSpy.mockReturnValue( 1000 + 3661 );
			expect( dispatch( ci, 'uptime', '' ) ).toMatch( /up 1h 01m/ );

			nowSpy.mockRestore();
		} );
	} );

	describe( 'debug_state', () => {
		it( 'no args toggles this CI', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'debug_state', '' ) ).toBe(
				'_command_interpreter debug_state: 1'
			);
			expect( dispatch( ci, 'debug_state', '' ) ).toBe(
				'_command_interpreter debug_state: 0'
			);
		} );
		it( 'numeric arg sets this CI', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'debug_state', '3' ) ).toBe(
				'_command_interpreter debug_state: 3'
			);
		} );
		it( 'name + level sets that node', () => {
			const ci = makeCi();
			const n = new Node();
			n.setName( 'n' );
			expect( dispatch( ci, 'debug_state', 'n 2' ) ).toBe(
				'n debug_state: 2'
			);
			expect( n.debugState ).toBe( 2 );
		} );
		it( 'unknown node errors', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'debug_state', 'nope' ) ).toBe(
				'unknown node: nope'
			);
		} );
	} );

	describe( 'help', () => {
		it( 'no topic lists the server commands section', () => {
			const ci = makeCi();
			const out = dispatch( ci, 'help', '' );
			expect( out ).toContain( 'SERVER COMMANDS' );
			expect( out ).toContain( 'make_node' );
		} );
		it( 'a topic returns that command help (alias resolves)', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'help', 'ls' ) ).toContain( 'list_nodes' );
		} );
		it( 'an unknown topic errors', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'help', 'zzz' ) ).toBe(
				'no such topic: "zzz"'
			);
		} );
	} );

	describe( 'make_node', () => {
		afterEach( () => {
			CommandInterpreter.classMap = {};
		} );
		it( 'reports unknown class when nothing is registered', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'make_node', 'Widget w' ) ).toBe(
				'unknown class: Widget'
			);
		} );
		it( 'constructs and sinks a registered class', () => {
			class Widget extends Node {}
			CommandInterpreter.registerClass( 'Widget', Widget );
			const ci = makeCi();
			expect( dispatch( ci, 'make_node', 'Widget w' ) ).toBe( 'ok' );
			const w = Core.node( 'w' );
			expect( w ).toBeInstanceOf( Widget );
			expect( w.sink ).toBe( ci );
		} );
		it( 'usage when name is missing', () => {
			const ci = makeCi();
			expect( dispatch( ci, 'make_node', 'Widget' ) ).toBe(
				'usage: make_node <type> <name> [<ctor_args>...]'
			);
		} );
	} );
} );
