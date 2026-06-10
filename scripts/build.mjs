#!/usr/bin/env node
/**
 * Build script — replaces `wp-scripts build` with a direct esbuild invocation.
 *
 * For each entry, emits to <outDir>:
 *   - index.js         minified bundle
 *   - index.css        extracted CSS (if any styles imported)
 *   - index.asset.php  WordPress enqueue manifest: { dependencies, version }
 *
 * Imports of `@wordpress/*` packages and JSX runtime are rewritten to read
 * from the corresponding window global (the way WordPress's enqueue system
 * exposes them) and recorded in `index.asset.php` so wp_enqueue_script picks
 * up the right handles.
 */

import esbuild from 'esbuild';
import * as sass from 'sass';
import rtlcss from 'rtlcss';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const ROOT = path.resolve( __dirname, '..' );

// Map import path → { global, handle }.
//   global: runtime JS expression (read from `window`)
//   handle: WordPress enqueue handle for *.asset.php
const WP_EXTERNALS = {
	'@wordpress/element': {
		global: 'window.wp.element',
		handle: 'wp-element',
	},
	'@wordpress/api-fetch': {
		global: 'window.wp.apiFetch',
		handle: 'wp-api-fetch',
	},
	'@wordpress/components': {
		global: 'window.wp.components',
		handle: 'wp-components',
	},
	'@wordpress/i18n': {
		global: 'window.wp.i18n',
		handle: 'wp-i18n',
	},
	'@wordpress/icons': {
		global: 'window.wp.icons',
		handle: 'wp-icons',
	},
	'@wordpress/data': {
		global: 'window.wp.data',
		handle: 'wp-data',
	},
	react: {
		global: 'window.React',
		handle: 'react',
	},
	'react-dom': {
		global: 'window.ReactDOM',
		handle: 'react-dom',
	},
	'react/jsx-runtime': {
		global: 'window.ReactJSXRuntime',
		handle: 'react-jsx-runtime',
	},
};

/**
 * esbuild plugin: rewrites WP/React imports to read from window globals
 * and records which handles were actually used (for *.asset.php).
 *
 * @param {Set<string>} usedHandles Records the WordPress enqueue handles each entry actually imports, so the emitted *.asset.php dependency list is minimal.
 * @return {Object} An esbuild plugin object.
 */
function wpExternalsPlugin( usedHandles ) {
	return {
		name: 'wp-externals',
		setup( build ) {
			const filter = new RegExp(
				'^(' +
					Object.keys( WP_EXTERNALS )
						.map( ( k ) =>
							k.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' )
						)
						.join( '|' ) +
					')$'
			);
			build.onResolve( { filter }, ( args ) => ( {
				path: args.path,
				namespace: 'wp-external',
			} ) );
			build.onLoad(
				{ filter: /.*/, namespace: 'wp-external' },
				( args ) => {
					const info = WP_EXTERNALS[ args.path ];
					usedHandles.add( info.handle );
					return {
						contents: `module.exports = ${ info.global };`,
						loader: 'js',
					};
				}
			);
		},
	};
}

/**
 * esbuild plugin: compile .scss via the Sass package, hand the CSS to esbuild.
 */
function scssPlugin() {
	return {
		name: 'scss',
		setup( build ) {
			build.onLoad( { filter: /\.scss$/ }, async ( args ) => {
				const result = await sass.compileAsync( args.path, {
					loadPaths: [ path.dirname( args.path ) ],
				} );
				return {
					contents: result.css,
					loader: 'css',
				};
			} );
		},
	};
}

function emitAssetPhp( handles, version ) {
	const deps = [ ...handles ]
		.sort()
		.map( ( h ) => `'${ h }'` )
		.join( ', ' );
	return `<?php return array('dependencies' => array(${ deps }), 'version' => '${ version }');\n`;
}

async function buildEntry( entry, outDir ) {
	const usedHandles = new Set();
	await esbuild.build( {
		entryPoints: [ path.resolve( ROOT, entry ) ],
		bundle: true,
		minify: true,
		// dump_metadata reads node.constructor.name to label the class on the
		// canvas — minification mangles it to two-letter ids (Heartbeat→PT,
		// Metadata→OT, …). keepNames preserves the original identifiers in
		// the minified output without disabling minification.
		keepNames: true,
		format: 'iife',
		target: [ 'es2020' ],
		jsx: 'automatic',
		outfile: path.join( outDir, 'index.js' ),
		loader: {
			'.js': 'jsx',
			'.svg': 'dataurl',
			'.png': 'dataurl',
		},
		// The public consumption surface. Sibling plugins map these to this
		// checkout's sources (sibling-checkout layout, with NEWSPACK_NODES_*
		// env overrides in CI); nodes maps them to its own canonical src so its
		// bundles dogfood the exact import paths consumers use, instead of
		// reaching into shared/ via relative paths. esbuild prefix-matches the
		// bare `shared` alias, so `@newspack-nodes/shared/hooks/x` resolves to
		// `src/shared/hooks/x`.
		alias: {
			'@newspack-nodes/runtime': path.resolve(
				ROOT,
				'src/runtime/index.js'
			),
			'@newspack-nodes/debug-overlay': path.resolve(
				ROOT,
				'src/debug-overlay/DebugOverlay.js'
			),
			'@newspack-nodes/shared': path.resolve( ROOT, 'src/shared' ),
		},
		plugins: [ wpExternalsPlugin( usedHandles ), scssPlugin() ],
		logLevel: 'info',
	} );

	// Hash the JS bundle for the asset.php version (wp-scripts uses a similar
	// content-derived version so cache busts on real changes).
	const jsBytes = await readFile( path.join( outDir, 'index.js' ) );
	const version = createHash( 'sha256' )
		.update( jsBytes )
		.digest( 'hex' )
		.slice( 0, 20 );

	await writeFile(
		path.join( outDir, 'index.asset.php' ),
		emitAssetPhp( usedHandles, version )
	);

	// Generate the RTL companion stylesheet (WP convention: index-rtl.css
	// alongside index.css; loaded by wp_enqueue_style when is_rtl()).
	const cssPath = path.join( outDir, 'index.css' );
	try {
		await access( cssPath );
		const css = await readFile( cssPath, 'utf8' );
		const rtl = rtlcss.process( css );
		await writeFile( path.join( outDir, 'index-rtl.css' ), rtl );
	} catch ( err ) {
		if ( err.code !== 'ENOENT' ) {
			throw err;
		}
		// No CSS for this entry — skip RTL.
	}

	return { entry, outDir, version, handles: [ ...usedHandles ] };
}

const ENTRIES = [
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
];

async function main() {
	await rm( path.resolve( ROOT, 'build' ), { recursive: true, force: true } );
	for ( const e of ENTRIES ) {
		await mkdir( e.outDir, { recursive: true } );
	}
	const results = await Promise.all(
		ENTRIES.map( ( e ) => buildEntry( e.entry, e.outDir ) )
	);
	for ( const r of results ) {
		console.log(
			`✓ ${ r.entry } → ${ path.relative( ROOT, r.outDir ) } [deps: ${
				r.handles.join( ', ' ) || '(none)'
			}] [v${ r.version }]`
		);
	}
}

main().catch( ( err ) => {
	console.error( err );
	process.exit( 1 );
} );
