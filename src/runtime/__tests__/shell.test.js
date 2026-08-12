/**
 * Shell node tests — typed-line parse → positional TM_* Message filled into the
 * sink, with FROM=`_http/<ssePid>/<reply-node>` and TO=prefix(path). Builtins
 * (clear/debug_level) return a local-signal object instead of filling. Mirrors
 * the verb vocabulary of the substrate PHP Shell + the old utils/shell.js.
 */

import {
	ShellNode,
	parseStatements,
	splitStatements,
	tokenize,
	quoteToken,
} from '../shell-node';
import { Node, serializeArg } from '../node';
import { DumperNode } from '../dumper-node';
import { StdoutNode } from '../stdout-node';
import names from '../reserved-node-names.json';
import { Core } from '../core';
import {
	TYPE,
	FROM,
	TO,
	ID,
	KEY,
	TIMESTAMP,
	VALUE,
	LOCAL,
	TM_COMMAND,
	TM_PING,
	TM_INFO,
	TM_BYTESTREAM,
	TM_STRUCT,
	TM_EOF,
	TM_REQUEST,
	TM_NOREPLY,
} from '../message';

// The graph is process-global; a leaked `_output` from a previous test would
// capture this one's output.
let printed = [];
beforeEach( () => {
	Core.reset();
	printed = [];
} );

// Everything the shell printed this test, joined.
const printedText = () => printed.join( '' );

function makeShell( { path = '_http/demo.p0', ssePid = 4242 } = {} ) {
	const shell = new ShellNode();
	shell.path = path;
	shell.ssePid = ssePid;
	const sink = new Node();
	const filled = [];
	sink.fill = ( m ) => filled.push( m );
	shell.sink = sink;
	// Builtin output bypasses the Dumper and lands on `_stdout`.
	const stdout = new StdoutNode( {
		write: ( text ) => printed.push( text ),
	} );
	stdout.name = names.STDOUT;
	// `_output` is the real Dumper: the shell drives its actual API.
	const out = new DumperNode();
	out.name = names.OUTPUT;
	return { shell, filled, out };
}

// The only way in: a TM_BYTESTREAM carrying the typed line (ADR-1).
function send( shell, line ) {
	const m = [];
	m[ TYPE ] = TM_BYTESTREAM;
	m[ TIMESTAMP ] = 0;
	m[ FROM ] = '';
	m[ TO ] = '';
	m[ ID ] = '';
	m[ KEY ] = '';
	m[ VALUE ] = line;
	shell.fill( m );
}

// Text of everything the shell printed, joined.

describe( 'parse — backslash continuation splices with nothing', () => {
	it( 'holds the line, then splices bash-style (hi\\ + bye = hibye)', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'print hi\\' ) ).toBeNull();
		expect( shell.hasPending() ).toBe( true );
		expect( shell.pendingPrompt() ).toBe( '> ' );
		shell.parse( 'bye' );
		expect( printedText() ).toBe( 'hibye' );
		expect( shell.hasPending() ).toBe( false );
	} );

	it( 'flushPending reports a held backslash continuation at EOF', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'print hi\\' ) ).toBeNull();
		shell.flushPending();
		expect( printedText() ).toMatch( /got EOF while waiting for tokens/ );
		expect( shell.hasPending() ).toBe( false );
	} );
} );

describe( 'parse — an open quote continues onto the next line', () => {
	it( 'holds the statement, then dispatches with the newline in the token', () => {
		const { shell, filled } = makeShell();
		expect( shell.parse( "tell node 'foo" ) ).toBeNull();
		expect( filled ).toHaveLength( 0 );
		const message = shell.parse( "bar'" );
		expect( message[ VALUE ] ).toBe( 'foo\nbar' );
	} );

	it( 'flushPending reports EOF-inside-quote and clears the accumulator', () => {
		const { shell } = makeShell();
		expect( shell.parse( "tell node 'foo" ) ).toBeNull();
		expect( shell.pendingPrompt() ).toBe( "'> " );
		shell.flushPending();
		expect( printedText() ).toMatch( /got EOF while waiting for tokens/ );
		// A second flush has nothing held, so it prints nothing more.
		const before = printedText();
		shell.flushPending();
		expect( printedText() ).toBe( before );
	} );
} );

describe( 'quoteToken — tokenizer inverse for one intact token [#32]', () => {
	it( 'wraps a JSON value so tokenize() returns it as a single token', () => {
		const json = '{ "foo": "bar", "n": 3 }';
		// Bare JSON shreds: the tokenizer strips " quotes and splits on spaces.
		expect( tokenize( json ).length ).toBeGreaterThan( 1 );
		// Quoted, it survives as one token (quote stripped → original JSON).
		expect( tokenize( quoteToken( json ) ) ).toEqual( [ json ] );
	} );

	it( 'escapes a single quote so a quote-bearing value round-trips', () => {
		const v = '{ "msg": "it\'s here" }';
		expect( tokenize( quoteToken( v ) ) ).toEqual( [ v ] );
	} );

	it( 'prefers a single quote for ordinary double-quoted JSON', () => {
		const json = '{"a":1}';
		expect( quoteToken( json ) ).toBe( "'" + json + "'" );
	} );

	it( 'escapes so a value with every quote char is still representable', () => {
		// With tokenizer escape support, quoteToken never fails — the wrapping
		// quote and backslashes are escaped and the tokenizer recovers them.
		const v = 'a\'b`c"d\\e';
		expect( tokenize( quoteToken( v ) ) ).toEqual( [ v ] );
	} );
} );

