import { CommandInterpreterNode } from '../command-interpreter-node';
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
	interpreter.setName( 'test_interpreter' );
	interpreter.sink = sink;
	interpreter.commands( {
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
	};
	m[ LOCAL ] = true; // in-process command — carries the provenance taint
	interpreter.fill( m );

	expect( got ).toHaveLength( 1 );
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

	const interpreter = new CommandInterpreterNode();
	interpreter.setName( 'test_interpreter' );
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
	expect( got[ 0 ][ VALUE ].payload ).toBe( 'boom' );
} );

test( 'command without LOCAL provenance is refused (unauthorized), verb not run', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	let ran = false;
	const interpreter = new CommandInterpreterNode();
	interpreter.setName( 'test_interpreter' );
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
	interpreter.setName( 'test_interpreter' );
	interpreter.sink = sink;
	interpreter.authorize = () => true;
	interpreter.commands( { echo: () => 'ok' } );

	const m = newMessage();
	m[ TYPE ] = TM_COMMAND;
	m[ VALUE ] = { name: 'echo', arguments: '' };
	interpreter.fill( m );

	expect( got[ 0 ][ TYPE ] & TM_RESPONSE ).toBeTruthy();
	expect( got[ 0 ][ VALUE ].payload ).toBe( 'ok' );
} );

