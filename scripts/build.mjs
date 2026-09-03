#!/usr/bin/env node
/**
 * Dashboard build for the substrate itself. This file declares WHAT to bundle
 * and injects the tools; the shared build-kit owns the esbuild configuration,
 * the `@wordpress/*` externals, the SCSS compile and the `.asset.php` enqueue
 * manifests.
 *
 * esbuild, sass and rtlcss are injected rather than imported by the kit,
 * because a consumer builds against a newspack-nodes checkout that has no
 * node_modules of its own; the kit imports node builtins only.
 *
 * A standalone consumer's copy of this file carries two things absent here,
 * because the substrate IS the checkout both of them point at. It reads a
 * `NEWSPACK_NODES_SRC` override and therefore reaches the kit and the alias
 * map through `import()`, since a static specifier cannot be a path computed
 * at run time; both sit at a fixed relative path here, so a static import
 * resolves them. It also passes `nodePaths` to pin a bare import like `d3` to
 * its own copy; here one tree holds the shared sources and the dependencies
 * they import, so a second copy cannot reach the bundle. Those differences are
 * why `sync-shared-scripts.sh` vendors the rest of `scripts/` to the siblings
 * and leaves this file alone.
 *
 * `npm run build` empties `build/` before this runs, so the script only
 * compiles; `--watch` keeps it compiling as sources change.
 */

import esbuild from 'esbuild';
import * as sass from 'sass';
import rtlcss from 'rtlcss';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboards } from '../src/build-kit/index.mjs';
import aliasMap from '../src/build-kit/alias-map.cjs';

/**
 * The alias map's esbuild projection, reached through the default import
 * because `alias-map.cjs` is CommonJS — `jest.cjs` requires it synchronously,
 * so it cannot be an ES module.
 */
const { esbuildAlias } = aliasMap;

/** This file's directory; ESM defines no `__dirname`. */
const __dirname = path.dirname( fileURLToPath( import.meta.url ) );

/** The plugin root, which every path in this file resolves from. */
const ROOT = path.resolve( __dirname, '..' );

/**
 * The `@newspack-nodes/{runtime,debug-overlay,shared}` map, projected from
 * this plugin's own `src` by the same `alias-map.cjs` that builds the jest
 * mapper, so the bundle and the tests cannot disagree about where an alias
 * points.
 *
 * The substrate is the canonical home of those modules and still consumes them
 * through the alias rather than by relative path, which is what keeps the
 * import paths its consumers write under test here.
 */
const alias = esbuildAlias( path.resolve( ROOT, 'src' ) );

/**
 * One bundle per `build/<name>/` directory, the name PHP passes when it
 * enqueues. Into each the kit emits `index.js` and the `index.asset.php`
 * manifest WordPress reads dependencies and version from, plus `index.css` and
 * its RTL companion whenever the entry imports styles.
 *
 * `theme`, `ui` and `graph` import nothing but SCSS: they exist to emit the
 * three stylesheets `Admin::register_built_style()` registers, and their JS
 * bundle is empty. `event-dashboards` and `devtools-hub` load with the Nodes
 * hub page; `topology-console`, `vault`, `sessions` and `event-aggregator` are
 * DevTools tabs the hub shell fetches on first activation; `admin-field-reset`
 * is the settings-page module `Field_Reset_Assets` enqueues.
 */
const ENTRIES = [
	{
		entry: 'src/theme/index.js',
		outDir: path.resolve( ROOT, 'build/theme' ),
	},
	{
		entry: 'src/ui/index.js',
		outDir: path.resolve( ROOT, 'build/ui' ),
	},
	{
		entry: 'src/graph/index.js',
		outDir: path.resolve( ROOT, 'build/graph' ),
	},
	{
		entry: 'src/event-dashboards/index.js',
		outDir: path.resolve( ROOT, 'build/event-dashboards' ),
	},
	{
		entry: 'src/topology-console/index.js',
		outDir: path.resolve( ROOT, 'build/topology-console' ),
	},
	{
		entry: 'src/admin-field-reset/index.js',
		outDir: path.resolve( ROOT, 'build/admin-field-reset' ),
	},
	{
		entry: 'src/devtools-hub/index.js',
		outDir: path.resolve( ROOT, 'build/devtools-hub' ),
	},
	{
		entry: 'src/vault/index.js',
		outDir: path.resolve( ROOT, 'build/vault' ),
	},
	{
		entry: 'src/sessions/index.js',
		outDir: path.resolve( ROOT, 'build/sessions' ),
	},
	{
		entry: 'src/event-aggregator/index.js',
		outDir: path.resolve( ROOT, 'build/event-aggregator' ),
	},
];

buildDashboards( {
	esbuild,
	sass,
	rtlcss,
	root: ROOT,
	entries: ENTRIES,
	alias,
	watch: process.argv.includes( '--watch' ),
} ).catch( ( err ) => {
	console.error( err );
	process.exit( 1 );
} );
