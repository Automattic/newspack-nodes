/**
 * Shell node tests — typed-line parse → positional TM_* Message filled into the
 * sink, with FROM=`_http/<ssePid>/<reply-node>` and TO=prefix(path). Builtins
 * (clear/debug_level) return a local-signal object instead of filling. Mirrors
 * the verb vocabulary of the substrate PHP Shell + the old utils/shell.js.
 */

import { Shell, splitStatements } from '../shell';
import { Node } from '../../../runtime/node';
import {
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
	TM_COMMAND,
	TM_PING,
	TM_INFO,
	TM_BYTESTREAM,
	TM_EOF,
	TM_REQUEST,
} from '../../../runtime/message';

function makeShell( { path = '_http/demo.p0', ssePid = 4242 } = {} ) {
	const shell = new Shell();
	shell.path = path;
	shell.ssePid = ssePid;
	const sink = new Node();
	const filled = [];
	sink.fill = ( m ) => filled.push( m );
	shell.sink = sink;
	return { shell, filled };
}

describe( 'Shell node — cd navigation', () => {
	it( 'cd / drops to the browser-internal graph root (empty path)', () => {
		const { shell } = makeShell( { path: '_http/demo.p0' } );
		expect( shell.parse( 'cd /' ) ).toBeNull();
		expect( shell.path ).toBe( '' );
	} );

	it( 'cd /_http navigates to the HTTP boundary from anywhere', () => {
		const { shell } = makeShell( { path: '_http/demo.p0' } );
		shell.parse( 'cd /_http' );
		expect( shell.path ).toBe( '_http' );
	} );

	it( 'cd .. from a worker walks up to _http', () => {
		const { shell } = makeShell( { path: '_http/demo.p0' } );
		shell.parse( 'cd ..' );
		expect( shell.path ).toBe( '_http' );
	} );

	it( 'cd .. from _http walks up to the local root', () => {
		const { shell } = makeShell( { path: '_http' } );
		shell.parse( 'cd ..' );
		expect( shell.path ).toBe( '' );
	} );

	it( 'cd <name> appends relative to the cwd', () => {
		const { shell } = makeShell( { path: '_http' } );
		shell.parse( 'cd demo.p0' );
		expect( shell.path ).toBe( '_http/demo.p0' );
	} );

	it( 'cd /_http/<worker> is absolute', () => {
		const { shell } = makeShell( { path: '' } );
		shell.parse( 'cd /_http/demo.p0' );
		expect( shell.path ).toBe( '_http/demo.p0' );
	} );

	it( 'a command after cd routes from the new cwd (TO reflects the path)', () => {
		const { shell } = makeShell( { path: '_http/demo.p0' } );
		shell.parse( 'cd /_http' );
		const msg = shell.parse( 'ls' );
		expect( msg[ TO ] ).toBe( '_http' ); // → HttpOut → request-scope CI
		shell.parse( 'cd /' );
		const local = shell.parse( 'ls' );
		expect( local[ TO ] ).toBe( '' ); // → browser-internal CI
	} );
} );

describe( 'Shell node — local builtins', () => {
	it( 'returns null for empty / whitespace input and fills nothing', () => {
		const { shell, filled } = makeShell();
		expect( shell.parse( '' ) ).toBeNull();
		expect( shell.parse( '   ' ) ).toBeNull();
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'stamps LOCAL provenance on a minted command', () => {
		const { shell } = makeShell();
		const msg = shell.parse( 'dump_node x' );
		expect( msg[ LOCAL ] ).toBe( true );
	} );

	it( 'clear → a local signal, not a filled message', () => {
		const { shell, filled } = makeShell();
		expect( shell.parse( 'clear' ) ).toEqual( {
			kind: 'local',
			name: 'clear',
		} );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'debug_level with no arg → local signal with level null', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'debug_level' ) ).toEqual( {
			kind: 'local',
			name: 'debug_level',
			level: null,
		} );
	} );

	it( 'debug_level with a numeric arg → local signal carrying that level', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'debug_level 2' ) ).toEqual( {
			kind: 'local',
			name: 'debug_level',
			level: 2,
		} );
	} );

	it( 'debug_level out of range → an error signal', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'debug_level 9' ) ).toEqual( {
			kind: 'error',
			text: 'usage: debug_level [0|1|2]',
		} );
	} );
} );

