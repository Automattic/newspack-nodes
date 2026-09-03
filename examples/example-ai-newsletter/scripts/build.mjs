#!/usr/bin/env node
/**
 * Dashboard build for the walkthrough example — a thin shell over the
 * substrate's shared build-kit, which owns the esbuild configuration, the
 * `@wordpress/*` externals and the `.asset.php` enqueue manifests.
 *
 * esbuild, sass and rtlcss come from THIS example's node_modules and are
 * injected. The kit imports only node builtins, so one copy of it serves
 * consumers whose packages sit in a different tree.
 *
 * Bare imports resolve against the SUBSTRATE's node_modules rather than this
 * example's: the aliased shared sources pull `d3` and `@noble/hashes`, which
 * are the substrate's dependencies. The example declares only what its own
 * dashboard imports, and the build rewrites every one of those to a window
 * global.
 *
 * `npm run build` empties `build/` before this runs, so the script only
 * compiles; `--watch` keeps it compiling as sources change.
 */

import esbuild from 'esbuild';
import * as sass from 'sass';
import rtlcss from 'rtlcss';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This file's directory; ESM defines no `__dirname`. */
const __dirname = path.dirname( fileURLToPath( import.meta.url ) );

/** The example plugin root, which every path in this file resolves from. */
const ROOT = path.resolve( __dirname, '..' );

/**
 * The substrate `src` directory, two levels above this example.
 *
 * The example ships INSIDE the substrate repo (`examples/<name>`), so the path
 * is fixed and no `NEWSPACK_NODES_SRC` override reads it. A sibling plugin
 * checked out beside the substrate needs that variable; here it would only be
 * a way to build against a different checkout by accident. `jest.config.js`
 * anchors on the same `../../src`, so the tests and the bundle see one
 * substrate.
 */
const SUBSTRATE_SRC = path.resolve( ROOT, '../../src' );

/**
 * The build kit's entry point, loaded through `import()` rather than a static
 * import: a static specifier cannot be a path computed at run time, and static
 * imports are hoisted, so the kit would resolve before the check below and
 * `ERR_MODULE_NOT_FOUND` would replace the error naming the missing file.
 */
const buildKit = path.join( SUBSTRATE_SRC, 'build-kit/index.mjs' );
if ( ! existsSync( buildKit ) ) {
	throw new Error( `build-kit not found at ${ buildKit }` );
}
const { buildDashboards } = await import( pathToFileURL( buildKit ).href );

/**
 * The alias map's esbuild projection, reached through `.default` because
 * `alias-map.cjs` is CommonJS — `jest.cjs` requires it synchronously, so it
 * cannot be an ES module.
 */
const { esbuildAlias } = (
	await import(
		pathToFileURL( path.join( SUBSTRATE_SRC, 'build-kit/alias-map.cjs' ) )
			.href
	)
).default;

/**
 * The `@newspack-nodes/{runtime,debug-overlay,shared}` map, projected from the
 * substrate `src` by the same `alias-map.cjs` that builds the jest mapper.
 */
const alias = esbuildAlias( SUBSTRATE_SRC );

/**
 * The one dashboard bundle. `enqueue_react_page()` mounts the admin screen by
 * this directory, into which the kit emits `index.js`, the `index.asset.php`
 * manifest WordPress reads dependencies and version from, and `index.css` with
 * its RTL companion.
 */
const ENTRIES = [
	{
		entry: 'src/dashboard/index.js',
		outDir: path.resolve( ROOT, 'build/dashboard' ),
	},
];

buildDashboards( {
	esbuild,
	sass,
	rtlcss,
	root: ROOT,
	entries: ENTRIES,
	alias,
	nodePaths: [ path.resolve( ROOT, '../../node_modules' ) ],
	watch: process.argv.includes( '--watch' ),
} ).catch( ( err ) => {
	console.error( err );
	process.exit( 1 );
} );
