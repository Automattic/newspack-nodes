// Jest config — built from the substrate's shared build-kit factory. This
// example lives INSIDE the substrate repo (examples/newspack-ai-newsletter),
// so the canonical src is two levels up at ../../src, and React is pinned to
// THIS example's node_modules so a substrate hook called from its render can't
// trip "Invalid hook call" (two dispatchers from two node_modules trees).

const path = require( 'node:path' );
const { createJestConfig } = require( '../../src/build-kit/jest.cjs' );

module.exports = createJestConfig( {
	aliasBase: path.resolve( __dirname, '../../src' ),
	pinReactFrom: path.resolve( __dirname, 'node_modules' ),
} );
