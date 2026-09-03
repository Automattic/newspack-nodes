/**
 * Babel config for jest alone. The shared build-kit factory sets `babel-jest`
 * as `jest.config.js`'s transform; `scripts/build.mjs` compiles the shipped
 * dashboard bundles with esbuild, which reads none of this.
 *
 * `targets: { node: 'current' }` compiles for the Node running the suite, and
 * the explicit target overrides `package.json`'s `browserslist` key, which
 * preset-env would otherwise read — down-compiling the tests to the WordPress
 * browser matrix for nothing.
 *
 * `runtime: 'automatic'` matches the esbuild `jsx: 'automatic'` in
 * `src/build-kit/index.mjs`, so JSX resolves through `react/jsx-runtime`.
 * Nothing under `src/` imports `React`; every component takes its element
 * factory from `@wordpress/element`, so the classic runtime would fail each
 * JSX file on an undefined `React`.
 */

module.exports = {
	presets: [
		[ '@babel/preset-env', { targets: { node: 'current' } } ],
		[ '@babel/preset-react', { runtime: 'automatic' } ],
	],
};