describe( 'tokenizer escape round-trip', () => {
	// Node names are globally unique; one per round-trip case.
	let roundTripSeq = 0;

	it( 'tokenize unescapes the quote char and backslash inside quotes', () => {
		expect( tokenize( "'it\\'s'" ) ).toEqual( [ "it's" ] );
		expect( tokenize( "'a\\\\b'" ) ).toEqual( [ 'a\\b' ] );
	} );

	it.each( [
		[ [ 'a b', 'c' ] ],
		[ [ "it's" ] ],
		[ [ 'pa"th' ] ],
		[ [ 'back`tick' ] ],
		[ [ 'a\\b' ] ],
		[ [ "a 'b" ] ],
		[ [ 'q\'"`x' ] ],
		[ [ '', 'bval' ] ],
		[ [ 'a', '', 'c' ] ],
		[ [ '' ] ],
		[ [ '/logs/x.p0', '65536', '4' ] ],
	] )(
		'a dumped make_node line round-trips %j through tokenize',
		( tokens ) => {
			const node = new Node();
			node.name = `roundtrip${ roundTripSeq++ }`;
			node.arguments = tokens;
			// `make_node <Type> <name> <args…>` — drop the three fixed tokens.
			const [ line ] = node.dumpConfig().split( '\n' );
			expect( tokenize( line ).slice( 3 ) ).toEqual( tokens );
		}
	);

	// A stored argument can hold an UNEXPANDED `<…>` — what the single-quoted
	// idiom (`.p'<partition>'`) hands a node. Emitted bare, the loader
	// interpolates it away on reload. Parity-pinned to the PHP
	// Node::serialize_args test of the same name.
	it( 'quotes a stored argument carrying an unexpanded interpolation marker', () => {
		expect( serializeArg( '/logs/firehose.p<partition>' ) ).toBe(
			"'/logs/firehose.p<partition>'"
		);
	} );

	// The same deferral for a token serializeArg had to ESCAPE: it writes `'` as
	// `\'`, and interpolate() runs before tokenize() — a literal span closing on
	// the escape inverts quote parity and expands every later `<…>`.
	// Parity-pinned to the PHP test of the same name.
	it( 'defers a marker following an escaped quote', () => {
		const { shell } = makeShell( {} );
		const tokens = [ "Don't use <partition>", '/logs/x.p<partition>' ];
		const line = 'X Y ' + tokens.map( serializeArg ).join( ' ' );
		expect( tokenize( shell.interpolate( line ) ).slice( 2 ) ).toEqual(
			tokens
		);
	} );

	// A name is as much a token as an argument — `make Echo 'foo bar'` really
	// does register a node named "foo bar". Emitted bare, every dumped line
	// replays as one token too many and rebuilds a DIFFERENT graph.
	// Parity-pinned to the PHP test of the same name.
	it( 'quotes spaced node, sink and target names so each line round-trips', () => {
		const sink = new Node();
		sink.name = 'sink node';
		const node = new Node();
		node.name = 'foo bar';
		node.sink = sink;
		node.target = 'down stream';

		const [ make, setSink, connect ] = node.dumpConfig().split( '\n' );
		expect( tokenize( make ).slice( 2 ) ).toEqual( [ 'foo bar' ] );
		expect( tokenize( setSink ) ).toEqual( [
			'set_sink',
			'foo bar',
			'sink node',
		] );
		expect( tokenize( connect ) ).toEqual( [
			'connect_node',
			'foo bar',
			'down stream',
		] );
	} );

	it( 'quotes each spaced target in a fan-out list', () => {
		const node = new Node();
		node.name = 'fan out';
		node.target = [ 'left leg', 'right leg' ];

		const lines = node.dumpConfig().split( '\n' ).slice( 1, 3 );
		expect( lines.map( ( l ) => tokenize( l ) ) ).toEqual( [
			[ 'connect_node', 'fan out', 'left leg' ],
			[ 'connect_node', 'fan out', 'right leg' ],
		] );
	} );
} );

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
		expect( msg[ TO ] ).toBe( '_http' ); // → HttpOut → request interpreter
		shell.parse( 'cd /' );
		const local = shell.parse( 'ls' );
		expect( local[ TO ] ).toBe( '' ); // → browser-internal interpreter
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

	it( 'clear wipes the Dumper transcript and fills nothing', () => {
		const { shell, filled, out } = makeShell();
		out.append( { kind: 'sent', text: 'ls' } );
		send( shell, 'clear' );
		expect( out.setStateCache.transcript ).toEqual( [] );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'debug_level with no arg toggles the Dumper and reports it', () => {
		const { shell, out } = makeShell();
		send( shell, 'debug_level' );
		expect( out.debugLevelRef.current ).toBe( 1 );
	} );

	it( 'debug_level with a numeric arg sets the Dumper to it', () => {
		const { shell, out } = makeShell();
		send( shell, 'debug_level 2' );
		expect( out.debugLevelRef.current ).toBe( 2 );
	} );

	it( 'debug_level out of range prints usage and changes nothing', () => {
		const { shell, filled } = makeShell();
		send( shell, 'debug_level 9' );
		expect( printedText() ).toContain( 'usage: debug_level [0|1|2]' );
		expect( filled ).toHaveLength( 0 );
	} );

	// parseInt stops at the first non-digit, so `2abc` read as 2 and silently
	// turned rendering ON at a level nobody asked for. PHP uses ctype_digit and
	// Tachikoma Shell.pm:158 refuses anything but ^\d+$.
	it( 'debug_level refuses a trailing-garbage argument', () => {
		const { shell, out } = makeShell();
		send( shell, 'debug_level 2abc' );
		expect( printedText() ).toContain( 'usage: debug_level [0|1|2]' );
		expect( out.debugLevelRef.current ).toBe( 0 );
	} );

	// Without a Dumper the verb did nothing AND said nothing — the normal case
	// for a Shell driving a TSL in worker scope. PHP names the missing node.
	it( 'debug_level reports the missing output node instead of going quiet', () => {
		const { shell } = makeShell();
		Core.unregisterNode( '_output' );
		send( shell, 'debug_level 1' );
		expect( printedText() ).toContain(
			'debug_level: unknown node: _output'
		);
	} );
} );

