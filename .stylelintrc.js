/**
 * Stylelint configuration for this plugin's SCSS.
 *
 * The canonical Newspack plugins reach this rule set through
 * `newspack-scripts/config/stylelint.config.js`; this file mirrors it rather
 * than take the dependency. No package carries an upstream change across, so
 * tuning a rule here alone diverges silently from the plugins it matches —
 * keep the `rules` block in step with that file.
 *
 * Two divergences are deliberate. `extends` names the SCSS variant rather
 * than the plain CSS root, because every stylesheet here is SCSS; and
 * `ignoreFiles` names this plugin's output directory, `build`, in place of
 * upstream's `dist`.
 *
 * That SCSS variant is the non-stylistic `@wordpress/stylelint-config/scss`,
 * never `/scss-stylistic`. The stylistic layer's `@stylistic/*` rules —
 * indentation, declaration-colon-space-after — fight prettier, which wraps
 * and indents first; those rules then flag the result, and `--fix` cannot
 * reconcile the two. Prettier owns all formatting; stylelint checks only
 * non-stylistic correctness.
 *
 * The two non-null entries are upstream's Sass allowances, which the
 * CSS-oriented checks reject: a function name containing `color`, and the
 * `!default` variable flag. `ignoreFiles` keeps compiled output and vendored
 * trees out of a whole-tree run, since `npm run lint:scss` already names
 * `src`. The SCSS parser is not set here — that script, `fix:scss` and the
 * `*.scss` lint-staged entry each pass `--customSyntax postcss-scss`.
 *
 * @type {import('stylelint').Config}
 */
module.exports = {
	extends: [ '@wordpress/stylelint-config/scss' ],
	ignoreFiles: [ 'build/**', 'node_modules/**', 'release/**', 'scripts/**' ],
	rules: {
		'rule-empty-line-before': null,
		'at-rule-empty-line-before': null,
		'comment-empty-line-before': null,
		'no-descending-specificity': null,
		'function-url-quotes': null,
		'font-weight-notation': null,
		'color-named': null,
		'selector-class-pattern': null,
		'custom-property-pattern': null,
		'at-rule-no-unknown': null,
		'alpha-value-notation': null,
		'color-function-notation': null,
		'selector-not-notation': null,
		'no-invalid-double-slash-comments': null,
		'function-no-unknown': [ true, { ignoreFunctions: [ '/color/' ] } ],
		'annotation-no-unknown': [ true, { ignoreAnnotations: [ '/default/' ] } ],
		'media-feature-range-notation': null,
	},
};
