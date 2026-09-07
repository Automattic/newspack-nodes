// Jest config, built from the substrate's shared build-kit factory. This
// example ships INSIDE the substrate repo at examples/example-ai-newsletter,
// so the canonical src is fixed at ../../src, the path this example's
// scripts/build.mjs anchors on too: the tests and the bundle see one
// substrate. The substrate installs React as well, so react, react-dom,
// react/jsx-runtime and @wordpress/element are pinned to THIS example's
// node_modules — a substrate hook called from an example render then meets
// one dispatcher rather than two, and cannot trip "Invalid hook call".

const path = require( 'node:path' );
const { createJestConfig } = require( '../../src/build-kit/jest.cjs' );

module.exports = createJestConfig( {
	aliasBase: path.resolve( __dirname, '../../src' ),
	pinReactFrom: path.resolve( __dirname, 'node_modules' ),
	// Both entries resolve to the substrate's node_modules: only the substrate
	// installs d3, and @wordpress/api-fetch sits in both trees, where two
	// copies would hand src/runtime/nodes-data.js and TopTable separate
	// `apiFetch.nonceMiddleware` singletons. The build externalizes that
	// import to window.wp.apiFetch, so only jest reads this entry.
	extraMappers: {
		'^@wordpress/api-fetch$': path.resolve(
			__dirname,
			'../../node_modules/@wordpress/api-fetch'
		),
		'^d3$': path.resolve( __dirname, '../../node_modules/d3' ),
	},
	// d3 and @noble/hashes ship ESM-only and arrive transitively: d3 through
	// TopicsChart, which the debug overlay's Overview tab draws with, and
	// @noble/hashes through @newspack-nodes/runtime's command signer. Both,
	// and their own ESM deps, opt OUT of the node_modules transform skip, or a
	// test importing either fails to parse.
	transformIgnorePatterns: [
		'node_modules/(?!(@noble/.*|d3|d3-.*|internmap|delaunator|robust-predicates)/)',
	],
} );
