// Jest config — standalone (no @wordpress/scripts dependency), built from the
// shared build-kit factory. The substrate maps the `@newspack-nodes/*`
// consumption surface to its OWN canonical src (it is the canonical home, so it
// dogfoods the exact import paths consumers use), has a single React copy (no
// pins needed), and excludes examples/ (standalone consumer plugins with their
// own react + runner).

const path = require( 'node:path' );
const { createJestConfig } = require( './src/build-kit/jest.cjs' );

module.exports = createJestConfig( {
	aliasBase: path.resolve( __dirname, 'src' ),
	testPathIgnorePatterns: [ '/node_modules/', '/examples/' ],
} );
