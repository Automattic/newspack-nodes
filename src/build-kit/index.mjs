/**
 * Shared esbuild dashboard builder — the common core of every consumer's
 * `scripts/build.mjs` (the substrate, the bundled example, and the sibling
 * event-logger-nodes plugin all import `buildDashboards()` from here).
 *
 * For each entry, emits to <outDir>:
 *   - <base>.js         minified bundle
 *   - <base>.css        extracted CSS (if any styles imported)
 *   - <base>.asset.php  WordPress enqueue manifest: { dependencies, version }
 *   - <base>-rtl.css    rtlcss companion (when there's CSS)
 *
 * Imports of `@wordpress/*` packages and the JSX runtime are rewritten to read
 * from the corresponding window global (the way WordPress's enqueue system
 * exposes them) and recorded in `<base>.asset.php` so wp_enqueue_script picks
 * up the right handles.
 *
 * Dependency injection — esbuild/sass/rtlcss are PARAMETERS, never bare
 * imports. Each consumer's build.mjs lives at a different filesystem location
 * (the event-logger build runs against a sibling newspack-nodes checkout that
 * has NO node_modules), so this module must not resolve those packages
 * relative to itself. It imports only node builtins.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';

// Map import path → { global, handle }.
//   global: runtime JS expression (read from `window`)
//   handle: WordPress enqueue handle for *.asset.php
export const WP_EXTERNALS = {
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
	// Block model + the editor's markdown-paste engine (pasteHandler/serialize).
	'@wordpress/blocks': {
		global: 'window.wp.blocks',
		handle: 'wp-blocks',
	},
	// Core block registry (registerCoreBlocks). Large, but a real runtime WP
	// script — externalize so WP enqueues it and the dashboard reuses the same
	// registry the editor does, instead of bundling a duplicate.
	'@wordpress/block-library': {
		global: 'window.wp.blockLibrary',
		handle: 'wp-block-library',
	},
	'@wordpress/i18n': {
		global: 'window.wp.i18n',
		handle: 'wp-i18n',
	},
	// NOT @wordpress/icons: it is a build-time package (SVG-as-React-components),
	// not a runtime script — WP exposes no `window.wp.icons` global and registers
	// no `wp-icons` handle (WP 6.9.1 warns on the unmet dep). Externalizing it left
	// the icon undefined at runtime; bundle it from node_modules instead.
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
 * Build a Sass importer that resolves the `@newspack-nodes/*` aliases inside
 * `@use` / `@forward` — Sass does its own load resolution and never sees
 * esbuild's `alias` map, so a bare `@use '@newspack-nodes/shared/styles/x'`
 * would fail. We rewrite the alias prefix to its mapped absolute path and hand
 * the rest back to Sass's normal partial resolution (`_x.scss`). Longest alias
 * key wins so `@newspack-nodes/shared/styles` can't be shadowed by a shorter
 * `@newspack-nodes/shared` prefix.
 */
function aliasImporter( alias ) {
	const keys = Object.keys( alias ).sort( ( a, b ) => b.length - a.length );
	return {
		findFileUrl( url ) {
			for ( const key of keys ) {
				if ( url === key || url.startsWith( `${ key }/` ) ) {
					const rest = url.slice( key.length );
					return new URL(
						`file://${ path.resolve( alias[ key ] + rest ) }`
					);
				}
			}
			return null;
		},
	};
}

/**
 * esbuild plugin: compile .scss via the injected Sass package, hand the CSS
 * to esbuild. The consumer alias map is threaded into a Sass importer so SCSS
 * `@use`/`@forward` can pull shared partials through the `@newspack-nodes/*`
 * surface, exactly like the JS imports do.
 */
function scssPlugin( sass, alias ) {
	const importers = [ aliasImporter( alias ) ];
	return {
		name: 'scss',
		setup( build ) {
			build.onLoad( { filter: /\.scss$/ }, async ( args ) => {
				const result = await sass.compileAsync( args.path, {
					loadPaths: [ path.dirname( args.path ) ],
					importers,
				} );
				return {
					contents: result.css,
					loader: 'css',
				};
			} );
		},
	};
}

export function emitAssetPhp( handles, version ) {
	const deps = [ ...handles ]
		.sort()
		.map( ( h ) => `'${ h }'` )
		.join( ', ' );
	return `<?php return array('dependencies' => array(${ deps }), 'version' => '${ version }');\n`;
}

