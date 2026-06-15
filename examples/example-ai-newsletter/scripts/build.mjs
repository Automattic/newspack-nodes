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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboards } from '../../../src/build-kit/index.mjs';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const ROOT = path.resolve( __dirname, '..' );

const alias = {
	'@newspack-nodes/runtime':
		process.env.NEWSPACK_NODES_RUNTIME ||
		path.resolve( ROOT, '../../src/runtime/index.js' ),
	'@newspack-nodes/debug-overlay':
		process.env.NEWSPACK_NODES_DEBUG_OVERLAY ||
		path.resolve( ROOT, '../../src/debug-overlay/DebugOverlay.js' ),
	'@newspack-nodes/shared':
		process.env.NEWSPACK_NODES_SHARED ||
		path.resolve( ROOT, '../../src/shared' ),
};

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
