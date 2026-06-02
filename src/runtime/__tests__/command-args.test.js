import { formatCommandArgs, parseCommandArgs } from '../command-args';

describe( 'parseCommandArgs', () => {
	it( 'yields no positionals and no options for an empty string', () => {
		expect( parseCommandArgs( '' ) ).toEqual( {
			positional: [],
			options: {},
		} );
		expect( parseCommandArgs( '   ' ) ).toEqual( {
			positional: [],
			options: {},
		} );
	} );

	it( 'collects positionals in order', () => {
		expect( parseCommandArgs( 'spoke1 web1' ) ).toEqual( {
			positional: [ 'spoke1', 'web1' ],
			options: {},
		} );
	} );

	it( 'reads --key=value options', () => {
		const out = parseCommandArgs( '--url=https://x --limit=50' );
		expect( out.positional ).toEqual( [] );
		expect( out.options.url ).toBe( 'https://x' );
		expect( out.options.limit ).toBe( '50' );
	} );

	it( 'treats a bare --key as boolean true', () => {
		expect( parseCommandArgs( '--categories' ).options.categories ).toBe(
			true
		);
	} );

	it( 'keeps an explicit false as a string', () => {
		expect( parseCommandArgs( '--enabled=false' ).options.enabled ).toBe(
			'false'
		);
	} );

	it( 'mixes positionals and options preserving positional order', () => {
		const out = parseCommandArgs(
			'add spoke1 --url=https://x --enabled=false'
		);
		expect( out.positional ).toEqual( [ 'add', 'spoke1' ] );
		expect( out.options.url ).toBe( 'https://x' );
		expect( out.options.enabled ).toBe( 'false' );
	} );

	it( 'keeps a comma-list value intact', () => {
		expect(
			parseCommandArgs( '--breakdown=server,status' ).options.breakdown
		).toBe( 'server,status' );
	} );

	it( 'honors a double-quoted value with spaces', () => {
		expect(
			parseCommandArgs( '--search="foo bar baz"' ).options.search
		).toBe( 'foo bar baz' );
	} );

	it( 'unescapes quote and backslash inside quotes', () => {
		expect(
			parseCommandArgs( '--value="a \\"b\\" \\\\ c"' ).options.value
		).toBe( 'a "b" \\ c' );
	} );
} );

describe( 'formatCommandArgs', () => {
	it( 'joins positionals', () => {
		expect( formatCommandArgs( [ 'spoke1', 'web1' ] ) ).toBe(
			'spoke1 web1'
		);
	} );

	it( 'renders --key=value options', () => {
		expect(
			formatCommandArgs( [ 'add', 'spoke1' ], { url: 'https://x' } )
		).toBe( 'add spoke1 --url=https://x' );
	} );

	it( 'renders boolean true as a bare flag', () => {
		expect(
			formatCommandArgs( [ 'overview' ], { categories: true } )
		).toBe( 'overview --categories' );
	} );

	it( 'renders boolean false as an explicit value', () => {
		expect( formatCommandArgs( [], { enabled: false } ) ).toBe(
			'--enabled=false'
		);
	} );

	it( 'joins an array value with commas', () => {
		expect(
			formatCommandArgs( [], { logs: [ 'firehose.log', 'jobs.log' ] } )
		).toBe( '--logs=firehose.log,jobs.log' );
	} );

	it( 'quotes a value containing whitespace', () => {
		expect( formatCommandArgs( [], { search: 'foo bar' } ) ).toBe(
			'--search="foo bar"'
		);
	} );

	it( 'quotes and escapes an embedded quote', () => {
		expect( formatCommandArgs( [], { value: 'a "b"' } ) ).toBe(
			'--value="a \\"b\\""'
		);
	} );

	it( 'round-trips through parseCommandArgs', () => {
		const positional = [ 'add', 'spoke1' ];
		const options = {
			url: 'https://x',
			enabled: false,
			logs: 'a.log,b.log',
			search: 'foo bar',
		};
		const parsed = parseCommandArgs(
			formatCommandArgs( positional, options )
		);
		expect( parsed.positional ).toEqual( positional );
		expect( parsed.options.url ).toBe( 'https://x' );
		expect( parsed.options.enabled ).toBe( 'false' );
		expect( parsed.options.logs ).toBe( 'a.log,b.log' );
		expect( parsed.options.search ).toBe( 'foo bar' );
	} );
} );
