/**
 * ESLint config — standalone (no @wordpress/scripts dependency).
 *
 * Uses @wordpress/eslint-plugin's `recommended` config directly, plus the
 * `test-unit` override for unit tests. `parserOptions` references our own
 * babel.config.js so JSX/automatic-runtime is understood.
 *
 * `import/core-modules` tells eslint-plugin-import that aliased imports
 * resolve at runtime (build script handles `@newspack-nodes/runtime`; `d3`
 * is provided by the sibling event-logger plugin via shared hooks that are
 * synced here but unused on the substrate side).
 */
module.exports = {
	root: true,
	extends: [ 'plugin:@wordpress/eslint-plugin/recommended' ],
	overrides: [
		{
			files: [ '**/@(test|__tests__)/**/*.js', '**/?(*.)test.js' ],
			extends: [ 'plugin:@wordpress/eslint-plugin/test-unit' ],
		},
	],
	settings: {
		'import/core-modules': [ '@newspack-nodes/runtime', 'd3' ],
	},
};
