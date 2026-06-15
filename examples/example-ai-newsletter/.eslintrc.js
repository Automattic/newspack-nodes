/**
 * ESLint overrides for the example plugin. Inherits the substrate's root config
 * (walks up to newspack-nodes/.eslintrc.js, which is `root: true`); only the
 * text domain differs — this is its own plugin — and the built bundle is ignored.
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
