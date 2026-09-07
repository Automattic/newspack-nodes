/**
 * ESLint overrides for the bundled example plugin.
 *
 * The cascade walks up from each linted file to the substrate's
 * `newspack-nodes/.eslintrc.js`, which is `root: true`, so everything it
 * declares at the top level governs this directory unchanged — the WordPress
 * recommended set, `no-console`, the `jsdoc/require-jsdoc` floor, and the
 * exemptions that carry this dashboard's `@newspack-nodes/*` imports past the
 * resolver. Its `scripts/**` override does not reach here: those globs anchor
 * to the substrate root, so this example's own `scripts/` keeps the base
 * `no-console` and `jsdoc/require-param`. This file changes two things.
 *
 * The example ships as its own plugin, so its strings carry the
 * `example-ai-newsletter` text domain while the inherited
 * `@wordpress/i18n-text-domain` allows `newspack-nodes` alone. Restating a
 * rule WITH options replaces the inherited options rather than adding to them,
 * which is what this wants: no file here may use the substrate's domain.
 *
 * `build/` holds the generated dashboard bundle, and the pattern resolves
 * against this file's directory. The substrate's `npm run lint:js` reaches
 * this directory through globs over each example's `src` and `scripts`,
 * neither of which covers the bundle, so the ignore is for the invocations
 * that do — `eslint .` from the plugin root, or an editor linting the open
 * file — where a compiled bundle yields nothing anyone can act on.
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
