/**
 * Jest config — extends the wp-scripts default and mirrors the webpack
 * alias so unit tests can `import { CommandClient } from '@newspack-nodes/runtime'`
 * the same way dashboard bundles do.
 */

const path = require( 'path' );
const wpJestConfig = require( '@wordpress/scripts/config/jest-unit.config' );

const SUBSTRATE_RUNTIME = path.resolve( __dirname, 'src/runtime' );

module.exports = {
	...wpJestConfig,
	moduleNameMapper: {
		...( wpJestConfig.moduleNameMapper || {} ),
		'^@newspack-nodes/runtime$': SUBSTRATE_RUNTIME,
	},
};
