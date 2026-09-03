/**
 * ESLint overrides for the bundled example plugin.
 *
 * The cascade walks up from each linted file to the substrate's
 * `newspack-nodes/.eslintrc.js`, which is `root: true`, so everything it
 * declares — the WordPress recommended set, `no-console`, the
 * `jsdoc/require-jsdoc` floor — governs this directory unchanged. Two things
 * differ.
 *
 * The example ships as its own plugin, so its strings carry the
 * `example-ai-newsletter` text domain while the inherited
 * `@wordpress/i18n-text-domain` allows `newspack-nodes` alone. Restating a
 * rule WITH options replaces the inherited options rather than adding to them,
 * which is what this wants: no file here may use the substrate's domain.
 *
 * `build/` holds the generated dashboard bundle. The substrate's
 * `npm run lint:js` globs `src/` and `scripts/` and never reaches this
 * directory, so the ignore is for the invocations that do — `eslint .` from
 * the repo root, or an editor linting the open file — where a compiled bundle
 * yields nothing anyone can act on.
 */
module.exports = {
	rules: {
		'@wordpress/i18n-text-domain': [
			'error',
			{ allowedTextDomain: [ 'example-ai-newsletter' ] },
		],
	},
	ignorePatterns: [ 'build/' ],
};