describe( 'Shell node — fill() reply path + TO', () => {
	it( 'fill() of a typed line stamps the bare reply-node FROM and TO=prefix(path)', () => {
		const { shell, filled } = makeShell( { path: 'demo.p0' } );
		send( shell, 'ls -al' );
		expect( filled ).toHaveLength( 1 );
		const m = filled[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		// FROM is the bare reply node; _sse wraps it downstream.
		expect( m[ FROM ] ).toBe( '_output' );
		expect( m[ TO ] ).toBe( 'demo.p0' );
		expect( m[ VALUE ] ).toMatchObject( {
			name: 'ls',
			arguments: [ '-al' ],
		} );
	} );

	it( 'fill() of a builtin acts and fills nothing', () => {
		const { shell, filled, out } = makeShell();
		out.append( { kind: 'sent', text: 'ls' } );
		send( shell, 'clear' );
		expect( out.setStateCache.transcript ).toEqual( [] );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'increments the base Node counter on each fill', () => {
		const { shell } = makeShell();
		send( shell, 'ls' );
		send( shell, 'ls' );
		expect( shell.counter ).toBe( 2 );
	} );

	// TYPE is a bitmask (ADR-2): a composite EOF must still drain, matching
	// PHP `$type & Message::TM_EOF`.
	it( 'drains a composite TM_EOF|TM_NOREPLY like a bare TM_EOF', () => {
		const { shell, filled } = makeShell( { path: 'depot.p7' } );
		expect( shell.parse( 'print half a statement\\' ) ).toBeNull();
		const m = [];
		m[ TYPE ] = TM_EOF | TM_NOREPLY;
		m[ FROM ] = 'stdin/9137';
		m[ TO ] = 'somewhere/else';
		m[ ID ] = '';
		m[ KEY ] = '';
		m[ TIMESTAMP ] = 0;
		m[ VALUE ] = '';
		shell.fill( m );
		expect( printedText() ).toMatch( /got EOF while waiting for tokens/ );
		expect( filled ).toHaveLength( 1 );
		expect( filled[ 0 ][ FROM ] ).toBe( '_output' );
		expect( filled[ 0 ][ TO ] ).toBe( 'depot.p7' );
	} );
} );

describe( 'Shell node — verb vocabulary (positional TM_* messages)', () => {
	const drive = ( line, opts ) => {
		const { shell, filled } = makeShell( opts );
		send( shell, line );
		return { m: filled[ 0 ], filled, printed };
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
		const { filled } = drive( 'tell' );
		expect( printedText() ).toContain( 'usage: tell <path> <bytes>' );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'send <node> <bytes> → TM_BYTESTREAM, newline-terminated VALUE', () => {
		const { m } = drive( 'send my_node payload' );
		expect( m[ TYPE ] ).toBe( TM_BYTESTREAM );
		expect( m[ TO ] ).toBe( '_http/demo.p0/my_node' );
		expect( m[ VALUE ] ).toBe( 'payload\n' );
	} );

	it( 'send_struct <node> <json> → TM_STRUCT with the decoded object as VALUE', () => {
		// JSON single-quoted → one token, inner double-quotes intact.
		const { m } = drive( 'send_struct my_node \'{"foo":23,"bar":42}\'' );
		expect( m[ TYPE ] ).toBe( TM_STRUCT );
		expect( m[ TO ] ).toBe( '_http/demo.p0/my_node' );
		expect( m[ VALUE ] ).toMatchObject( { foo: 23, bar: 42 } );
	} );

	it( 'send_struct with no node → error signal', () => {
		const { filled } = drive( 'send_struct' );
		expect( printedText() ).toContain( 'usage: send_struct <path> <json>' );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'send_struct with invalid JSON → error signal, sends nothing', () => {
		const { filled } = drive( "send_struct my_node '{bad json}'" );

		expect( printedText() ).toContain( 'send_struct' );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'send_eof <node> → TM_EOF, no VALUE', () => {
		const { m } = drive( 'send_eof my_node' );
		expect( m[ TYPE ] ).toBe( TM_EOF );
		expect( m[ TO ] ).toBe( '_http/demo.p0/my_node' );
	} );

	it( 'send_eof with no node → error signal', () => {
		drive( 'send_eof' );
		expect( printedText() ).toContain( 'usage: send_eof <path>' );
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
		expect( m[ VALUE ] ).toMatchObject( {
			name: 'dump_metadata',
			arguments: [],
		} );
	} );

	it( 'cmd with only a path → error signal', () => {
		drive( 'cmd only_path' );
		expect( printedText() ).toContain(
			'usage: cmd <path> <verb> [<args>]'
		);
	} );

	it( 'a bare verb defaults to TM_COMMAND at the cwd (path)', () => {
		const { m } = drive( 'make_node Echo my_node' );
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( '_http/demo.p0' );
		expect( m[ VALUE ] ).toMatchObject( {
			name: 'make_node',
			arguments: [ 'Echo', 'my_node' ],
		} );
	} );

	it( 'does NOT intercept `help` — it goes to the worker', () => {
		const { m } = drive( 'help' );
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ VALUE ].name ).toBe( 'help' );
		expect( m[ VALUE ].arguments ).toMatchObject( [] );
	} );
} );

describe( 'Shell node — settable path (cwd) + prefix', () => {
	it( 'empty path leaves TO at the bare node target', () => {
		const { shell, filled } = makeShell( { path: '' } );
		send( shell, 'tell n hi' );
		expect( filled[ 0 ][ TO ] ).toBe( 'n' );
	} );

	it( 'path-only (no node) routes a bare verb to the cwd', () => {
		const { shell, filled } = makeShell( { path: '_http/demo.p0' } );
		send( shell, 'ls' );
		expect( filled[ 0 ][ TO ] ).toBe( '_http/demo.p0' );
	} );
} );

describe( 'Shell node — anonymity', () => {
	it( 'has no node name (anonymous, like the PHP Shell)', () => {
		const { shell } = makeShell();
		expect( shell.name ).toBe( '' );
	} );
} );

describe( 'Shell node — pwd', () => {
	it( 'pwd → TM_COMMAND name=pwd targeting the bare cwd (not prefixed)', () => {
		const { shell, filled } = makeShell( { path: '_http/demo.p0' } );
		send( shell, 'pwd' );
		const m = filled[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( '_http/demo.p0' );
		expect( m[ VALUE ] ).toMatchObject( {
			name: 'pwd',
			arguments: [ '_http/demo.p0' ],
		} );
	} );

	it( 'pwd at the local root → TO empty, arguments empty', () => {
		const { shell, filled } = makeShell( { path: '' } );
		send( shell, 'pwd' );
		const m = filled[ 0 ];
		expect( m[ TO ] ).toBe( '' );
		expect( m[ VALUE ] ).toMatchObject( {
			name: 'pwd',
			arguments: [],
		} );
	} );
} );

describe( 'Shell node — var + interpolation', () => {
	it( 'var <name> = <value> sets a variable and returns null (no fill)', () => {
		const { shell, filled } = makeShell();
		expect( shell.parse( 'var greeting = hello world' ) ).toBeNull();
		expect( shell.vars.greeting ).toBe( 'hello world' );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'var with a `:` name is rejected with an error signal', () => {
		const { shell } = makeShell();
		send( shell, 'var config:x = 1' );
		expect( printedText() ).toContain( 'config:x' );
		expect( shell.vars[ 'config:x' ] ).toBeUndefined();
	} );

	it( 'var with no `=` fails loud with an error signal', () => {
		const { shell } = makeShell();
		send( shell, 'var greeting hello' );
		expect( shell.vars.greeting ).toBeUndefined();
	} );

	it( 'var name=value without spaces sets the variable', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'var spam=eggs' ) ).toBeNull();
		expect( shell.vars.spam ).toBe( 'eggs' );
	} );

	it( 'var splits on the first `=`, keeping `=` in the value', () => {
		const { shell } = makeShell();
		shell.parse( 'var url=a=b' );
		expect( shell.vars.url ).toBe( 'a=b' );
	} );

	it( 'interpolates <var> into a later command line', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.parse( 'var node = my_node' );
		send( shell, 'tell <node> hi there' );
		const m = filled[ 0 ];
		expect( m[ TO ] ).toBe( 'my_node' );
		expect( m[ VALUE ] ).toBe( 'hi there' );
	} );

	it( 'interpolates <config:foo> from the config map', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.config = { base: 'firehose-in' };
		send( shell, 'ping <config:base>' );
		expect( filled[ 0 ][ TO ] ).toBe( 'firehose-in' );
	} );

	it( 'unknown <var> interpolates to empty, warning like Shell3 get_shared', () => {
		const { shell, filled } = makeShell( { path: '' } );
		const warn = jest
			.spyOn( Core, '_stderr' )
			.mockImplementation( () => {} );
		send( shell, 'tell <missing>node hi' );
		// `<missing>` → '' so the token is `node`.
		expect( filled[ 0 ][ TO ] ).toBe( 'node' );
		expect( warn.mock.calls.join( ' ' ) ).toContain(
			'use of uninitialized value <missing>'
		);
		warn.mockRestore();
	} );

	it( 'does NOT interpolate inside single quotes (literal, quotes preserved)', () => {
		const { shell } = makeShell();
		shell.vars.who = 'alice';
		expect( shell.interpolate( "echo '<who>'" ) ).toBe( "echo '<who>'" );
	} );

	it( 'does NOT interpolate inside backticks', () => {
		const { shell } = makeShell();
		shell.vars.who = 'alice';
		expect( shell.interpolate( 'echo `<who>`' ) ).toBe( 'echo `<who>`' );
	} );

	it( 'still interpolates inside double quotes', () => {
		const { shell } = makeShell();
		shell.vars.who = 'alice';
		expect( shell.interpolate( 'echo "<who>"' ) ).toBe( 'echo "alice"' );
	} );

	it( 'mixed quoting: expands unquoted, defers single-quoted (Topic template idiom)', () => {
		const { shell } = makeShell();
		shell.config = { logs_dir: '/logs' };
		// <config:logs_dir> expands now; '<partition>' is deferred for Topic.
		expect(
			shell.interpolate( "<config:logs_dir>/jobs.p'<partition>'" )
		).toBe( "/logs/jobs.p'<partition>'" );
		expect(
			shell.tokenize(
				shell.interpolate( "<config:logs_dir>/jobs.p'<partition>'" )
			)
		).toEqual( [ '/logs/jobs.p<partition>' ] );
	} );
} );

