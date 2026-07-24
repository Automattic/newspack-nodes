/**
 * Shell node tests — typed-line parse → positional TM_* Message filled into the
 * sink, with FROM=`_http/<ssePid>/<reply-node>` and TO=prefix(path). Builtins
 * (clear/debug_level) return a local-signal object instead of filling. Mirrors
 * the verb vocabulary of the substrate PHP Shell + the old utils/shell.js.
 */

import {
	ShellNode,
	splitStatements,
	tokenize,
	tokenizeSpans,
	quoteToken,
} from '../shell-node';
import { Node, serializeArgs } from '../node';
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
	TM_STRUCT,
	TM_EOF,
	TM_REQUEST,
	TM_NOREPLY,
} from '../message';

function makeShell( { path = '_http/demo.p0', ssePid = 4242 } = {} ) {
	const shell = new ShellNode();
	shell.path = path;
	shell.ssePid = ssePid;
	const sink = new Node();
	const filled = [];
	sink.fill = ( m ) => filled.push( m );
	shell.sink = sink;
	return { shell, filled };
}

describe( 'tokenizeSpans — raw token spans (quote chars intact)', () => {
	it( 'splits like tokenize but preserves each token verbatim', () => {
		expect(
			tokenizeSpans( 'cmd scorer:config add_profile "Engineers care"' )
		).toEqual( [
			'cmd',
			'scorer:config',
			'add_profile',
			'"Engineers care"',
		] );
	} );

	it( 'keeps single quotes and backticks so interpolation intent survives', () => {
		expect(
			tokenizeSpans(
				"make_node Topic t <config:logs_dir>/jobs.p'<partition>' `lit`"
			)
		).toEqual( [
			'make_node',
			'Topic',
			't',
			"<config:logs_dir>/jobs.p'<partition>'",
			'`lit`',
		] );
	} );

	it( 'keeps escapes raw and aligns 1:1 with tokenize()', () => {
		const line = "a 'it\\'s' \"x y\" z";
		expect( tokenizeSpans( line ) ).toEqual( [
			'a',
			"'it\\'s'",
			'"x y"',
			'z',
		] );
		expect( tokenize( line ) ).toEqual( [ 'a', "it's", 'x y', 'z' ] );
	} );

	it( 'an empty quoted string is one raw span', () => {
		expect( tokenizeSpans( "a '' b" ) ).toEqual( [ 'a', "''", 'b' ] );
	} );
} );

