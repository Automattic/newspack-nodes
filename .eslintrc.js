/**
 * Eslint config — extends wp-scripts defaults and tells eslint-plugin-import
 * to treat `@newspack-nodes/runtime` and `d3` as known modules so it doesn't
 * flag aliases as unresolvable. Resolution at runtime is handled by
 * webpack.config.js (build time) and jest.config.js (test time).
 *
 * `d3` is listed only as a dev dep on the sibling `newspack-event-logger-nodes`
 * package — substrate doesnt install it as a direct dependency, but the
 * `useTimeChart` shared hook (synced into both plugins) imports it. The
 * substrate-side bundle never imports `useTimeChart` (it's used by the
 * gyroscope dashboard, app-side), but linting walks the source tree, so
 * marking d3 as a core module keeps the lint pass clean here.
 */
module.exports = {
	extends: [ require.resolve( '@wordpress/scripts/config/.eslintrc.js' ) ],
	settings: {
		'import/core-modules': [ '@newspack-nodes/runtime', 'd3' ],
	},
};