describe( 'Shell node — echo / status / show_parse', () => {
	it( 'print → the joined text out through _output, nothing filled', () => {
		const { shell, filled } = makeShell();
		send( shell, 'print hello world' );
		expect( printedText() ).toBe( 'hello world' );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'show_parse toggles its own flag and reports the new state', () => {
		const { shell } = makeShell();
		send( shell, 'show_parse' );
		expect( printedText() ).toContain( 'show_parse: on' );
		send( shell, 'show_parse' );
		expect( printedText() ).toContain( 'show_parse: off' );
	} );

	it( 'status prints each configured line', () => {
		const { shell } = makeShell();
		shell.statusLines = [ 'one', 'two' ];
		send( shell, 'status' );
		expect( printedText() ).toBe( 'one\ntwo\n' );
	} );
} );

describe( 'Shell node — control-flow verbs flow through as commands (no forbidden list)', () => {
	it.each( [ 'if', 'while', 'for', 'func', 'eval', 'unless', 'until' ] )(
		'%s → a TM_COMMAND (the target interpreter answers "unknown command")',
		( verb ) => {
			const { shell } = makeShell();
			const msg = shell.parse( `${ verb } x` );
			expect( Array.isArray( msg ) ).toBe( true );
			expect( msg[ TYPE ] ).toBe( TM_COMMAND );
			expect( msg[ VALUE ].name ).toBe( verb );
		}
	);
} );

describe( 'Shell node — include (browser-adapted)', () => {
	it( 'include → an error through _output, unsupported in the browser', () => {
		const { shell, filled } = makeShell();
		send( shell, 'include /some/file' );
		expect( printedText() ).toContain( 'include' );
		expect( filled ).toHaveLength( 0 );
	} );
} );

describe( 'Shell node — quote-aware tokenization (PHP parity)', () => {
	it( 'var x = "a b" stores the quoted value with quotes stripped', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'var x = "a b"' ) ).toBeNull();
		expect( shell.vars.x ).toBe( 'a b' );
	} );

	it( 'var joins trailing tokens with single spaces (runs collapsed)', () => {
		const { shell } = makeShell();
		shell.parse( 'var x = a   b    c' );
		expect( shell.vars.x ).toBe( 'a b c' );
	} );

	it( 'bare verb args are tokens; a quoted arg survives as ONE token', () => {
		const { shell } = makeShell( { path: '' } );
		const m = shell.parse( 'foo a   "b c"' );
		expect( m[ VALUE ] ).toMatchObject( {
			name: 'foo',
			arguments: [ 'a', 'b c' ],
		} );
	} );

	it( 'send <node> "hello world" → body has quotes stripped, runs collapsed', () => {
		const { shell, filled } = makeShell( { path: '' } );
		send( shell, 'send demo.p0 "hello world"' );
		expect( filled[ 0 ][ TO ] ).toBe( 'demo.p0' );
		expect( filled[ 0 ][ VALUE ] ).toBe( 'hello world\n' );
	} );

	it( 'tell quoted body strips quotes; spaces inside the quotes are kept', () => {
		const { shell, filled } = makeShell( { path: '' } );
		send( shell, "tell n 'a    b'" );
		expect( filled[ 0 ][ VALUE ] ).toBe( 'a    b' );
	} );

	it( 'tell collapses runs of UNquoted whitespace between tokens', () => {
		const { shell, filled } = makeShell( { path: '' } );
		send( shell, 'tell n hello   world' );
		expect( filled[ 0 ][ VALUE ] ).toBe( 'hello world' );
	} );

	it( 'cmd args are slice(2) tokens; a quoted arg stays one token', () => {
		const { shell, filled } = makeShell( { path: '' } );
		send( shell, 'cmd n verb a   "b c"' );
		expect( filled[ 0 ][ VALUE ] ).toMatchObject( {
			name: 'verb',
			arguments: [ 'a', 'b c' ],
		} );
	} );

	it( 'print collapses whitespace runs and strips quotes', () => {
		const { shell } = makeShell();
		send( shell, 'print a   "b c"' );
		expect( printedText() ).toBe( 'a b c' );
	} );

	it( 'request args join slice(1) with single spaces', () => {
		const { shell, filled } = makeShell( { path: '' } );
		send( shell, 'request n a   b' );
		expect( filled[ 0 ][ VALUE ] ).toBe( 'a b' );
	} );

	it( 'tokenize exposes the PHP quote-aware tokenizer', () => {
		const { shell } = makeShell();
		expect( shell.tokenize( 'a   "b c" d' ) ).toEqual( [
			'a',
			'b c',
			'd',
		] );
		expect( shell.tokenize( 'x ""' ) ).toEqual( [ 'x', '' ] );
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

describe( 'Shell node — want_reply / TM_NOREPLY (script/topology mode)', () => {
	it( 'want_reply() defaults to true and reads back', () => {
		const { shell } = makeShell();
		expect( shell.wantReply() ).toBe( true );
	} );

	it( 'want_reply(false) sets and reads back false', () => {
		const { shell } = makeShell();
		expect( shell.wantReply( false ) ).toBe( false );
		expect( shell.wantReply() ).toBe( false );
	} );

	it( 'a command parsed while want_reply is true does NOT carry TM_NOREPLY', () => {
		const { shell } = makeShell( { path: '' } );
		const m = shell.parse( 'make_node Echo n' );
		expect( m[ TYPE ] & TM_NOREPLY ).toBeFalsy();
		expect( m[ TYPE ] & TM_COMMAND ).toBeTruthy();
	} );

	it( 'a command parsed while want_reply is false carries TM_NOREPLY', () => {
		const { shell } = makeShell( { path: '' } );
		shell.wantReply( false );
		const m = shell.parse( 'make_node Echo n' );
		expect( m[ TYPE ] & TM_NOREPLY ).toBeTruthy();
		expect( m[ TYPE ] & TM_COMMAND ).toBeTruthy();
	} );

	it( 'want_reply(false) does NOT stamp TM_NOREPLY onto a non-command (a tell)', () => {
		const { shell } = makeShell( { path: '' } );
		shell.wantReply( false );
		const m = shell.parse( 'tell n hi' );
		expect( m[ TYPE ] & TM_NOREPLY ).toBeFalsy();
		expect( m[ TYPE ] ).toBe( TM_INFO );
	} );

	it( 'a command respects want_reply(false) and stamps TM_NOREPLY', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.wantReply( false );
		send( shell, 'connect_node a b' );
		expect( filled ).toHaveLength( 1 );
		expect( filled[ 0 ][ TYPE ] & TM_NOREPLY ).toBeTruthy();
	} );
} );

describe( 'Shell node — name guard', () => {
	it( 'Shell refuses to be named', () => {
		const s = new ShellNode();
		expect( () => ( s.name = 'x' ) ).toThrow( /shell.*not.*named/i );
	} );
} );

describe( 'Shell node — undocumented skin builtins', () => {
	it( 'list_skins calls the host, never a filled message', () => {
		const { shell, filled } = makeShell();
		let listed = 0;
		shell.host.listSkins = () => listed++;
		send( shell, 'list_skins' );
		expect( listed ).toBe( 1 );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'set_skin hands the host the joined raw name', () => {
		const { shell, filled } = makeShell();
		const skins = [];
		shell.host.setSkin = ( n ) => skins.push( n );
		send( shell, 'set_skin CRT Phosphor' );
		expect( skins ).toEqual( [ 'CRT Phosphor' ] );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'set_skin with a single-word name carries that word', () => {
		const { shell } = makeShell();
		const skins = [];
		shell.host.setSkin = ( n ) => skins.push( n );
		send( shell, 'set_skin Newspack' );
		expect( skins ).toEqual( [ 'Newspack' ] );
	} );

	it( 'set_skin with no argument prints the usage', () => {
		const { shell, filled } = makeShell();
		send( shell, 'set_skin' );
		expect( printedText() ).toContain( 'usage: set_skin <name>' );
		expect( filled ).toHaveLength( 0 );
	} );
} );

describe( 'Shell node — message.from / message.key / message.id vars', () => {
	it( 'stamps KEY from the message.key var at mint (Shell3.pm:2241)', () => {
		const { shell } = makeShell();
		shell.parse( 'var message.key = trace-77' );
		expect( shell.parse( 'send node bytes' )[ KEY ] ).toBe( 'trace-77' );
	} );

	it( 'stamps KEY on every verb that mints, not just send', () => {
		const { shell } = makeShell();
		shell.parse( 'var message.key = trace-77' );
		expect( shell.parse( 'tell node info' )[ KEY ] ).toBe( 'trace-77' );
		expect( shell.parse( 'request node q' )[ KEY ] ).toBe( 'trace-77' );
		expect( shell.parse( 'cmd node ls' )[ KEY ] ).toBe( 'trace-77' );
	} );

	it( 'stamps ID from the message.id var at mint', () => {
		const { shell } = makeShell();
		shell.parse( 'var message.id = 4242' );
		expect( shell.parse( 'send node bytes' )[ ID ] ).toBe( '4242' );
	} );

	it( 'overrides the reply-path FROM from the message.from var', () => {
		const { shell } = makeShell();
		shell.parse( 'var message.from = elsewhere/sink' );
		expect( shell.parse( 'send node bytes' )[ FROM ] ).toBe(
			'elsewhere/sink'
		);
	} );

	it( 'falls back to the session reply node when message.from is unset', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'send node bytes' )[ FROM ] ).toBe(
			shell.replyFrom( names.OUTPUT )
		);
	} );

	it( 'stamps TIMESTAMP from the message.timestamp var at mint', () => {
		const { shell } = makeShell();
		shell.parse( 'var message.timestamp = 1700000000' );
		expect( shell.parse( 'send node bytes' )[ TIMESTAMP ] ).toBe(
			'1700000000'
		);
	} );

	it( 'keeps the mint clock when message.timestamp is unset', () => {
		const { shell } = makeShell();
		const stamped = shell.parse( 'send node bytes' )[ TIMESTAMP ];
		expect( typeof stamped ).toBe( 'number' );
		expect( stamped ).toBeGreaterThan( 0 );
	} );

	it( 'leaves KEY and ID empty when the vars are unset', () => {
		const { shell } = makeShell();
		const m = shell.parse( 'send node bytes' );
		expect( m[ KEY ] ).toBe( '' );
		expect( m[ ID ] ).toBe( '' );
	} );
} );

