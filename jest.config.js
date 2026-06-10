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
	testMatch: [ '**/__tests__/**/*.test.[jt]s?(x)' ],
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
		'\\.[jt]sx?$': 'babel-jest',
	},
};
