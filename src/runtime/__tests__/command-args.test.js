import { bindCommandArgs, formatCommandArgs } from '../command-args';
import addSourceCases from '../../../tests/fixtures/add-source-args.json';
import brokerSchemas from '../../../tests/fixtures/broker-schemas.json';

// Mirrors the PHP CommandArgsTest: token arrays in and out, no quoting.
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
			formatCommandArgs( [], { logs: [ 'firehose.p0', 'jobs.log' ] } )
		).toEqual( [ '--logs=firehose.p0,jobs.log' ] );
	} );

	it( 'keeps a spaced value in one token', () => {
		expect( formatCommandArgs( [], { search: 'foo bar' } ) ).toEqual( [
			'--search=foo bar',
		] );
	} );
} );

// Held to PHP Command_Args::bind() by the same case list AddSourceArgsTest reads.
describe( 'bindCommandArgs', () => {
	const specs = brokerSchemas
		.find( ( entry ) => 'Remote_Source' === entry.shell_name )
		.commands.find( ( verb ) => 'add_source' === verb.name ).args;

	const bindings = addSourceCases.filter(
		( [ , , want ] ) => ! want.refused
	);
	const refusals = addSourceCases.filter( ( [ , , want ] ) => want.refused );

	it.each( bindings )( 'binds %s', ( label, tokens, expected ) => {
		expect( bindCommandArgs( specs, tokens ) ).toEqual( expected );
	} );

	it.each( refusals )( 'refuses %s', ( label, tokens, { refused } ) => {
		expect( () => bindCommandArgs( specs, tokens ) ).toThrow(
			new Error( refused )
		);
	} );
} );
