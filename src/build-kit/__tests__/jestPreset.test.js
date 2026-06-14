// Tests createJestConfig — the shared jest config factory every dashboard
// consumer's jest.config.js calls. The load-bearing invariant is mapper
// ORDER: the @newspack-nodes/shared subpath mapper MUST precede the css/scss
// style-mock (first-match wins, so an aliased style import has to resolve to
// the real file, not the mock — the documented AGENTS trap).

const path = require( 'node:path' );
const { createJestConfig } = require( '../jest.cjs' );

describe( 'createJestConfig', () => {
	const aliasBase = '/plugin/../../src';

	test( 'sets the standalone jsdom defaults', () => {
		const cfg = createJestConfig( { aliasBase } );
		expect( cfg.testEnvironment ).toBe( 'jsdom' );
		expect( cfg.setupFilesAfterEnv ).toEqual( [
			'<rootDir>/jest.setup.js',
		] );
		expect( cfg.testMatch ).toEqual( [
			'**/__tests__/**/*.test.[jt]s?(x)',
		] );
		expect( cfg.transform ).toEqual( { '\\.m?[jt]sx?$': 'babel-jest' } );
	} );

	test( 'maps the @newspack-nodes/* surface against aliasBase', () => {
		const m = createJestConfig( { aliasBase } ).moduleNameMapper;
		expect( m[ '^@newspack-nodes/runtime$' ] ).toBe(
			path.join( aliasBase, 'runtime/index.js' )
		);
		expect( m[ '^@newspack-nodes/debug-overlay$' ] ).toBe(
			path.join( aliasBase, 'debug-overlay/DebugOverlay.js' )
		);
		expect( m[ '^@newspack-nodes/shared/(.*)$' ] ).toBe(
			path.join( aliasBase, 'shared/$1' )
		);
		expect( m[ '^@newspack-nodes/shared$' ] ).toBe(
			path.join( aliasBase, 'shared' )
		);
		expect( m[ '\\.(css|scss)$' ] ).toBe( '<rootDir>/jest.style-mock.js' );
	} );

	test( 'orders the shared subpath mapper BEFORE the css/scss mock (first-match trap)', () => {
		const keys = Object.keys(
			createJestConfig( { aliasBase } ).moduleNameMapper
		);
		expect( keys.indexOf( '^@newspack-nodes/shared/(.*)$' ) ).toBeLessThan(
			keys.indexOf( '\\.(css|scss)$' )
		);
	} );

	test( 'omits React single-copy pins when pinReactFrom is not given', () => {
		const m = createJestConfig( { aliasBase } ).moduleNameMapper;
		expect( m[ '^react$' ] ).toBeUndefined();
		expect( m[ '^@wordpress/element$' ] ).toBeUndefined();
	} );

	test( 'adds React + @wordpress/element single-copy pins from pinReactFrom', () => {
		const m = createJestConfig( {
			aliasBase,
			pinReactFrom: '/plugin/node_modules',
		} ).moduleNameMapper;
		expect( m[ '^react$' ] ).toBe( '/plugin/node_modules/react' );
		expect( m[ '^react-dom$' ] ).toBe( '/plugin/node_modules/react-dom' );
		expect( m[ '^react/jsx-runtime$' ] ).toBe(
			'/plugin/node_modules/react/jsx-runtime'
		);
		expect( m[ '^@wordpress/element$' ] ).toBe(
			'/plugin/node_modules/@wordpress/element'
		);
		// React pins still precede the css mock.
		const keys = Object.keys( m );
		expect( keys.indexOf( '^react$' ) ).toBeLessThan(
			keys.indexOf( '\\.(css|scss)$' )
		);
	} );

	test( 'merges extraMappers (e.g. d3) before the css mock and passes transformIgnorePatterns through', () => {
		const cfg = createJestConfig( {
			aliasBase,
			extraMappers: { '^d3$': '/plugin/node_modules/d3' },
			transformIgnorePatterns: [ 'node_modules/(?!(d3|d3-.*)/)' ],
		} );
		const keys = Object.keys( cfg.moduleNameMapper );
		expect( cfg.moduleNameMapper[ '^d3$' ] ).toBe(
			'/plugin/node_modules/d3'
		);
		expect( keys.indexOf( '^d3$' ) ).toBeLessThan(
			keys.indexOf( '\\.(css|scss)$' )
		);
		expect( cfg.transformIgnorePatterns ).toEqual( [
			'node_modules/(?!(d3|d3-.*)/)',
		] );
	} );

	test( 'passes testPathIgnorePatterns through (substrate excludes examples/)', () => {
		const cfg = createJestConfig( {
			aliasBase,
			testPathIgnorePatterns: [ '/node_modules/', '/examples/' ],
		} );
		expect( cfg.testPathIgnorePatterns ).toEqual( [
			'/node_modules/',
			'/examples/',
		] );
	} );

	test( 'omits testPathIgnorePatterns + transformIgnorePatterns keys when not given', () => {
		const cfg = createJestConfig( { aliasBase } );
		expect( cfg ).not.toHaveProperty( 'testPathIgnorePatterns' );
		expect( cfg ).not.toHaveProperty( 'transformIgnorePatterns' );
	} );
} );
