// Jest config — standalone (no @wordpress/scripts dependency).
//
// Transforms JS/JSX via babel-jest (see babel.config.js), uses jsdom for
// tests that touch document/window/renderHook, and mirrors the build's
// `@newspack-nodes/*` aliases so imports resolve identically in tests and
// bundles. These three aliases ARE the public consumption surface: sibling
// plugins map them to this checkout's sources, and nodes maps them to its own
// (it is the canonical home), so nodes dogfoods the exact paths consumers use.

const path = require( 'path' );

module.exports = {
	testEnvironment: 'jsdom',
	setupFilesAfterEnv: [ '<rootDir>/jest.setup.js' ],
	testMatch: [ '**/__tests__/**/*.test.[jt]s?(x)' ],
	// `examples/` are standalone consumer plugins with their own react + runner; running them here picks the wrong React copy.
	testPathIgnorePatterns: [ '/node_modules/', '/examples/' ],
	moduleNameMapper: {
		'^@newspack-nodes/runtime$': path.resolve( __dirname, 'src/runtime' ),
		'^@newspack-nodes/debug-overlay$': path.resolve(
			__dirname,
			'src/debug-overlay/DebugOverlay.js'
		),
		'^@newspack-nodes/shared/(.*)$': path.resolve(
			__dirname,
			'src/shared/$1'
		),
		'^@newspack-nodes/shared$': path.resolve( __dirname, 'src/shared' ),
		'\\.(css|scss)$': '<rootDir>/jest.style-mock.js',
	},
	transform: {
		// `.mjs` covers the build-kit (src/build-kit/index.mjs is ESM build
		// tooling); jest runs babel-jest over it so its `node:` imports resolve.
		'\\.m?[jt]sx?$': 'babel-jest',
	},
};
