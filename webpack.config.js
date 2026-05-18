/**
 * Webpack config — extends the wp-scripts default and adds a single resolve
 * alias so dashboard JS can import the substrate runtime by name:
 *
 *   import { CommandClient, useNodeState, SseConnector } from '@newspack-nodes/runtime';
 *
 * Sibling plugins (newspack-event-logger-nodes) install the same alias
 * pointing back at our `src/runtime/` so the dashboards sync-shared between
 * plugins stay buildable on both sides.
 */

const path = require( 'path' );
const defaultConfig = require( '@wordpress/scripts/config/webpack.config' );

const SUBSTRATE_RUNTIME = path.resolve( __dirname, 'src/runtime' );

module.exports = {
	...defaultConfig,
	resolve: {
		...( defaultConfig.resolve || {} ),
		alias: {
			...( ( defaultConfig.resolve && defaultConfig.resolve.alias ) ||
				{} ),
			'@newspack-nodes/runtime': SUBSTRATE_RUNTIME,
		},
	},
};