/**
 * esbuild plugin: after each run, emit <base>.asset.php (deps from
 * usedHandles + content-hash version) and <base>-rtl.css (rtlcss-processed
 * companion for is_rtl() loads). Runs on every rebuild in watch mode.
 */
function postBuildPlugin( entry, outDir, base, usedHandles, root, rtlcss ) {
	return {
		name: 'post-build',
		setup( build ) {
			build.onEnd( async ( result ) => {
				if ( result.errors.length ) {
					return;
				}
				const jsBytes = await readFile(
					path.join( outDir, `${ base }.js` )
				);
				const version = createHash( 'sha256' )
					.update( jsBytes )
					.digest( 'hex' )
					.slice( 0, 20 );
				await writeFile(
					path.join( outDir, `${ base }.asset.php` ),
					emitAssetPhp( usedHandles, version )
				);

				const cssPath = path.join( outDir, `${ base }.css` );
				try {
					await access( cssPath );
					const css = await readFile( cssPath, 'utf8' );
					await writeFile(
						path.join( outDir, `${ base }-rtl.css` ),
						rtlcss.process( css )
					);
				} catch ( err ) {
					if ( err.code !== 'ENOENT' ) {
						throw err;
					}
				}

				console.log(
					`✓ ${ entry } → ${ path.relative(
						root,
						outDir
					) }/${ base }.* [deps: ${
						[ ...usedHandles ].join( ', ' ) || '(none)'
					}] [v${ version }]`
				);
			} );
		},
	};
}

/**
 * Build (or watch) every dashboard entry for a consumer plugin.
 *
 * @param {Object}   opts
 * @param {Object}   opts.esbuild     The consumer's esbuild module (default import).
 * @param {Object}   opts.sass        The consumer's sass module (namespace import).
 * @param {Object}   opts.rtlcss      The consumer's rtlcss module (default import).
 * @param {string}   opts.root        Absolute ROOT dir of the consumer plugin.
 * @param {Array}    opts.entries     [{ entry, outDir }, …].
 * @param {Object}   opts.alias       esbuild alias map (consumer-built, incl. env overrides).
 * @param {string[]} [opts.nodePaths] esbuild resolve nodePaths.
 * @param {boolean}  [opts.watch]     Stay alive rebuilding on change.
 * @param {string}   [opts.logLevel]  esbuild log level.
 */
export async function buildDashboards( {
	esbuild,
	sass,
	rtlcss,
	root,
	entries,
	alias,
	nodePaths = [],
	watch = false,
	logLevel = 'warning',
} ) {
	// Output basename mirrors the entry filename (settings.js → settings.js in
	// outDir, index.js → index.js). Several WP-side enqueue paths look up
	// `build/<dir>/<entry-basename>.css` directly.
	const makeContext = ( entry, outDir ) => {
		const usedHandles = new Set();
		const base = path.basename( entry, '.js' );
		return esbuild.context( {
			entryPoints: [ path.resolve( root, entry ) ],
			bundle: true,
			nodePaths,
			minify: true,
			// dump_metadata reads node.constructor.name to label classes on the
			// canvas — without keepNames, minify mangles them to two-letter ids.
			keepNames: true,
			format: 'iife',
			target: [ 'es2020' ],
			jsx: 'automatic',
			outfile: path.join( outDir, `${ base }.js` ),
			loader: {
				'.js': 'jsx',
				'.svg': 'dataurl',
				'.png': 'dataurl',
			},
			alias,
			plugins: [
				wpExternalsPlugin( usedHandles ),
				scssPlugin( sass, alias ),
				postBuildPlugin(
					entry,
					outDir,
					base,
					usedHandles,
					root,
					rtlcss
				),
			],
			logLevel,
		} );
	};

	for ( const e of entries ) {
		await mkdir( e.outDir, { recursive: true } );
	}
	const contexts = await Promise.all(
		entries.map( ( e ) => makeContext( e.entry, e.outDir ) )
	);
	if ( watch ) {
		await Promise.all( contexts.map( ( c ) => c.watch() ) );
		console.log( '👀 watching for changes…' );
		// Keep node alive; esbuild's watcher runs in a worker thread.
	} else {
		await Promise.all( contexts.map( ( c ) => c.rebuild() ) );
		await Promise.all( contexts.map( ( c ) => c.dispose() ) );
	}
}
