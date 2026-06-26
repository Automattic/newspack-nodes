// Jest config — built from the substrate's shared build-kit factory. This
// example lives INSIDE the substrate repo (examples/example-ai-newsletter),
// so the canonical src is two levels up at ../../src, and React is pinned to
// THIS example's node_modules so a substrate hook called from its render can't
// trip "Invalid hook call" (two dispatchers from two node_modules trees).

const path = require( 'node:path' );
const { createJestConfig } = require( '../../src/build-kit/jest.cjs' );

module.exports = createJestConfig( {
	aliasBase: path.resolve( __dirname, '../../src' ),
	pinReactFrom: path.resolve( __dirname, 'node_modules' ),
	// @wordpress/api-fetch isn't a dependency of this example (the build externals
	// it to window.wp.apiFetch); jest still needs to resolve the module-level
	// import in the dashboard, so point it at the substrate's installed copy —
	// tests inject a fake createDraft, so the real apiFetch is never called.
	// d3 is pulled in transitively by the mounted DebugOverlay (OverviewTab ->
	// TopicsChart) and is installed only in the substrate's node_modules, so map
	// it there; it ships ESM-only, so its packages opt out of the transform skip.
	extraMappers: {
		'^@wordpress/api-fetch$': path.resolve(
			__dirname,
			'../../node_modules/@wordpress/api-fetch'
		),
		'^d3$': path.resolve( __dirname, '../../node_modules/d3' ),
	},
	transformIgnorePatterns: [
		'node_modules/(?!(d3|d3-.*|internmap|delaunator|robust-predicates)/)',
	],
} );
