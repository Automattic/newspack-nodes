/**
 * The jsdom test environment `createJestConfig` hands every consumer.
 *
 * `@wordpress/ui` attaches its stylesheets to the document head on import,
 * each opening on one of its `wp-ui-*` cascade layers and nesting rules
 * inside them. jsdom's CSS parser cannot read that nesting, so it reports
 * each sheet through `console.error`, usually on import, outside every test,
 * where the console gate cannot fail it. This environment drops that report:
 * a sheet whose text opens on a `@wordpress/ui` layer. Every other sheet
 * jsdom cannot parse still reaches `console.error`.
 *
 * It builds the `jest-environment-jsdom` under the consumer's root, as Jest's
 * own `jsdom` setting resolves it, so each plugin's suites run on the DOM its
 * own `node_modules` carries: two copies of `nwsapi` read `:scope` and
 * `:has()` apart. The environment keeps its own wiring; only the console it
 * reports through drops the one error.
 */

/** How every `@wordpress/ui` stylesheet opens: on one of its layers. */
const WP_UI_LAYER = '@layer wp-ui-';

/**
 * Whether jsdom's error is its failure to parse a `@wordpress/ui` sheet.
 *
 * @param {unknown} error The first thing logged.
 * @return {boolean} Whether to drop it.
 */
const isWpUiSheet = ( error ) =>
	error instanceof Error &&
	'css parsing' === error.type &&
	'string' === typeof error.detail &&
	error.detail.startsWith( WP_UI_LAYER );

/**
 * A console passing every call through but the `@wordpress/ui` sheet's
 * `error`.
 *
 * @param {Object} console The environment's console.
 * @return {Object} The console the environment reports through.
 */
const withoutWpUiSheets = ( console ) =>
	new Proxy( console, {
		get( target, property ) {
			if ( 'error' === property ) {
				return ( first, ...rest ) => {
					if ( ! isWpUiSheet( first ) ) {
						target.error( first, ...rest );
					}
				};
			}
			const value = Reflect.get( target, property, target );
			return 'function' === typeof value ? value.bind( target ) : value;
		},
	} );

/**
 * The consumer's jsdom environment, reporting through that console. Jest
 * calls it with `new`, and the object it returns is the environment.
 *
 * @param {Object} config  Jest's environment config.
 * @param {Object} context Jest's environment context.
 * @return {Object} The consumer's `TestEnvironment` instance.
 */
function newspackNodesEnvironment( config, context ) {
	const { TestEnvironment } = require(
		require.resolve( 'jest-environment-jsdom', {
			paths: [ config.projectConfig.rootDir ],
		} )
	);
	return new TestEnvironment( config, {
		...context,
		console: withoutWpUiSheets( context.console ),
	} );
}

module.exports = newspackNodesEnvironment;