describe( 'Shell node — Tachikoma var semantics (Shell3 parity)', () => {
	it( 'bare `var` lists every var as name=value, sorted', () => {
		const { shell } = makeShell();
		send( shell, 'var zebra = last' );
		send( shell, 'var apple = first' );
		send( shell, 'var' );
		expect( printedText() ).toBe( 'apple=first\nzebra=last\n' );
	} );

	it( '`var <name>` prints the value verbatim', () => {
		const { shell } = makeShell();
		send( shell, 'var foo = bar' );
		send( shell, 'var foo' );
		expect( printedText() ).toBe( 'bar' );
	} );

	it( 'reading an unset var defines it as empty (Shell3.pm:2715)', () => {
		const { shell } = makeShell();
		shell.parse( 'var ghost' );
		expect( shell.vars.ghost ).toBe( '' );
	} );

	it( '`var <name> =` with no value deletes the var (Shell3.pm:2839)', () => {
		const { shell } = makeShell();
		shell.parse( 'var doomed = alive' );
		shell.parse( 'var doomed =' );
		expect( 'doomed' in shell.vars ).toBe( false );
	} );

	it( 'applies the documented operator set', () => {
		const { shell } = makeShell();
		shell.parse( 'var s = ab' );
		shell.parse( 'var s .= cd' );
		expect( shell.vars.s ).toBe( 'ab cd' );

		shell.parse( 'var n = 10' );
		shell.parse( 'var n += 5' );
		expect( shell.vars.n ).toBe( '15' );
		shell.parse( 'var n -= 3' );
		expect( shell.vars.n ).toBe( '12' );
		shell.parse( 'var n *= 2' );
		expect( shell.vars.n ).toBe( '24' );
		shell.parse( 'var n /= 4' );
		expect( shell.vars.n ).toBe( '6' );
		shell.parse( 'var n ++' );
		expect( shell.vars.n ).toBe( '7' );
		shell.parse( 'var n --' );
		expect( shell.vars.n ).toBe( '6' );
	} );

	it( '//= fills only an unset var; ||= also replaces an empty one', () => {
		const { shell } = makeShell();
		shell.parse( 'var a = kept' );
		shell.parse( 'var a //= ignored' );
		expect( shell.vars.a ).toBe( 'kept' );

		shell.parse( 'var c' );
		shell.parse( 'var c //= kept-empty' );
		expect( shell.vars.c ).toBe( '' );
		shell.parse( 'var c ||= replaced' );
		expect( shell.vars.c ).toBe( 'replaced' );
	} );

	it( 'a commented line is inert — its <tokens> must not warn', () => {
		const { shell } = makeShell();
		const warn = jest
			.spyOn( Core, '_stderr' )
			.mockImplementation( () => {} );

		expect(
			shell.parse( '#   make_node Remote_Source spoke-<id> <vault-id>' )
		).toBeNull();
		expect( shell.parse( '    # spoke-<id>' ) ).toBeNull();
		expect( warn ).not.toHaveBeenCalled();
		warn.mockRestore();
	} );

	it( 'interpolating an undefined var warns; a defined-empty one is silent', () => {
		const { shell } = makeShell();
		const warn = jest
			.spyOn( Core, '_stderr' )
			.mockImplementation( () => {} );

		expect( shell.interpolate( 'tell <ghost> hello' ) ).toBe(
			'tell  hello'
		);
		// Shell3 prints this one raw — no timestamp, no argv0, no prefix.
		expect( warn ).toHaveBeenCalledWith(
			'WARNING: use of uninitialized value <ghost>\n'
		);

		warn.mockClear();
		shell.parse( 'var hollow' );
		expect( shell.interpolate( 'tell <hollow> hello' ) ).toBe(
			'tell  hello'
		);
		expect( warn ).not.toHaveBeenCalled();
		warn.mockRestore();
	} );
} );

