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
	extends: [
		'plugin:@wordpress/eslint-plugin/recommended',
		'plugin:@wordpress/eslint-plugin/i18n',
	],
	rules: {
		'@wordpress/i18n-text-domain': [
			'error',
			{ allowedTextDomain: [ 'newspack-nodes' ] },
		],
		// The 7-field Message TYPE is a bitmask (Tachikoma convention:
		// TM_BYTESTREAM, TM_EOF, …); `&`/`|` on it are idiomatic, not a smell.
		'no-bitwise': 'off',
		// warn/error are legitimate logging (the runtime's stderr sink is the
		// browser console); still flag stray console.log/debug/info.
		'no-console': [ 'error', { allow: [ 'warn', 'error' ] } ],
		// `_`-prefixed args are intentionally unused (signature/override parity).
		'no-unused-vars': [
			'error',
			{ ignoreRestSiblings: true, argsIgnorePattern: '^_' },
		],
	},
	overrides: [
		{
			files: [ '**/@(test|__tests__)/**/*.js', '**/?(*.)test.js' ],
			extends: [ 'plugin:@wordpress/eslint-plugin/test-unit' ],
		},
		{
			// Build/CLI scripts run under Node and legitimately log to the console.
			files: [ 'scripts/**/*.mjs' ],
			env: { node: true },
			rules: {
				'no-console': 'off',
				'jsdoc/require-param': 'off',
			},
		},
	],
	settings: {
		'import/core-modules': [ '@newspack-nodes/runtime', 'd3' ],
	},
};
