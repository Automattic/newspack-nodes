// Prettier config — the canonical Newspack/WordPress preset.
//
// Loads `@wordpress/prettier-config` (tabs, single quotes, parenSpacing) so
// `prettier --write` produces exactly what `@wordpress/eslint-plugin`'s
// `prettier/prettier` rule and `@wordpress/stylelint-config` expect. Without
// this file, prettier falls back to its own defaults (2-space, double quotes)
// and fights eslint/stylelint on every run. Mirrors newspack-plugin/.prettierrc.js.
module.exports = require( '@wordpress/prettier-config' );