describe( 'Shell node — fill() reply pivot + TO', () => {
	it( 'fill() of a typed line stamps the bare reply-node FROM and TO=prefix(path)', () => {
		const { shell, filled } = makeShell( { path: '_sse/demo.p0' } );
		const signal = shell.fill( 'ls -al' );
		expect( signal ).toBeNull(); // a posted command returns null
		expect( filled ).toHaveLength( 1 );
		const m = filled[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		// FROM is the bare reply node; the `_sse` session node wraps it downstream.
		expect( m[ FROM ] ).toBe( '_output' );
		expect( m[ TO ] ).toBe( '_sse/demo.p0' );
		expect( m[ VALUE ] ).toEqual( {
			name: 'ls',
			arguments: '-al',
			payload: '',
		} );
	} );

	it( 'fill() of a builtin returns the local signal and fills nothing', () => {
		const { shell, filled } = makeShell();
		expect( shell.fill( 'clear' ) ).toEqual( {
			kind: 'local',
			name: 'clear',
		} );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'increments the base Node counter on each fill', () => {
		const { shell } = makeShell();
		shell.fill( 'ls' );
		shell.fill( 'ls' );
		expect( shell.counter ).toBe( 2 );
	} );
} );

describe( 'Shell node — verb vocabulary (positional TM_* messages)', () => {
	const drive = ( line, opts ) => {
		const { shell, filled } = makeShell( opts );
		const signal = shell.fill( line );
		return { signal, m: filled[ 0 ], filled };
	};

	it( 'ping with no path → TM_PING, TO=path, numeric send-timestamp VALUE', () => {
		const { m } = drive( 'ping', { path: '_http/demo.p0' } );
		expect( m[ TYPE ] ).toBe( TM_PING );
		expect( m[ TO ] ).toBe( '_http/demo.p0' );
		expect( typeof m[ VALUE ] ).toBe( 'number' );
		expect( m[ VALUE ] ).toBeGreaterThan( 0 );
	} );

	it( 'ping with a node path → TO=prefix(path)/node', () => {
		const { m } = drive( 'ping firehose-in', { path: '_http/demo.p0' } );
		expect( m[ TYPE ] ).toBe( TM_PING );
		expect( m[ TO ] ).toBe( '_http/demo.p0/firehose-in' );
	} );

	it( 'tell <node> <bytes> → TM_INFO with the bytes as VALUE', () => {
		const { m } = drive( 'tell my_node hello world' );
		expect( m[ TYPE ] ).toBe( TM_INFO );
		expect( m[ TO ] ).toBe( '_http/demo.p0/my_node' );
		expect( m[ VALUE ] ).toBe( 'hello world' );
	} );

	it( 'tell with no node → error signal', () => {
		const { signal, filled } = drive( 'tell' );
		expect( signal ).toEqual( {
			kind: 'error',
			text: 'usage: tell <path> <bytes>',
		} );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'send <node> <bytes> → TM_BYTESTREAM, newline-terminated VALUE', () => {
		const { m } = drive( 'send my_node payload' );
		expect( m[ TYPE ] ).toBe( TM_BYTESTREAM );
		expect( m[ TO ] ).toBe( '_http/demo.p0/my_node' );
		expect( m[ VALUE ] ).toBe( 'payload\n' );
	} );

	it( 'send_eof <node> → TM_EOF, no VALUE', () => {
		const { m } = drive( 'send_eof my_node' );
		expect( m[ TYPE ] ).toBe( TM_EOF );
		expect( m[ TO ] ).toBe( '_http/demo.p0/my_node' );
	} );

	it( 'send_eof with no node → error signal', () => {
		const { signal } = drive( 'send_eof' );
		expect( signal ).toEqual( {
			kind: 'error',
			text: 'usage: send_eof <path>',
		} );
	} );

	it( 'request <node> <args> → TM_REQUEST with the args as VALUE', () => {
		const { m } = drive( 'request my_node GET_LAG' );
		expect( m[ TYPE ] ).toBe( TM_REQUEST );
		expect( m[ TO ] ).toBe( '_http/demo.p0/my_node' );
		expect( m[ VALUE ] ).toBe( 'GET_LAG' );
	} );

	it( 'cmd <node> <verb> <args> → TM_COMMAND targeting that node', () => {
		const { m } = drive( 'cmd firehose-in dump_metadata' );
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( '_http/demo.p0/firehose-in' );
		expect( m[ VALUE ] ).toEqual( {
			name: 'dump_metadata',
			arguments: '',
			payload: '',
		} );
	} );

	it( 'cmd with only a path → error signal', () => {
		const { signal } = drive( 'cmd only_path' );
		expect( signal ).toEqual( {
			kind: 'error',
			text: 'usage: cmd <path> <verb> [<args>]',
		} );
	} );

	it( 'a bare verb defaults to TM_COMMAND at the cwd (path)', () => {
		const { m } = drive( 'make_node Echo my_node' );
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( '_http/demo.p0' );
		expect( m[ VALUE ] ).toEqual( {
			name: 'make_node',
			arguments: 'Echo my_node',
			payload: '',
		} );
	} );

	it( 'does NOT intercept `help` — it goes to the worker', () => {
		const { m } = drive( 'help' );
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ VALUE ].name ).toBe( 'help' );
		expect( m[ VALUE ].arguments ).toBe( '' );
	} );
} );

describe( 'Shell node — settable path (cwd) + prefix', () => {
	it( 'empty path leaves TO at the bare node target', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.fill( 'tell n hi' );
		expect( filled[ 0 ][ TO ] ).toBe( 'n' );
	} );

	it( 'path-only (no node) routes a bare verb to the cwd', () => {
		const { shell, filled } = makeShell( { path: '_http/demo.p0' } );
		shell.fill( 'ls' );
		expect( filled[ 0 ][ TO ] ).toBe( '_http/demo.p0' );
	} );
} );

