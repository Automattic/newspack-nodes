import { formatCommandArgs, parseCommandArgs } from '../command-args';

// Mirrors the PHP CommandArgsTest: token arrays in and out, no quoting.
describe( 'parseCommandArgs', () => {
	it( 'yields no positionals and no options for an empty list', () => {
		expect( parseCommandArgs( [] ) ).toEqual( {
			positional: [],
			options: {},
		} );
	} );

	it( 'collects positionals in order', () => {
		expect( parseCommandArgs( [ 'spoke1', 'web1' ] ) ).toEqual( {
			positional: [ 'spoke1', 'web1' ],
			options: {},
		} );
	} );

	it( 'reads --key=value options', () => {
		const out = parseCommandArgs( [ '--url=https://x', '--limit=50' ] );
		expect( out.positional ).toEqual( [] );
		expect( out.options.url ).toBe( 'https://x' );
		expect( out.options.limit ).toBe( '50' );
	} );

	it( 'treats a bare --key as boolean true', () => {
		expect(
			parseCommandArgs( [ '--categories' ] ).options.categories
		).toBe( true );
	} );

	it( 'keeps an explicit false as a string', () => {
		expect(
			parseCommandArgs( [ '--enabled=false' ] ).options.enabled
		).toBe( 'false' );
	} );

	it( 'mixes positionals and options preserving positional order', () => {
		const out = parseCommandArgs( [
			'add',
			'spoke1',
			'--url=https://x',
			'--enabled=false',
		] );
		expect( out.positional ).toEqual( [ 'add', 'spoke1' ] );
		expect( out.options.url ).toBe( 'https://x' );
		expect( out.options.enabled ).toBe( 'false' );
	} );

	it( 'keeps a comma-list value intact', () => {
		expect(
			parseCommandArgs( [ '--breakdown=server,status' ] ).options
				.breakdown
		).toBe( 'server,status' );
	} );

	it( 'keeps a spaced value token verbatim', () => {
		expect(
			parseCommandArgs( [ '--search=foo bar baz' ] ).options.search
		).toBe( 'foo bar baz' );
	} );

	it( 'keeps an equals in the value', () => {
		expect( parseCommandArgs( [ '--expr=a=b' ] ).options.expr ).toBe(
			'a=b'
		);
	} );
} );

describe( 'formatCommandArgs', () => {
	it( 'returns positionals as tokens', () => {
		expect( formatCommandArgs( [ 'spoke1', 'web1' ] ) ).toEqual( [
			'spoke1',
			'web1',
		] );
	} );

	it( 'renders --key=value options', () => {
		expect(
			formatCommandArgs( [ 'add', 'spoke1' ], { url: 'https://x' } )
		).toEqual( [ 'add', 'spoke1', '--url=https://x' ] );
	} );

	it( 'renders boolean true as a bare flag', () => {
		expect(
			formatCommandArgs( [ 'overview' ], { categories: true } )
		).toEqual( [ 'overview', '--categories' ] );
	} );

	it( 'renders boolean false as an explicit value', () => {
		expect( formatCommandArgs( [], { enabled: false } ) ).toEqual( [
			'--enabled=false',
		] );
	} );

	it( 'joins an array value with commas', () => {
		expect(
			formatCommandArgs( [], { logs: [ 'firehose.log', 'jobs.log' ] } )
		).toEqual( [ '--logs=firehose.log,jobs.log' ] );
	} );

	it( 'keeps a spaced value in one token', () => {
		expect( formatCommandArgs( [], { search: 'foo bar' } ) ).toEqual( [
			'--search=foo bar',
		] );
	} );

	it( 'round-trips a spaced value through parseCommandArgs', () => {
		const positional = [ 'add', 'spoke one' ];
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
