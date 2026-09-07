#!/usr/bin/env node
/**
 * Dashboard build for the walkthrough example — a thin shell over the
 * substrate's shared build-kit, which owns the esbuild configuration, the
 * `@wordpress/*` externals, the SCSS compile and the `.asset.php` enqueue
 * manifests.
 *
 * esbuild, sass and rtlcss come from THIS example's node_modules and are
 * injected. The kit imports only node builtins, so one copy of it serves
 * consumers whose packages sit in a different tree.
 *
 * `nodePaths` names the substrate's node_modules, the directory esbuild
 * searches when the walk up from an importing file resolves nothing: the
 * aliased shared sources pull `d3` and `@noble/hashes` from that tree. All
 * five of the example's own dependencies sit in the kit's `WP_EXTERNALS`, so
 * the build rewrites each to a window global and bundles none of them.
 *
 * `npm run build` and `npm run watch` each empty `build/` first, so this
 * script only compiles; `--watch` keeps it compiling as sources change.
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
 * The substrate `src` directory, under the repo root two levels up.
 *
 * The example ships INSIDE the substrate repo (`examples/<name>`), so the path
 * is fixed and this script reads no `NEWSPACK_NODES_SRC` override. A sibling
 * plugin reads that variable because its substrate can sit anywhere, and its
 * release workflow checks one out to `.newspack-nodes`; here it would only be
 * a way to build against a different checkout by accident. `jest.config.js`
 * anchors on the same `../../src`, so the tests and the bundle see one
 * substrate.
 */
const SUBSTRATE_SRC = path.resolve( ROOT, '../../src' );

/**
 * The build kit's entry point, loaded through `import()` rather than a static
 * import. Static imports are hoisted, so the kit would resolve before the
 * check below runs and `ERR_MODULE_NOT_FOUND` would replace the error naming
 * the missing file.
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
 * The one dashboard bundle. `enqueue_react_page()` serves the admin screen from
 * this directory, into which the kit emits `index.js` and the
 * `index.asset.php` manifest WordPress reads dependencies and version from,
 * plus — because `PublisherInsightsPage` imports `styles/insights.scss` —
 * `index.css` and its `index-rtl.css` companion.
 *
 * The kit names every output after the entry file, and the registrar looks all
 * four up by the literal name `index`; renaming the entry therefore enqueues
 * nothing and leaves the admin page blank.
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