describe( 'Shell node — anonymity', () => {
	it( 'has no node name (anonymous, like the PHP Shell)', () => {
		const { shell } = makeShell();
		expect( shell.name ).toBe( '' );
	} );
} );

describe( 'splitStatements (unquoted `;` splitter)', () => {
	it( 'returns single statement when no semicolons', () => {
		expect( splitStatements( 'help' ) ).toEqual( [ 'help' ] );
	} );

	it( 'splits on `;` and trims surrounding whitespace', () => {
		expect( splitStatements( 'help; ls' ) ).toEqual( [ 'help', 'ls' ] );
		expect( splitStatements( '  clear  ;  help  ;  ls -al  ' ) ).toEqual( [
			'clear',
			'help',
			'ls -al',
		] );
	} );

	it( 'drops empty statements from consecutive `;`', () => {
		expect( splitStatements( ';;help;;ls;;' ) ).toEqual( [ 'help', 'ls' ] );
	} );

	it( 'preserves `;` inside single / double / backtick quotes', () => {
		expect( splitStatements( "tell my_node 'hello; world'; ls" ) ).toEqual(
			[ "tell my_node 'hello; world'", 'ls' ]
		);
		expect( splitStatements( 'tell my_node "a;b"; help' ) ).toEqual( [
			'tell my_node "a;b"',
			'help',
		] );
		expect( splitStatements( 'cmd target `inner; cmd`; ls' ) ).toEqual( [
			'cmd target `inner; cmd`',
			'ls',
		] );
	} );

	it( 'returns empty array for empty / whitespace / all-semicolon input', () => {
		expect( splitStatements( '' ) ).toEqual( [] );
		expect( splitStatements( '   ' ) ).toEqual( [] );
		expect( splitStatements( ';;;' ) ).toEqual( [] );
	} );
} );