test( 'static defaultAuthorize can refuse even with LOCAL set', () => {
	const sink = new Node();
	const got = [];
	sink.fill = ( m ) => got.push( [ ...m ] );

	let ran = false;
	const interpreter = new CommandInterpreterNode();
	interpreter.setName( 'test_interpreter' );
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
	// VALUE must be a { name, ... } object; a bare string is not a command struct.
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
	m[ VALUE ] = '1700000000.5'; // originating timestamp the caller will diff against
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

// ---------------------------------------------------------------------------
// Built-in verb table (1:1 parity with PHP CommandInterpreter $C). Each verb is
// dispatched directly (no envelope plumbing) and asserted on its return value.
// ---------------------------------------------------------------------------

import { TeeNode } from '../tee-node';

// Dispatch a built-in verb by name and return its raw result.
const dispatch = ( interpreter, name, args = '', envelope = {} ) =>
	interpreter.commands()[ name ]( interpreter, args, envelope );

describe( 'built-in verbs — defaults installed on every interpreter', () => {
	const makeInterpreter = () => {
		const interpreter = new CommandInterpreterNode();
		interpreter.setName( '_command_interpreter' );
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
			'debug_state',
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
			a.setName( 'a' );
			const b = new Node();
			b.setName( 'b' );
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
			new Node().setName( 'a' );
			expect( dispatch( interpreter, 'set_sink', 'a nope' ) ).toBe(
				'unknown node'
			);
		} );
	} );

	describe( 'connect_node / disconnect_node', () => {
		it( 'connects a Tee target', () => {
			const interpreter = makeInterpreter();
			const tee = new TeeNode();
			tee.setName( 't' );
			expect( dispatch( interpreter, 'connect_node', 't dest' ) ).toBe(
				'ok'
			);
			expect( tee.target ).toContain( 'dest' );
		} );
		it( 'defaults the target to the envelope FROM', () => {
			const interpreter = makeInterpreter();
			const tee = new TeeNode();
			tee.setName( 't' );
			const env = newMessage();
			env[ FROM ] = 'session';
			expect( dispatch( interpreter, 'connect_node', 't', env ) ).toBe(
				'ok'
			);
			expect( tee.target ).toContain( 'session' );
		} );
		it( 'connects a non-Tee node by setting its string target (no crash)', () => {
			// Base Node has no connectNode (only Tee does); the verb must fall back
			// to setting a single string target — matching PHP Node::connect_node.
			const interpreter = makeInterpreter();
			const n = new Node();
			n.setName( 'plain' );
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
			tee.setName( 't' );
			tee.connectNode( 'dest' );
			expect( dispatch( interpreter, 'disconnect_node', 't dest' ) ).toBe(
				'ok'
			);
			expect( tee.target ).not.toContain( 'dest' );
		} );
		it( 'disconnect calls the node disconnectNode lifecycle method', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.setName( 'plain' );
			n.target = 'dest';
			const spy = jest.spyOn( n, 'disconnectNode' );
			expect(
				dispatch( interpreter, 'disconnect_node', 'plain dest' )
			).toBe( 'ok' );
			expect( spy ).toHaveBeenCalledWith( 'dest' );
			expect( n.target ).toBe( '' );
		} );
	} );

	describe( 'remove_node', () => {
		it( 'unregisters a named node from Core', () => {
			const interpreter = makeInterpreter();
			new Node().setName( 'gone' );
			expect( dispatch( interpreter, 'remove_node', 'gone' ) ).toBe(
				'removed gone'
			);
			expect( Core.node( 'gone' ) ).toBeNull();
		} );
		it( 'calls the node removeNode lifecycle method (full teardown, not bare unregister)', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.setName( 'gone' );
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
			new Node().setName( '_router' );
			new Node().setName( '_output' );
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
			new Node().setName( 'worker_a' );
			new Node().setName( 'worker_b' );
			const out = dispatch( interpreter, 'remove_node', '-a worker_.*' );
			expect( out ).toContain( 'removed worker_a' );
			expect( out ).toContain( 'removed worker_b' );
			expect( Core.node( 'worker_a' ) ).toBeNull();
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
			a.setName( 'a' );
			a.sink = interpreter;
			const b = new Node();
			b.setName( 'b' );
			b.sink = interpreter;
			const orphan = new Node();
			orphan.setName( 'orphan' );
			const out = dispatch( interpreter, 'ls', '' );
			expect( out.split( '\n' ).sort() ).toEqual( [ 'a', 'b' ] );
		} );
		it( '-a lists all nodes', () => {
			const interpreter = makeInterpreter();
			new Node().setName( 'x' );
			const out = dispatch( interpreter, 'ls', '-a' );
			expect( out ).toContain( 'x' );
			expect( out ).toContain( '_command_interpreter' );
		} );
		it( '-c adds a COUNT column header', () => {
			const interpreter = makeInterpreter();
			const a = new Node();
			a.setName( 'a' );
			a.sink = interpreter;
			const out = dispatch( interpreter, 'ls', '-c' );
			expect( out ).toContain( 'COUNT' );
			expect( out ).toContain( 'NAME' );
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
				/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC newspack-nodes: .*hello$/
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
				/UTC newspack-nodes: one\n.*UTC newspack-nodes: two\n$/s
			);
			spy.mockRestore();
		} );
	} );

	describe( 'dump_node / dump', () => {
		it( 'returns a class-header + pretty-JSON string', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.setName( 'd' );
			const out = dispatch( interpreter, 'dump_node', 'd' );
			expect( out.startsWith( 'Node ' ) ).toBe( true );
			const body = JSON.parse( out.slice( 'Node '.length ) );
			expect( body.name ).toBe( 'd' );
			expect( body.class ).toBeUndefined(); // class is the header, not a body key
		} );
		it( 'includes the sink as the sink node name, and `dump <node> sink` works', () => {
			// PHP keeps `sink` (coerced to the sink's name); requesting it must not error.
			const interpreter = makeInterpreter();
			const n = new Node();
			n.setName( 'd' );
			const downstream = new Node();
			downstream.setName( 'downstream' );
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
		it( 'key filter narrows the body, unknown key errors', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.setName( 'd' );
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
			n.setName( 'm' );
			n.sink = interpreter;
			const meta = dispatch( interpreter, 'dump_metadata', '' );
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
			const interpreter = makeInterpreter();
			const n = new Node();
			n.setName( 'plumb' );
			n.patron = interpreter;
			const meta = dispatch( interpreter, 'dump_metadata', '' );
			expect( meta.plumb ).toBeUndefined();
		} );
	} );

	describe( 'stats', () => {
		it( 'tabulates sibling counters with the canonical header', () => {
			const interpreter = makeInterpreter();
			const a = new Node();
			a.setName( 'a' );
			a.sink = interpreter;
			const out = dispatch( interpreter, 'stats', '' );
			expect( out ).toContain( 'NAME' );
			expect( out ).toContain( 'COUNT' );
			expect( out ).toContain( 'LGST_MSG' );
			expect( out ).toContain( 'a' );
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
	} );

	describe( 'debug_state', () => {
		it( 'no args toggles this interpreter', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'debug_state', '' ) ).toBe(
				'_command_interpreter debug_state: 1'
			);
			expect( dispatch( interpreter, 'debug_state', '' ) ).toBe(
				'_command_interpreter debug_state: 0'
			);
		} );
		it( 'numeric arg sets this interpreter', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'debug_state', '3' ) ).toBe(
				'_command_interpreter debug_state: 3'
			);
		} );
		it( 'name + level sets that node', () => {
			const interpreter = makeInterpreter();
			const n = new Node();
			n.setName( 'n' );
			expect( dispatch( interpreter, 'debug_state', 'n 2' ) ).toBe(
				'n debug_state: 2'
			);
			expect( n.debugState ).toBe( 2 );
		} );
		it( 'unknown node errors', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'debug_state', 'nope' ) ).toBe(
				'unknown node: nope'
			);
		} );
	} );

	describe( 'help', () => {
		it( 'no topic lists the server commands section', () => {
			const interpreter = makeInterpreter();
			const out = dispatch( interpreter, 'help', '' );
			expect( out ).toContain( 'SERVER COMMANDS' );
			expect( out ).toContain( 'make_node' );
		} );
		it( 'a topic returns that command help (alias resolves)', () => {
			const interpreter = makeInterpreter();
			expect( dispatch( interpreter, 'help', 'ls' ) ).toContain(
				'list_nodes'
			);
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

		it( 'help WITHOUT the completion key is unchanged (full tabulated help)', () => {
			const interpreter = makeInterpreter();
			const out = dispatch( interpreter, 'help', '' );
			expect( out ).toContain( '### SERVER COMMANDS ###' );
			expect( out ).toContain( '### SHELL BUILTINS ###' );
		} );

		it( 'ls with KEY=completion returns all bare node names (like -a), no columns', () => {
			const interpreter = makeInterpreter();
			const a = new Node();
			a.setName( 'a' );
			a.sink = interpreter;
			const b = new Node();
			b.setName( 'b' );
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
			new Node().setName( 'x' );
			const out = dispatch( interpreter, 'ls', '-a', completionEnv() );
			const lines = out.split( '\n' );
			expect( lines ).toContain( 'x' );
			expect( lines ).toContain( '_command_interpreter' );
			expect( out ).not.toContain( 'NAME' );
		} );

		it( 'ls WITHOUT the completion key is unchanged', () => {
			const interpreter = makeInterpreter();
			const a = new Node();
			a.setName( 'a' );
			a.sink = interpreter;
			const out = dispatch( interpreter, 'ls', '-c' );
			expect( out ).toContain( 'COUNT' );
			expect( out ).toContain( 'NAME' );
		} );
	} );

	describe( 'make_node (constructs in-browser, mirrors PHP)', () => {
		// Mirrors PHP Command_Interpreter_Node::make_node: split args on
		// whitespace, spread the trailing tokens into the constructor as
		// positional args, name(), sink($self). includeNodes (a flat name→class
		// table) stands in for PHP's namespace-prefix resolution.
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

		it( 'routes trailing tokens through the arguments setter (Tachikoma sequence)', () => {
			// Post Tachikoma-parity refactor (Task 11), make_node uses the
			// uniform `new NodeClass()` no-arg ctor and feeds the trailing
			// tokens through `node.arguments = parts.join(' ')`. The schema
			// walker assigns each declared positional arg from those tokens.
			const interpreter = makeInterpreter();
			CommandInterpreterNode.includeNodes.ArgSpy = class extends Node {
				constructor() {
					super();
					// Predeclared so the schema walker's `name in this` gate
					// passes and the tokens get assigned.
					this.alpha_field = '';
					this.beta_field = '';
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
			dispatch( interpreter, 'make_node', 'ArgSpy s alpha beta' );
			const node = Core.node( 's' );
			expect( node.arguments ).toBe( 'alpha beta' );
			expect( node.alpha_field ).toBe( 'alpha' );
			expect( node.beta_field ).toBe( 'beta' );
			delete CommandInterpreterNode.includeNodes.ArgSpy;
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

		it( 'feeds trailing args through the arguments setter', () => {
			const interp = makeInterpreter();
			const node = interp.makeNode( 'Tee', 't', 'a b' );
			expect( node.arguments ).toBe( 'a b' );
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

		it( 'emits set_sink only when the sink is not the interpreter', () => {
			const interpreter = makeInterpreter();
			dispatch( interpreter, 'make_node', 'Tee a' );
			dispatch( interpreter, 'make_node', 'Node b' );
			dispatch( interpreter, 'set_sink', 'a b' );
			const out = dispatch( interpreter, 'dump_config' );
			expect( out ).toContain( 'set_sink a b' );
			// `b` sinks into the interpreter by default → no set_sink line for it.
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
			new Node().setName( '_router' );
			const out = dispatch( interpreter, 'dump_config' );
			expect( out ).not.toContain( '_command_interpreter' );
			expect( out ).not.toContain( '_router' );
		} );

		it( 'dumps _output (a real node, no longer skipped scaffolding)', () => {
			const interpreter = makeInterpreter();
			new Node().setName( '_output' );
			expect( dispatch( interpreter, 'dump_config' ) ).toContain(
				'_output'
			);
		} );
	} );
} );