describe( 'parse — backslash continuation splices with nothing', () => {
	it( 'holds the line, then splices bash-style (hi\\ + bye = hibye)', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'echo hi\\' ) ).toBeNull();
		expect( shell.hasPending() ).toBe( true );
		expect( shell.pendingPrompt() ).toBe( '> ' );
		const parsed = shell.parse( 'bye' );
		expect( parsed ).toEqual( {
			kind: 'local',
			name: 'echo',
			text: 'hibye',
		} );
		expect( shell.hasPending() ).toBe( false );
	} );

	it( 'flushPending reports a held backslash continuation at EOF', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'echo hi\\' ) ).toBeNull();
		const flushed = shell.flushPending();
		expect( flushed ).toEqual( {
			kind: 'error',
			text: expect.stringMatching( /got EOF while waiting for tokens/ ),
		} );
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
		const flushed = shell.flushPending();
		expect( flushed ).toEqual( {
			kind: 'error',
			text: expect.stringMatching( /got EOF while waiting for tokens/ ),
		} );
		expect( shell.flushPending() ).toBeNull();
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
	] )( 'serializeArgs round-trips %j through tokenize', ( tokens ) => {
		const back = tokenize( 'X Y ' + serializeArgs( tokens ) ).slice( 2 );
		expect( back ).toEqual( tokens );
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

describe( 'Shell node — fill() reply path + TO', () => {
	it( 'fill() of a typed line stamps the bare reply-node FROM and TO=prefix(path)', () => {
		const { shell, filled } = makeShell( { path: 'demo.p0' } );
		const signal = shell.fill( 'ls -al' );
		expect( signal ).toBeNull(); // a posted command returns null
		expect( filled ).toHaveLength( 1 );
		const m = filled[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		// FROM is the bare reply node; _sse wraps it downstream.
		expect( m[ FROM ] ).toBe( '_output' );
		expect( m[ TO ] ).toBe( 'demo.p0' );
		expect( m[ VALUE ] ).toEqual( {
			name: 'ls',
			arguments: [ '-al' ],
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

	it( 'send_struct <node> <json> → TM_STRUCT with the decoded object as VALUE', () => {
		// JSON single-quoted → one token, inner double-quotes intact.
		const { m } = drive( 'send_struct my_node \'{"foo":23,"bar":42}\'' );
		expect( m[ TYPE ] ).toBe( TM_STRUCT );
		expect( m[ TO ] ).toBe( '_http/demo.p0/my_node' );
		expect( m[ VALUE ] ).toEqual( { foo: 23, bar: 42 } );
	} );

	it( 'send_struct with no node → error signal', () => {
		const { signal, filled } = drive( 'send_struct' );
		expect( signal ).toEqual( {
			kind: 'error',
			text: 'usage: send_struct <path> <json>',
		} );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'send_struct with invalid JSON → error signal, sends nothing', () => {
		const { signal, filled } = drive( "send_struct my_node '{bad json}'" );
		expect( signal.kind ).toBe( 'error' );
		expect( signal.text ).toContain( 'send_struct' );
		expect( filled ).toHaveLength( 0 );
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
			arguments: [],
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
			arguments: [ 'Echo', 'my_node' ],
		} );
	} );

	it( 'does NOT intercept `help` — it goes to the worker', () => {
		const { m } = drive( 'help' );
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ VALUE ].name ).toBe( 'help' );
		expect( m[ VALUE ].arguments ).toEqual( [] );
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

describe( 'Shell node — pwd', () => {
	it( 'pwd → TM_COMMAND name=pwd targeting the bare cwd (not prefixed)', () => {
		const { shell, filled } = makeShell( { path: '_http/demo.p0' } );
		shell.fill( 'pwd' );
		const m = filled[ 0 ];
		expect( m[ TYPE ] ).toBe( TM_COMMAND );
		expect( m[ TO ] ).toBe( '_http/demo.p0' );
		expect( m[ VALUE ] ).toEqual( {
			name: 'pwd',
			arguments: [ '_http/demo.p0' ],
		} );
	} );

	it( 'pwd at the local root → TO empty, arguments empty', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.fill( 'pwd' );
		const m = filled[ 0 ];
		expect( m[ TO ] ).toBe( '' );
		expect( m[ VALUE ] ).toEqual( {
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
		const sig = shell.parse( 'var config:x = 1' );
		expect( sig.kind ).toBe( 'error' );
		expect( sig.text ).toContain( 'config:x' );
		expect( shell.vars[ 'config:x' ] ).toBeUndefined();
	} );

	it( 'var with no `=` fails loud with an error signal', () => {
		const { shell } = makeShell();
		const sig = shell.parse( 'var greeting hello' );
		expect( sig.kind ).toBe( 'error' );
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
		shell.fill( 'tell <node> hi there' );
		const m = filled[ 0 ];
		expect( m[ TO ] ).toBe( 'my_node' );
		expect( m[ VALUE ] ).toBe( 'hi there' );
	} );

	it( 'interpolates <config:foo> from the config map', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.config = { base: 'firehose-in' };
		shell.fill( 'ping <config:base>' );
		expect( filled[ 0 ][ TO ] ).toBe( 'firehose-in' );
	} );

	it( 'unknown <var> interpolates to empty', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.fill( 'tell <missing>node hi' );
		// `<missing>` → '' so the token is `node`.
		expect( filled[ 0 ][ TO ] ).toBe( 'node' );
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
	it( 'echo <args> → a local echo signal carrying the joined text', () => {
		const { shell, filled } = makeShell();
		expect( shell.parse( 'echo hello world' ) ).toEqual( {
			kind: 'local',
			name: 'echo',
			text: 'hello world',
		} );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'show_parse toggles and reports its new state via a local signal', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'show_parse' ) ).toEqual( {
			kind: 'local',
			name: 'show_parse',
			on: true,
		} );
		expect( shell.parse( 'show_parse' ) ).toEqual( {
			kind: 'local',
			name: 'show_parse',
			on: false,
		} );
	} );

	it( 'status → a local signal carrying the configured status lines', () => {
		const { shell } = makeShell();
		shell.statusLines = [ 'one', 'two' ];
		expect( shell.parse( 'status' ) ).toEqual( {
			kind: 'local',
			name: 'status',
			lines: [ 'one', 'two' ],
		} );
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
	it( 'include → an error signal noting it is unsupported in the browser', () => {
		const { shell, filled } = makeShell();
		const sig = shell.parse( 'include /some/file' );
		expect( sig.kind ).toBe( 'error' );
		expect( sig.text ).toContain( 'include' );
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
		expect( m[ VALUE ] ).toEqual( {
			name: 'foo',
			arguments: [ 'a', 'b c' ],
		} );
	} );

	it( 'send <node> "hello world" → body has quotes stripped, runs collapsed', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.fill( 'send demo.p0 "hello world"' );
		expect( filled[ 0 ][ TO ] ).toBe( 'demo.p0' );
		expect( filled[ 0 ][ VALUE ] ).toBe( 'hello world\n' );
	} );

	it( 'tell quoted body strips quotes; spaces inside the quotes are kept', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.fill( "tell n 'a    b'" );
		expect( filled[ 0 ][ VALUE ] ).toBe( 'a    b' );
	} );

	it( 'tell collapses runs of UNquoted whitespace between tokens', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.fill( 'tell n hello   world' );
		expect( filled[ 0 ][ VALUE ] ).toBe( 'hello world' );
	} );

	it( 'cmd args are slice(2) tokens; a quoted arg stays one token', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.fill( 'cmd n verb a   "b c"' );
		expect( filled[ 0 ][ VALUE ] ).toEqual( {
			name: 'verb',
			arguments: [ 'a', 'b c' ],
		} );
	} );

	it( 'echo collapses whitespace runs and strips quotes', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'echo a   "b c"' ) ).toEqual( {
			kind: 'local',
			name: 'echo',
			text: 'a b c',
		} );
	} );

	it( 'request args join slice(1) with single spaces', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.fill( 'request n a   b' );
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

	it( 'sendCommand respects want_reply(false) and stamps TM_NOREPLY', () => {
		const { shell, filled } = makeShell( { path: '' } );
		shell.wantReply( false );
		shell.sendCommand( '', 'connect_node', [ 'a', 'b' ] );
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
	it( 'list_skins → a local signal, never a filled message', () => {
		const { shell, filled } = makeShell();
		expect( shell.parse( 'list_skins' ) ).toEqual( {
			kind: 'local',
			name: 'list_skins',
		} );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'set_skin <name> → a local signal carrying the joined raw name', () => {
		const { shell, filled } = makeShell();
		expect( shell.parse( 'set_skin CRT Phosphor' ) ).toEqual( {
			kind: 'local',
			name: 'set_skin',
			skin: 'CRT Phosphor',
		} );
		expect( filled ).toHaveLength( 0 );
	} );

	it( 'set_skin with a single-word name carries that word', () => {
		const { shell } = makeShell();
		expect( shell.parse( 'set_skin Newspack' ) ).toEqual( {
			kind: 'local',
			name: 'set_skin',
			skin: 'Newspack',
		} );
	} );

	it( 'set_skin with no argument is a usage error', () => {
		const { shell, filled } = makeShell();
		expect( shell.parse( 'set_skin' ) ).toEqual( {
			kind: 'error',
			text: 'usage: set_skin <name>',
		} );
		expect( filled ).toHaveLength( 0 );
	} );
} );