describe( 'Shell node — quote-typed escapes (Shell3 string1/string2)', () => {
	it( 'double quotes expand escape sequences', () => {
		const { shell } = makeShell();
		expect( shell.tokenize( '"foo\\nbar\\n"' ) ).toEqual( [
			'foo\nbar\n',
		] );
		expect( shell.tokenize( '"a\\tb"' ) ).toEqual( [ 'a\tb' ] );
		expect( shell.tokenize( '"a\\rb"' ) ).toEqual( [ 'a\rb' ] );
		expect( shell.tokenize( '"a\\eb"' ) ).toEqual( [ 'a\x1bb' ] );
	} );

	it( 'double quotes unescape the literal chars', () => {
		const { shell } = makeShell();
		expect( shell.tokenize( '"say \\"hi\\""' ) ).toEqual( [ 'say "hi"' ] );
		expect( shell.tokenize( '"a\\\\b"' ) ).toEqual( [ 'a\\b' ] );
		expect( shell.tokenize( '"\\<literal\\>"' ) ).toEqual( [
			'<literal>',
		] );
	} );

	it( 'single quotes keep escape sequences literal', () => {
		const { shell } = makeShell();
		expect( shell.tokenize( "'foo\\nbar'" ) ).toEqual( [ 'foo\\nbar' ] );
		expect( shell.tokenize( "'it\\'s'" ) ).toEqual( [ "it's" ] );
		expect( shell.tokenize( "'a\\\\b'" ) ).toEqual( [ 'a\\b' ] );
	} );
} );

