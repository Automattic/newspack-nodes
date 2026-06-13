#!/usr/bin/env node
/**
 * Build script — replaces `wp-scripts build` with a direct esbuild invocation.
 *
 * For each entry, emits to <outDir>:
 *   - index.js         minified bundle
 *   - index.css        extracted CSS (if any styles imported)
 *   - index.asset.php  WordPress enqueue manifest: { dependencies, version }
 *
 * Imports of `@wordpress/*` packages and the JSX runtime are rewritten to read
 * from the corresponding window global and recorded in `index.asset.php` so
 * wp_enqueue_script picks up the right handles. This example lives INSIDE the
 * substrate repo, so `@newspack-nodes/*` resolves to ../../src.
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

/**
 * esbuild plugin: after each run, emit index.asset.php (deps + content-hash
 * version) and the index-rtl.css companion. Runs on every rebuild in watch mode.
 */
function postBuildPlugin( entry, outDir, usedHandles ) {
	return {
		name: 'post-build',
		setup( build ) {
			build.onEnd( async ( result ) => {
				if ( result.errors.length ) {
					return;
				}
				const jsBytes = await readFile(
					path.join( outDir, 'index.js' )
				);
				const version = createHash( 'sha256' )
					.update( jsBytes )
					.digest( 'hex' )
					.slice( 0, 20 );
				await writeFile(
					path.join( outDir, 'index.asset.php' ),
					emitAssetPhp( usedHandles, version )
				);

				const cssPath = path.join( outDir, 'index.css' );
				try {
					await access( cssPath );
					const css = await readFile( cssPath, 'utf8' );
					await writeFile(
						path.join( outDir, 'index-rtl.css' ),
						rtlcss.process( css )
					);
				} catch ( err ) {
					if ( err.code !== 'ENOENT' ) {
						throw err;
					}
				}

				console.log(
					`✓ ${ entry } → ${ path.relative(
						ROOT,
						outDir
					) }/index.* [deps: ${
						[ ...usedHandles ].join( ', ' ) || '(none)'
					}] [v${ version }]`
				);
			} );
		},
	};
}

async function makeContext( entry, outDir ) {
	const usedHandles = new Set();
	return esbuild.context( {
		entryPoints: [ path.resolve( ROOT, entry ) ],
		bundle: true,
		// Resolve bare imports from aliased @newspack-nodes/shared sources
		// against the substrate's node_modules too.
		nodePaths: [ path.resolve( ROOT, '../../node_modules' ) ],
		minify: true,
		// dump_metadata reads node.constructor.name to label classes — keepNames
		// preserves the identifiers minify would otherwise mangle.
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
		// Public consumption surface. This example sits at examples/<name> inside
		// the substrate, so the canonical src is two levels up. NEWSPACK_NODES_*
		// env overrides match the consumer build for CI. esbuild prefix-matches
		// the bare `shared` alias, so `@newspack-nodes/shared/hooks/x` resolves to
		// `../../src/shared/hooks/x`.
		alias: {
			'@newspack-nodes/runtime':
				process.env.NEWSPACK_NODES_RUNTIME ||
				path.resolve( ROOT, '../../src/runtime/index.js' ),
			'@newspack-nodes/debug-overlay':
				process.env.NEWSPACK_NODES_DEBUG_OVERLAY ||
				path.resolve(
					ROOT,
					'../../src/debug-overlay/DebugOverlay.js'
				),
			'@newspack-nodes/shared':
				process.env.NEWSPACK_NODES_SHARED ||
				path.resolve( ROOT, '../../src/shared' ),
		},
		plugins: [
			wpExternalsPlugin( usedHandles ),
			scssPlugin(),
			postBuildPlugin( entry, outDir, usedHandles ),
		],
		logLevel: 'warning',
	} );
}

const ENTRIES = [
	{
		entry: 'src/dashboard/index.js',
		outDir: path.resolve( ROOT, 'build/dashboard' ),
	},
];

async function main() {
	const watch = process.argv.includes( '--watch' );
	await rm( path.resolve( ROOT, 'build' ), { recursive: true, force: true } );
	for ( const e of ENTRIES ) {
		await mkdir( e.outDir, { recursive: true } );
	}
	const contexts = await Promise.all(
		ENTRIES.map( ( e ) => makeContext( e.entry, e.outDir ) )
	);
	if ( watch ) {
		await Promise.all( contexts.map( ( c ) => c.watch() ) );
		console.log( '👀 watching for changes…' );
	} else {
		await Promise.all( contexts.map( ( c ) => c.rebuild() ) );
		await Promise.all( contexts.map( ( c ) => c.dispose() ) );
	}
}

main().catch( ( err ) => {
	console.error( err );
	process.exit( 1 );
} );
