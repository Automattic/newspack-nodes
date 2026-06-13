// Jest config — standalone (no @wordpress/scripts dependency).
//
// Mirrors the build's @newspack-nodes/* aliases. This example lives INSIDE the
// substrate repo (examples/newspack-ai-newsletter), so the substrate JS source
// is two levels up at ../../src — not a sibling checkout.

const path = require( 'path' );

module.exports = {
	testEnvironment: 'jsdom',
	setupFilesAfterEnv: [ '<rootDir>/jest.setup.js' ],
	testMatch: [ '**/__tests__/**/*.test.[jt]s?(x)' ],
	moduleNameMapper: {
		'^@newspack-nodes/runtime$': path.resolve(
			__dirname,
			'../../src/runtime/index.js'
		),
		'^@newspack-nodes/debug-overlay$': path.resolve(
			__dirname,
			'../../src/debug-overlay/DebugOverlay.js'
		),
		// Subpath mapper to the canonical substrate src/shared. MUST precede the
		// style-mock below: first match wins, so an aliased style import
		// (@newspack-nodes/shared/styles/x.scss) resolving to the style-mock
		// instead of the real file would break (documented AGENTS trap).
		'^@newspack-nodes/shared/(.*)$': path.resolve(
			__dirname,
			'../../src/shared/$1'
		),
		// Pin ONE copy of React + @wordpress/element so a substrate hook called
		// from this example's render can't trip "Invalid hook call" (two
		// dispatchers from two node_modules trees).
		'^@wordpress/element$': path.resolve(
			__dirname,
			'node_modules/@wordpress/element'
		),
		'^react$': path.resolve( __dirname, 'node_modules/react' ),
		'^react-dom$': path.resolve( __dirname, 'node_modules/react-dom' ),
		'^react/jsx-runtime$': path.resolve(
			__dirname,
			'node_modules/react/jsx-runtime'
		),
		'\\.(css|scss)$': '<rootDir>/jest.style-mock.js',
	},
	transform: {
		'\\.[jt]sx?$': 'babel-jest',
	},
};
