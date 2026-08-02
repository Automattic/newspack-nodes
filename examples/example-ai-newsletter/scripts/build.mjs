#!/usr/bin/env node
/**
 * Dashboard build — a thin shell over the substrate's shared build-kit.
 * esbuild/sass/rtlcss come from THIS example's node_modules and are injected.
 *
 * This example lives INSIDE the substrate repo (examples/<name>), so the
 * canonical `@newspack-nodes/*` src is two levels up and bare imports from the
 * aliased shared sources resolve against the substrate's node_modules.
 */

import esbuild from 'esbuild';
import * as sass from 'sass';
import rtlcss from 'rtlcss';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const ROOT = path.resolve( __dirname, '..' );

// In-repo example: the substrate is always three levels up, so no env override.
const SUBSTRATE_SRC = path.resolve( ROOT, '../../src' );
const buildKit = path.join( SUBSTRATE_SRC, 'build-kit/index.mjs' );
if ( ! existsSync( buildKit ) ) {
	throw new Error( `build-kit not found at ${ buildKit }` );
}
const { buildDashboards } = await import( pathToFileURL( buildKit ).href );
const { esbuildAlias } = (
	await import(
		pathToFileURL( path.join( SUBSTRATE_SRC, 'build-kit/alias-map.cjs' ) )
			.href
	)
).default;

const alias = esbuildAlias( SUBSTRATE_SRC );

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
