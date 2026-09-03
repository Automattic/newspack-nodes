/**
 * ESLint rules for this plugin's JavaScript: the browser runtime, the
 * dashboards, the shared modules every sibling consumes, and the Node build
 * scripts.
 *
 * The ruleset is `@wordpress/eslint-plugin`'s `recommended` and `i18n` configs,
 * extended from a direct devDependency — no wp-scripts wrapper stands between
 * this file and the rules it turns on, so a relaxation lives here and nowhere
 * else. `root: true` stops eslint walking out of the plugin into the
 * surrounding checkout. `recommended` also selects `@babel/eslint-parser`,
 * which reads the repo's own `babel.config.js`; JSX and the automatic runtime
 * are configured there, which is why this file sets no parser options.
 *
 * Two settings carry the `@newspack-nodes/*` imports past the resolver, which
 * sees neither the esbuild alias nor jest's `moduleNameMapper`.
 * `import/core-modules` matches a whole specifier and never a prefix, so it
 * takes the bare `@newspack-nodes/runtime` and `@newspack-nodes/debug-overlay`;
 * the `@newspack-nodes/shared/*` subpath alias needs the `import/no-unresolved`
 * ignore pattern instead. Both resolve to this plugin's own `src` — it is the
 * canonical home, and importing through the alias dogfoods the specifiers
 * consumers write.
 */
module.exports = {
	root: true,
	extends: [
		'plugin:@wordpress/eslint-plugin/recommended',
		'plugin:@wordpress/eslint-plugin/i18n',
	],
	rules: {
		// knip reads `@testonly` as "this export exists for its unit test,
		// not for callers"; without the entry, jsdoc rejects the unknown tag.
		'jsdoc/check-tag-names': [ 'error', { definedTags: [ 'testonly' ] } ],
		'@wordpress/i18n-text-domain': [
			'error',
			{ allowedTextDomain: [ 'newspack-nodes' ] },
		],
		// A Message's TYPE field is a flag bitmask (TM_BYTESTREAM, TM_EOF, …),
		// so `&` and `|` on it are the contract rather than a smell.
		'no-bitwise': 'off',
		// The runtime's stderr sink is `console.warn`, so warn and error are
		// real logging; a stray console.log/debug/info still fails.
		'no-console': [ 'error', { allow: [ 'warn', 'error' ] } ],
		// A `_`-prefixed argument is deliberately unused: it holds a position
		// in a signature an override has to match.
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
		// Every exported function, method and class carries a docblock. The
		// rule also catches the orphaned docblock: inserting a member between
		// a docblock and its subject leaves the real function undocumented,
		// and no other gate sees it.
		'jsdoc/require-jsdoc': [
			'error',
			{
				publicOnly: true,
				require: {
					FunctionDeclaration: true,
					MethodDefinition: true,
					ClassDeclaration: true,
				},
			},
		],
		// A stale closure is a bug, not a style note: a component saving
		// against a captured baseline writes the wrong diff, and at warning
		// level that hides among the warnings. `additionalHooks` extends the
		// check to `useSelect` and `useSuspenseSelect`, whose second argument
		// is a dependency array the rule does not otherwise recognize.
		'react-hooks/exhaustive-deps': [
			'error',
			{ additionalHooks: '^(useSelect|useSuspenseSelect)$' },
		],
		// The runtime is the bottom layer: it may import itself and packages,
		// nothing else under src/. A dashboard importing the runtime is the
		// whole point; the runtime importing a dashboard is a layering break.
		'import/no-restricted-paths': [
			'error',
			{
				zones: [
					{
						target: './src/runtime',
						from: './src',
						except: [ './runtime' ],
						message:
							'The runtime is the bottom layer — it cannot import from an app or shared directory.',
					},
				],
			},
		],
		// `import/core-modules` matches whole specifiers only, so the
		// `@newspack-nodes/shared/*` subpath alias is exempted here instead.
		'import/no-unresolved': [
			'error',
			{ ignore: [ '^@newspack-nodes/shared/' ] },
		],
	},
	overrides: [
		{
			// Unit tests run under jest — its globals and its rule set.
			files: [ '**/@(test|__tests__)/**/*.js', '**/?(*.)test.js' ],
			extends: [ 'plugin:@wordpress/eslint-plugin/test-unit' ],
			// jest.setup.js defines this helper: a test declares the
			// console.warn it expects, and undeclared output fails the test.
			globals: { expectConsoleWarn: 'readonly' },
		},
		{
			// Build and CLI scripts run under Node and report through the
			// console. build-kit's `.mjs`/`.cjs` are that tooling; its `.js`
			// files load into the jsdom test runtime and stay browser-scoped.
			// `jsdoc/require-jsdoc` still applies, so every exported helper
			// keeps its docblock; only the per-argument `@param` is lifted.
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
			// `d3` is a direct dependency and resolves from node_modules on
			// its own, so this entry is redundant.
			'd3',
		],
	},
};
