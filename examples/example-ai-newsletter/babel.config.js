/**
 * Babel config for jest alone. `jest.config.js` builds its config from the
 * substrate's shared build-kit factory, which sets `babel-jest` as the
 * transform; `scripts/build.mjs` compiles the shipped dashboard bundle with
 * esbuild, which reads none of this.
 *
 * `targets: { node: 'current' }` compiles for the Node running the suite. This
 * package declares no `browserslist` key, so without the explicit target
 * preset-env walks two levels up to the substrate's browserslist entry and
 * down-compiles the tests to the WordPress browser matrix for nothing.
 *
 * `runtime: 'automatic'` matches the build-kit's esbuild `jsx: 'automatic'`, so
 * JSX resolves through `react/jsx-runtime`, the copy `jest.config.js` pins to
 * this example's node_modules. No file under `src/` binds `React` — the
 * dashboard takes its element factory from `@wordpress/element`, and the tests
 * import `act` from `react` by name — so the classic runtime would fail every
 * JSX file on an undefined `React`.
 */

module.exports = {
	presets: [
		[ '@babel/preset-env', { targets: { node: 'current' } } ],
		[ '@babel/preset-react', { runtime: 'automatic' } ],
	],
};
