/**
 * ESLint config — standalone (no @wordpress/scripts dependency).
 *
 * Uses @wordpress/eslint-plugin's `recommended` config directly, plus the
 * `test-unit` override for unit tests. `parserOptions` references our own
 * babel.config.js so JSX/automatic-runtime is understood.
 *
 * `import/core-modules` tells eslint-plugin-import that the bare `@newspack-nodes/*`
 * aliases resolve at runtime (build.mjs alias + jest moduleNameMapper); `d3` is
 * a peer the dashboards pull from the WP global. The `@newspack-nodes/shared/*`
 * subpath alias (canonical shared hooks/utils/components — this plugin IS the
 * home) is whitelisted via the no-unresolved `ignore` pattern below.
 */
module.exports = {
	root: true,
	extends: [
		'plugin:@wordpress/eslint-plugin/recommended',
		'plugin:@wordpress/eslint-plugin/i18n',
	],
	rules: {
		// knip suppression tag: an export that exists for its unit test, not
		// for callers. jsdoc/check-tag-names rejects unknown tags otherwise.
		'jsdoc/check-tag-names': [ 'error', { definedTags: [ 'testonly' ] } ],
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
		'react/forbid-component-props': [
			'error',
			{
				forbid: [
					{
						propName: 'isSmall',
						message: 'Deprecated in WP 6.2 — use size="small".',
					},
				],
			},
		],
		// The `@newspack-nodes/shared/*` subpath alias resolves at runtime
		// (build.mjs alias + jest moduleNameMapper) to this plugin's own
		// src/shared; the static resolver can't see the alias.
		'import/no-unresolved': [
			'error',
			{ ignore: [ '^@newspack-nodes/shared/' ] },
		],
	},
	overrides: [
		{
			files: [ '**/@(test|__tests__)/**/*.js', '**/?(*.)test.js' ],
			extends: [ 'plugin:@wordpress/eslint-plugin/test-unit' ],
			// jest.setup.js defines this console-assertion helper globally.
			globals: { expectConsoleWarn: 'readonly' },
		},
		{
			// Build/CLI scripts run under Node and legitimately log to the console.
			files: [
				'scripts/**/*.@(js|mjs)',
				'src/build-kit/**/*.@(mjs|cjs)',
			],
			env: { node: true },
			rules: {
				'no-console': 'off',
				'jsdoc/require-param': 'off',
			},
		},
	],
	settings: {
		'import/core-modules': [
			'@newspack-nodes/runtime',
			'@newspack-nodes/debug-overlay',
			'd3',
		],
	},
};
