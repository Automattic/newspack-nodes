import { formatCommandArgs } from '../command-args';

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
