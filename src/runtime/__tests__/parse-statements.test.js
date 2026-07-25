/**
 * parseStatements — the JS TSL statement front-end, mirroring PHP
 * Shell_Node::parse_statements byte-for-byte: statement splitting (quote/`;`/
 * comment-aware), backslash continuation, alias canonicalization, cd/prefix
 * cwd resolution with the shell-builtin (var/include) carve-out, both token forms, 1-based
 * first-physical-line numbers, and NO interpolation. Unterminated quote throws.
 */

import { parseStatements } from '../shell-node';

describe( 'parseStatements', () => {
	it( 'canonicalizes verb aliases on values[0]', () => {
		const stmts = parseStatements(
			'make Topic feed\nconnect feed sink\ndisconnect feed sink\ncommand feed config\ncommand_node feed config'
		);
		expect( stmts.map( ( s ) => s.verb ) ).toEqual( [
			'make_node',
			'connect_node',
			'disconnect_node',
			'command_node',
			'command_node',
		] );
		// values[0] always equals the canonical verb.
		for ( const s of stmts ) {
			expect( s.values[ 0 ] ).toBe( s.verb );
		}
	} );

	it( 'splits a line on unquoted `;` into separate statements', () => {
		const stmts = parseStatements(
			'make_node Topic alpha; make_node Topic bravo'
		);
		expect( stmts.map( ( s ) => s.values[ 2 ] ) ).toEqual( [
			'alpha',
			'bravo',
		] );
	} );

	it( 'shields a quoted `;` from statement splitting', () => {
		const stmts = parseStatements( "cmd sink echo 'a ; b'" );
		expect( stmts ).toHaveLength( 1 );
		expect( stmts[ 0 ].values ).toEqual( [
			'command_node',
			'sink',
			'echo',
			'a ; b',
		] );
	} );

	it( 'joins a trailing-backslash continuation, keeping the first line', () => {
		const stmts = parseStatements(
			'make_node Consumer big \\\n  /log/path \\\n  /offsets/path'
		);
		expect( stmts ).toHaveLength( 1 );
		expect( stmts[ 0 ].values ).toEqual( [
			'make_node',
			'Consumer',
			'big',
			'/log/path',
			'/offsets/path',
		] );
		expect( stmts[ 0 ].line ).toBe( 1 );
	} );

	it( 'drops blank and whole-line comment statements', () => {
		const stmts = parseStatements(
			'# a comment\n\nmake_node Topic solo\n# trailing comment'
		);
		expect( stmts ).toHaveLength( 1 );
		expect( stmts[ 0 ].values[ 2 ] ).toBe( 'solo' );
		expect( stmts[ 0 ].line ).toBe( 3 );
	} );

	it( 'resolves cd cwd: a bare verb inside a cd becomes command_node <path> <verb>', () => {
		const stmts = parseStatements(
			'cd worker/inner\nset_multi_writer true'
		);
		expect( stmts ).toHaveLength( 1 );
		expect( stmts[ 0 ].values ).toEqual( [
			'command_node',
			'worker/inner',
			'set_multi_writer',
			'true',
		] );
	} );

	it( 'prefixes a cmd path with the current cwd', () => {
		const stmts = parseStatements( 'cd base\ncmd leaf void_warranty' );
		expect( stmts[ 0 ].values ).toEqual( [
			'command_node',
			'base/leaf',
			'void_warranty',
		] );
	} );

	it( 'a bare make_node inside a cwd is a command to that node, like any verb', () => {
		const stmts = parseStatements( 'cd deep\nmake_node Topic leaf' );
		expect( stmts[ 0 ].values ).toEqual( [
			'command_node',
			'deep',
			'make_node',
			'Topic',
			'leaf',
		] );
	} );

	it( 'never routes the shell builtins var/include, even after a cd', () => {
		const stmts = parseStatements( 'cd deep\nvar x = 1\ninclude other' );
		expect( stmts[ 0 ].values ).toEqual( [ 'var', 'x', '=', '1' ] );
		expect( stmts[ 1 ].values ).toEqual( [ 'include', 'other' ] );
	} );

	it( 'preserves a single-quoted span byte-identical (deferred token)', () => {
		const stmts = parseStatements(
			"make_node Topic jobs <config:logs_dir>/jobs.p'<partition>'"
		);
		// values strips quotes; spans keeps them verbatim.
		expect( stmts[ 0 ].values[ 3 ] ).toBe(
			'<config:logs_dir>/jobs.p<partition>'
		);
		expect( stmts[ 0 ].spans[ 3 ] ).toBe(
			"<config:logs_dir>/jobs.p'<partition>'"
		);
	} );

	it( 'performs NO interpolation — <config:x> survives in values', () => {
		const stmts = parseStatements( 'cmd sink note <config:logs_dir>' );
		expect( stmts[ 0 ].values[ 3 ] ).toBe( '<config:logs_dir>' );
	} );

	it( 'reports the 1-based first physical line of each statement', () => {
		const stmts = parseStatements(
			'\n\nmake_node Topic first\nmake_node Topic second'
		);
		expect( stmts.map( ( s ) => s.line ) ).toEqual( [ 3, 4 ] );
	} );

	it( 'throws on an unterminated quote at end-of-input', () => {
		expect( () =>
			parseStatements( "cmd sink echo 'unterminated" )
		).toThrow( /got EOF while waiting for tokens/ );
	} );

	it( 'fails loud on a trailing continuation at EOF, like the runtime', () => {
		expect( () => parseStatements( 'make_node Tee dangling \\' ) ).toThrow(
			/EOF while waiting/
		);
	} );

	it( 'quote-strips var values like every other token (spans keep them)', () => {
		const [ statement ] = parseStatements(
			'var greeting = "hello and more"\n'
		);
		expect( statement.verb ).toBe( 'var' );
		expect( statement.values ).toEqual( [
			'var',
			'greeting',
			'=',
			'hello and more',
		] );
		expect( statement.spans[ 3 ] ).toBe( '"hello and more"' );
	} );
} );
