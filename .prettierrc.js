/**
 * Prettier configuration — the WordPress preset, re-exported unmodified.
 *
 * `@wordpress/prettier-config` sets tabs at width 4, an 80-column wrap, single
 * quotes, es5 trailing commas, and the spaces inside parens that the pinned
 * `wp-prettier` alias adds. Its `*.{css,sass,scss}` override turns the last
 * two off, so the SCSS `npm run format` rewrites stays double-quoted.
 *
 * One file serves both consumers, so they cannot disagree: the prettier CLI
 * reads it directly, and `@wordpress/eslint-plugin`'s recommended config finds
 * it through cosmiconfig and merges it over the same preset to seed the
 * `prettier/prettier` rule. Without the file prettier falls back to 2-space,
 * double-quoted defaults while eslint still demands the preset, so
 * `npm run format` leaves every file it touched erroring.
 */
module.exports = require( '@wordpress/prettier-config' );
