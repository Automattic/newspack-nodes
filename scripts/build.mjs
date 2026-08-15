#!/usr/bin/env node
/**
 * Dashboard build — a thin shell over the shared build-kit. esbuild/sass/rtlcss
 * are imported from THIS plugin's node_modules and injected (the kit takes no
 * bare dependency on them so it can be shared with sibling-checkout consumers).
 *
 * `npm run build` runs `npm run clean` (rm -rf build) first, so this just
 * compiles. The aliases map the `@newspack-nodes/*` consumption surface to this
 * plugin's own canonical src — nodes dogfoods the exact import paths consumers
 * use.
 */

import esbuild from 'esbuild';
import * as sass from 'sass';
import rtlcss from 'rtlcss';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboards } from '../src/build-kit/index.mjs';
import aliasMap from '../src/build-kit/alias-map.cjs';

const { esbuildAlias } = aliasMap;

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const ROOT = path.resolve( __dirname, '..' );

// Nodes dogfoods the surface: the alias base is its OWN canonical src.
const alias = esbuildAlias( path.resolve( ROOT, 'src' ) );

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
