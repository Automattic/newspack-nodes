import { shellInterpret } from '../shellInterpret';

describe( 'shellInterpret', () => {
	it( 'returns null for empty input', () => {
		expect( shellInterpret( '' ) ).toBeNull();
		expect( shellInterpret( '   ' ) ).toBeNull();
	} );

	it( 'dispatches local builtins: clear / debug_level', () => {
		expect( shellInterpret( 'clear' ) ).toEqual( {
			kind: 'local',
			name: 'clear',
		} );
		expect( shellInterpret( 'debug_level' ) ).toEqual( {
			kind: 'local',
			name: 'debug_level',
			level: null,
		} );
		expect( shellInterpret( 'debug_level 2' ) ).toEqual( {
			kind: 'local',
			name: 'debug_level',
			level: 2,
		} );
		expect( shellInterpret( 'debug_level 9' ).kind ).toBe( 'error' );
	} );

	it( 'does NOT intercept `help` — it goes to the worker for the authoritative verb list', () => {
		expect( shellInterpret( 'help' ) ).toEqual( {
			kind: 'post',
			body: { type: 'command', name: 'help', arguments: '' },
		} );
	} );

	it( 'parses ping with no path', () => {
		expect( shellInterpret( 'ping' ) ).toEqual( {
			kind: 'post',
			body: { type: 'ping', to: '' },
		} );
	} );

	it( 'parses ping with a path', () => {
		expect( shellInterpret( 'ping firehose:tee' ) ).toEqual( {
			kind: 'post',
			body: { type: 'ping', to: 'firehose:tee' },
		} );
	} );

	it( 'parses tell / tell_node', () => {
		expect( shellInterpret( 'tell my_node hello world' ) ).toEqual( {
			kind: 'post',
			body: {
				type: 'info',
				to: 'my_node',
				arguments: 'hello world',
			},
		} );
		expect( shellInterpret( 'tell_node my_node hi' ).body.type ).toBe(
			'info'
		);
		expect( shellInterpret( 'tell' ).kind ).toBe( 'error' );
	} );

	it( 'parses send / send_node', () => {
		expect( shellInterpret( 'send my_node payload' ) ).toEqual( {
			kind: 'post',
			body: {
				type: 'bytestream',
				to: 'my_node',
				arguments: 'payload\n',
			},
		} );
		expect( shellInterpret( 'send' ).kind ).toBe( 'error' );
	} );

	it( 'parses send_eof', () => {
		expect( shellInterpret( 'send_eof my_node' ) ).toEqual( {
			kind: 'post',
			body: { type: 'eof', to: 'my_node' },
		} );
		expect( shellInterpret( 'send_eof' ).kind ).toBe( 'error' );
	} );

	it( 'parses request / request_node', () => {
		expect( shellInterpret( 'request my_node arg1 arg2' ) ).toEqual( {
			kind: 'post',
			body: {
				type: 'request',
				to: 'my_node',
				arguments: 'arg1 arg2',
			},
		} );
	} );

	it( 'parses cmd / command / command_node', () => {
		expect( shellInterpret( 'cmd firehose:tee dump' ) ).toEqual( {
			kind: 'post',
			body: {
				type: 'command',
				to: 'firehose:tee',
				name: 'dump',
				arguments: '',
			},
		} );
		expect(
			shellInterpret( 'command firehose:tee debug_state 2' )
		).toEqual( {
			kind: 'post',
			body: {
				type: 'command',
				to: 'firehose:tee',
				name: 'debug_state',
				arguments: '2',
			},
		} );
		expect( shellInterpret( 'cmd only_path' ).kind ).toBe( 'error' );
	} );

	it( 'default to TM_COMMAND at _command_interpreter', () => {
		expect( shellInterpret( 'ls -al' ) ).toEqual( {
			kind: 'post',
			body: { type: 'command', name: 'ls', arguments: '-al' },
		} );
		expect( shellInterpret( 'make_node Echo my_node' ) ).toEqual( {
			kind: 'post',
			body: {
				type: 'command',
				name: 'make_node',
				arguments: 'Echo my_node',
			},
		} );
	} );
} );

describe( 'splitStatements', () => {
	// Need the import at module scope; reuse via require to avoid touching
	// the top of the file. Jest hoists describe blocks but not imports here.
	// eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
	const { splitStatements } = require( '../shellInterpret' );

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

	it( 'preserves `;` inside single quotes', () => {
		expect( splitStatements( "tell my_node 'hello; world'; ls" ) ).toEqual(
			[ "tell my_node 'hello; world'", 'ls' ]
		);
	} );

	it( 'preserves `;` inside double quotes', () => {
		expect( splitStatements( 'tell my_node "a;b"; help' ) ).toEqual( [
			'tell my_node "a;b"',
			'help',
		] );
	} );

	it( 'preserves `;` inside backtick quotes', () => {
		expect( splitStatements( 'cmd target `inner; cmd`; ls' ) ).toEqual( [
			'cmd target `inner; cmd`',
			'ls',
		] );
	} );

	it( 'returns empty array for empty or whitespace input', () => {
		expect( splitStatements( '' ) ).toEqual( [] );
		expect( splitStatements( '   ' ) ).toEqual( [] );
		expect( splitStatements( ';;;' ) ).toEqual( [] );
	} );
} );
