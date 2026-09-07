/**
 * The module every `.css` and `.scss` import resolves to under jest. Exporting
 * an empty object lets a component import its own stylesheet and still run in
 * the suite: unmapped, the import reaches the real stylesheet, no entry in the
 * config's `transform` matches a `.scss` extension, and jest parses SCSS as
 * CommonJS. `createJestConfig()` in ../../src/build-kit/jest.cjs appends the
 * `\.(css|scss)$` mapper that points here. It catches this example's own
 * import, in `src/dashboard/PublisherInsightsPage.js`, and the substrate
 * styles that page pulls in through the `DebugOverlay` it renders.
 *
 * Each consumer keeps its own copy: the mapper's target is
 * `<rootDir>/jest.style-mock.js`, and jest's rootDir is the directory holding
 * the config it loaded — this example's, not the substrate's.
 *
 * One shape of import escapes it. ../../src/build-kit/alias-map.cjs emits the
 * `^@newspack-nodes/shared/(.*)$` mapper ahead of the style mock, jest takes
 * the first match, and a stylesheet imported through that alias resolves to
 * the real SCSS. Nothing imports one that way: shared components reach their
 * styles by relative path.
 */
module.exports = {};