describe( 'Shell node — comments and unquoted escapes (Shell3 parity)', () => {
	it( 'drops a trailing comment from the tokens', () => {
		const { shell } = makeShell();
		expect(
			shell.tokenize( 'make_node Log foo   # the request log' )
		).toEqual( [ 'make_node', 'Log', 'foo' ] );
	} );

	it( 'keeps a `#` inside quotes as content', () => {
		const { shell } = makeShell();
		expect( shell.tokenize( 'send "a # b"' ) ).toEqual( [
			'send',
			'a # b',
		] );
		expect( shell.tokenize( "send '#fff'" ) ).toEqual( [ 'send', '#fff' ] );
	} );

	it( 'lets a `#` end the token it interrupts', () => {
		const { shell } = makeShell();
		expect( shell.tokenize( 'foo#bar' ) ).toEqual( [ 'foo' ] );
	} );

	it( 'does not interpolate a trailing comment', () => {
		const { shell } = makeShell();
		const warn = jest
			.spyOn( Core, 'stderr' )
			.mockImplementation( () => {} );

		expect( shell.interpolate( 'tell node hi  # see <id>' ) ).toBe(
			'tell node hi  # see <id>'
		);
		expect( warn ).not.toHaveBeenCalled();
		warn.mockRestore();
	} );

	it( 'does not split on a `;` inside a trailing comment', () => {
		expect( splitStatements( 'make_node Log foo # a; b' ) ).toEqual( [
			'make_node Log foo # a; b',
		] );
	} );

	it( 'escapes the next char outside quotes (Shell3 string4)', () => {
		const { shell } = makeShell();
		const bs = String.fromCharCode( 92 );
		expect( shell.tokenize( `echo foo ${ bs }# bar` ) ).toEqual( [
			'echo',
			'foo',
			'#',
			'bar',
		] );
		expect( shell.tokenize( `echo a${ bs } b` ) ).toEqual( [
			'echo',
			'a b',
		] );
		expect( shell.tokenize( `echo a${ bs }${ bs }b` ) ).toEqual( [
			'echo',
			`a${ bs }b`,
		] );
	} );

	it( 'does not treat an escaped `<` as a variable opener', () => {
		const { shell } = makeShell();
		const bs = String.fromCharCode( 92 );
		shell.vars.who = 'alice';
		expect( shell.interpolate( `echo ${ bs }<who>` ) ).toBe(
			`echo ${ bs }<who>`
		);
		expect(
			shell.tokenize( shell.interpolate( `echo ${ bs }<who>` ) )
		).toEqual( [ 'echo', '<who>' ] );
	} );

	it( 'does not split on an escaped `;`', () => {
		const bs = String.fromCharCode( 92 );
		expect( splitStatements( `echo a${ bs }; b` ) ).toEqual( [
			`echo a${ bs }; b`,
		] );
	} );
} );

