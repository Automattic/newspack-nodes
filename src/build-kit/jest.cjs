/**
 * Shared jest config factory for dashboard consumers (the substrate, the
 * bundled example, and the sibling event-logger plugin). Each consumer's
 * jest.config.js calls `createJestConfig()` with its own resolved paths.
 *
 * CommonJS (.cjs) because jest.config.js is loaded by jest's CJS loader and
 * requires this directly via a real path — NOT the `@newspack-nodes/*` esbuild
 * alias (those are bundle aliases, not Node module resolution). It imports only
 * `node:path`, so a sibling-checkout consumer resolves it fine.
 */

const path = require( 'node:path' );
const { jestModuleNameMapper } = require( './alias-map.cjs' );

/**
 * @param {Object}   opts
 * @param {string}   opts.aliasBase                 Absolute path to the substrate `src` dir the `@newspack-nodes/*` surface maps to.
 * @param {string}   [opts.pinReactFrom]            Absolute `node_modules` dir to pin a single React + @wordpress/element copy from (omit for the substrate, which has one copy already).
 * @param {Object}   [opts.extraMappers]            Extra moduleNameMapper entries (merged BEFORE the css/scss mock), e.g. ELN's d3 pin.
 * @param {string[]} [opts.testPathIgnorePatterns]  Overrides the default; pass to exclude e.g. `/examples/`.
 * @param {string[]} [opts.transformIgnorePatterns] esbuild-style ESM allowlist, e.g. ELN's d3 packages.
 * @return {Object} A jest config object.
 */
function createJestConfig( {
	aliasBase,
	pinReactFrom = null,
	extraMappers = {},
	testPathIgnorePatterns = null,
	transformIgnorePatterns = null,
} ) {
	// Shared-subpath mapper MUST precede css/scss style-mock (AGENTS trap).
	const moduleNameMapper = jestModuleNameMapper( aliasBase );

	// Pin ONE React + @wordpress/element copy (avoids "Invalid hook call").
	if ( pinReactFrom ) {
		moduleNameMapper[ '^@wordpress/element$' ] = path.join(
			pinReactFrom,
			'@wordpress/element'
		);
		moduleNameMapper[ '^react$' ] = path.join( pinReactFrom, 'react' );
		moduleNameMapper[ '^react-dom$' ] = path.join(
			pinReactFrom,
			'react-dom'
		);
		moduleNameMapper[ '^react/jsx-runtime$' ] = path.join(
			pinReactFrom,
			'react/jsx-runtime'
		);
	}

	Object.assign( moduleNameMapper, extraMappers );
	moduleNameMapper[ '\\.(css|scss)$' ] = '<rootDir>/jest.style-mock.js';

	const config = {
		testEnvironment: 'jsdom',
		// Node-timer teardown first: it installs the accounting wrapper.
		setupFilesAfterEnv: [
			path.join( aliasBase, 'build-kit/jest-node-timers.js' ),
			'<rootDir>/jest.setup.js',
		],
		testMatch: [ '**/__tests__/**/*.test.[jt]s?(x)' ],
		moduleNameMapper,
		// babel-jest over .mjs so its node: imports resolve.
		transform: { '\\.m?[jt]sx?$': 'babel-jest' },
	};
	if ( testPathIgnorePatterns ) {
		config.testPathIgnorePatterns = testPathIgnorePatterns;
	}
	if ( transformIgnorePatterns ) {
		config.transformIgnorePatterns = transformIgnorePatterns;
	}
	return config;
}

module.exports = { createJestConfig };