describe( 'Shell node — var value/print edges (Shell3 parity)', () => {
	it( 'sets empty for a whitespace-only value instead of deleting', () => {
		const { shell } = makeShell();
		shell.parse( 'var foo = bar' );
		shell.parse( 'var foo = "\\n"' );
		expect( 'foo' in shell.vars ).toBe( true );
		expect( shell.vars.foo ).toBe( '' );
	} );

	it( 'deletes only when no value follows the operator', () => {
		const { shell } = makeShell();
		shell.parse( 'var foo = bar' );
		shell.parse( 'var foo =' );
		expect( 'foo' in shell.vars ).toBe( false );
	} );

	it( 'prints a read value verbatim, so an empty one prints nothing', () => {
		const { shell } = makeShell();
		send( shell, 'var foo = bar' );
		send( shell, 'var foo' );
		expect( printedText() ).toBe( 'bar' );

		send( shell, 'var hollow' );
		expect( printedText() ).toBe( 'bar' );
	} );

	it( 'prints nothing for a bare `var` with an empty store', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'var' ) ).toBeNull();
	} );
} );

/**
 * The static front-end must MEAN what the runtime means: replaying a canonical
 * statement at the root cwd mints the Message parse() minted at the live cwd.
 * Mirrors PHP tests/unit/StatementRuntimeParityTest.php.
 */
describe( 'parseStatements — static statements replay to runtime messages', () => {
	const SCRIPT = [
		'cd depot',
		'tell_node beacon status ok',
		'tell beacon short form',
		'ping beacon',
		'send_node beacon payload bytes',
		'send beacon short bytes',
		'send_struct_node beacon \'{"depth":9}\'',
		'request_node beacon fetch 7',
		'send_eof beacon',
		'command_node beacon ping',
		'cmd beacon set_retention --segments=41',
		'pwd',
		'rotate_now --after=13',
		'print holding at depot',
		'var depot_hint = 4271',
		'cd ..',
		'tell_node beacon top level',
		'command_node beacon ping',
		'ping beacon',
		'pwd',
		'rotate_now --after=13',
	];

	// TYPE/TO/VALUE — what the message says. `ping` carries the mint clock as
	// its VALUE, which no two runs share; normalize it.
	const meaning = ( m ) => {
		let value = m[ TYPE ] & TM_PING ? '<mint-clock>' : m[ VALUE ];
		if ( value && 'object' === typeof value ) {
			// commandAuth signs with a per-message nonce; drop it.
			const { auth, ...rest } = value;
			value = rest;
		}
		return { type: m[ TYPE ], to: m[ TO ], value };
	};

	const runLines = ( lines ) => {
		// makeShell registers `_stdout`; each run needs the graph to itself.
		Core.reset();
		const { shell, filled } = makeShell( { path: '' } );
		lines.forEach( ( line ) => send( shell, line ) );
		return filled.map( meaning );
	};

	it( 'replays every minting verb, at a cwd and at the root', () => {
		const statements = parseStatements( SCRIPT.join( '\n' ) );
		expect( runLines( statements.map( ( s ) => s.raw ) ) ).toEqual(
			runLines( SCRIPT )
		);
	} );

	// The skin builtins are the browser REPL's alone. A statement list reads a
	// TOPOLOGY, which the PHP loader runs, so it must read them as PHP will —
	// modelling this parse()'s extra verbs would misreport a real `.tsl`.
	it( 'reads the browser-only skin verbs as the cwd commands PHP sends', () => {
		const statements = parseStatements(
			'cd depot\nset_skin midnight\nlist_skins'
		);
		expect( statements.map( ( s ) => s.values ) ).toEqual( [
			[ 'command_node', 'depot', 'set_skin', 'midnight' ],
			[ 'command_node', 'depot', 'list_skins' ],
		] );
	} );

	it( 'reads `ping` as a command NAME after command_node, not the verb', () => {
		const statements = parseStatements(
			'command_node _command_interpreter ping\ncd depot\ncommand_node beacon ping'
		);
		expect( statements[ 0 ].values ).toEqual( [
			'command_node',
			'_command_interpreter',
			'ping',
		] );
		expect( statements[ 1 ].values ).toEqual( [
			'command_node',
			'depot/beacon',
			'ping',
		] );
	} );
} );
