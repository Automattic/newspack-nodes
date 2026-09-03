/**
 * Shared esbuild dashboard builder — the common core of every consumer's
 * `scripts/build.mjs`. The substrate, the bundled example and every sibling
 * plugin that ships dashboards import `buildDashboards()` from here, so each
 * one declares only WHAT to bundle and injects the tools.
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
 * imports. Each consumer's build.mjs lives at a different filesystem location,
 * and a sibling builds against a newspack-nodes checkout that has NO
 * node_modules, so this module must not resolve those packages relative to
 * itself. It imports only node builtins.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';

/**
 * The substrate version, stamped as a banner comment into every bundle the kit
 * builds, so a deployed bundle names the substrate it was built against.
 *
 * `scripts/bump-version.sh` rewrites it together with the plugin header, the
 * `NEWSPACK_NODES_VERSION` constant and `package.json`; never edit it by hand,
 * and a build-kit test pins it to `package.json`. It is a literal rather than a
 * `package.json` read because the kit cannot locate itself portably —
 * `import.meta` is invalid once jest's CJS transform rewrites this module — and
 * the bump script already owns keeping the four copies in step.
 *
 * @type {string}
 */
const SUBSTRATE_VERSION = '2.49.1';

/**
 * Read the substrate version this kit stamps into every bundle.
 *
 * @return {string} Semver of newspack-nodes.
 */
export function substrateVersion() {
	return SUBSTRATE_VERSION;
}

/**
 * Fail fast when an alias points nowhere, naming the env var that fixes it.
 *
 * Without this, a consumer building outside a sibling newspack-nodes checkout —
 * or a release.yml that never set `NEWSPACK_NODES_SRC` — dies deep inside
 * esbuild with ERR_MODULE_NOT_FOUND and no hint of which path was wrong.
 *
 * @param {Object<string,string>} alias esbuild alias map, specifier → absolute
 *                                      path, as `alias-map.cjs` projects it.
 * @throws {Error} When a mapped path does not exist.
 */
export function assertAliasPathsExist( alias ) {
	for ( const [ key, aliasPath ] of Object.entries( alias ) ) {
		if ( existsSync( aliasPath ) ) {
			continue;
		}
		// ONE knob; a per-alias name would hit assertNoRetiredOverrides.
		throw new Error(
			`alias ${ key } → ${ aliasPath } does not exist — set ` +
				'NEWSPACK_NODES_SRC to the substrate `src` directory when ' +
				'building outside a sibling newspack-nodes checkout'
		);
	}
}

/**
 * Import specifier → the window global that supplies it at runtime and the
 * WordPress enqueue handle that guarantees the global is there.
 *
 * WordPress already serves these packages, so bundling a second copy ships
 * dead bytes, and a second React breaks hooks outright. `@wordpress/icons` is
 * absent deliberately: it publishes no runtime global, so a consumer importing
 * it bundles the icons it uses.
 *
 * @type {Object<string,{global:string,handle:string}>}
 */
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
	// Block model + editor markdown-paste (pasteHandler/serialize).
	'@wordpress/blocks': {
		global: 'window.wp.blocks',
		handle: 'wp-blocks',
	},
	// Core block registry: externalize so WP enqueues it (no duplicate).
	'@wordpress/block-library': {
		global: 'window.wp.blockLibrary',
		handle: 'wp-block-library',
	},
	'@wordpress/i18n': {
		global: 'window.wp.i18n',
		handle: 'wp-i18n',
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
 * Build the esbuild plugin that rewrites every `WP_EXTERNALS` import into a
 * read of its window global and records which handles the bundle reached for,
 * so `<base>.asset.php` declares the dependencies it actually has.
 *
 * Marking the packages `external` instead leaves a bare `require()` in an IIFE
 * bundle, which the browser has no loader for. A stub module returning the
 * global is what an IIFE can hold.
 *
 * @param {Set<string>} usedHandles Collector each matched package's enqueue
 *                                  handle is added to as it loads.
 * @return {Object} esbuild plugin.
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
 * Build a Sass importer resolving the `@newspack-nodes/*` aliases inside `@use`
 * and `@forward`.
 *
 * Sass runs its own load resolution and never sees esbuild's `alias` map, so a
 * bare `@use '@newspack-nodes/shared/styles/x'` would fail. The importer swaps
 * the alias prefix for its mapped absolute path and hands the rest back to
 * Sass's normal partial resolution (`_x.scss`). The longest key wins, so a
 * future `@newspack-nodes/shared/styles` entry cannot be shadowed by the
 * shorter `@newspack-nodes/shared` prefix; returning null defers to Sass.
 *
 * @param {Object<string,string>} alias esbuild alias map, specifier → absolute
 *                                      path.
 * @return {Object} Sass importer exposing `findFileUrl`.
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
 * Build the esbuild plugin that compiles `.scss` through the injected Sass
 * package and hands the CSS back to esbuild's own `css` loader.
 *
 * The consumer's alias map is threaded into a Sass importer so `@use` and
 * `@forward` pull shared partials through the `@newspack-nodes/*` surface,
 * exactly as the JS imports do.
 *
 * @param {Object}                sass  The consumer's sass module (namespace
 *                                      import).
 * @param {Object<string,string>} alias esbuild alias map, specifier → absolute
 *                                      path.
 * @return {Object} esbuild plugin.
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

/**
 * Render the `<base>.asset.php` enqueue manifest WordPress reads alongside a
 * bundle, emitted sorted and deduped so the file only changes when the deps do.
 *
 * @param {Set<string>} handles Enqueue handles the bundle actually pulled from
 *                              window globals, collected by the wp-externals
 *                              plugin during the build.
 * @param {string}      version Cache-busting version — the content hash of the
 *                              emitted JS.
 * @return {string} PHP source returning the `dependencies`/`version` array.
 */
export function emitAssetPhp( handles, version ) {
	const deps = [ ...handles ]
		.sort()
		.map( ( h ) => `'${ h }'` )
		.join( ', ' );
	return `<?php return array('dependencies' => array(${ deps }), 'version' => '${ version }');\n`;
}

/**
 * Build the esbuild plugin that finishes each successful run: it writes
 * `<base>.asset.php` from the handles `usedHandles` collected plus a content
 * hash of the emitted JS, then, when the entry produced CSS, the rtlcss
 * `<base>-rtl.css` companion `is_rtl()` loads. `onEnd` fires on every rebuild,
 * watch-mode ones included.
 *
 * Hashing the emitted JS beats stamping a build timestamp: the manifest stays
 * byte-identical when nothing changed, so a rebuild leaves the tracked `build/`
 * tree alone. A JS-only entry emits no stylesheet, which is why ENOENT is the
 * one error the RTL step swallows.
 *
 * @param {string}      entry       Entry path relative to `root`, for the log
 *                                  line.
 * @param {string}      outDir      Absolute directory the bundle is emitted to.
 * @param {string}      base        Output basename — the entry filename without
 *                                  its `.js` extension.
 * @param {Set<string>} usedHandles Enqueue handles the wp-externals plugin
 *                                  collected during this run.
 * @param {string}      root        Consumer plugin root, so the log line prints
 *                                  a relative output path.
 * @param {Object}      rtlcss      The consumer's rtlcss module (default
 *                                  import).
 * @return {Object} esbuild plugin.
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
 * Alias paths are checked before esbuild starts, so a bad checkout fails with a
 * fixable message instead of a resolution error. Each entry gets its own
 * context and they run concurrently. A one-shot build disposes every context;
 * a watch build keeps them, and esbuild's watcher is what holds the process
 * open afterwards.
 *
 * @param {Object}                              opts
 * @param {Object}                              opts.esbuild     The consumer's esbuild module (default import).
 * @param {Object}                              opts.sass        The consumer's sass module (namespace import).
 * @param {Object}                              opts.rtlcss      The consumer's rtlcss module (default import).
 * @param {string}                              opts.root        Absolute ROOT dir of the consumer plugin; every entry path resolves from it.
 * @param {Array<{entry:string,outDir:string}>} opts.entries     One bundle per element; `outDir` is created if missing.
 * @param {Object<string,string>}               opts.alias       esbuild alias map, as `alias-map.cjs` projects it from the substrate `src`.
 * @param {string[]}                            [opts.nodePaths] esbuild resolve nodePaths, pinning a bare import like `d3` to the consumer's own copy.
 * @param {boolean}                             [opts.watch]     Stay alive rebuilding on change.
 * @param {string}                              [opts.logLevel]  esbuild log level.
 * @return {Promise<void>} Resolves once every entry is built, or, in watch mode, once every watcher is running.
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
	assertAliasPathsExist( alias );
	const banner = { js: `/* @newspack-nodes ${ substrateVersion() } */` };
	// Output basename mirrors the entry filename; WP enqueue paths need it.
	const makeContext = ( entry, outDir ) => {
		const usedHandles = new Set();
		const base = path.basename( entry, '.js' );
		return esbuild.context( {
			entryPoints: [ path.resolve( root, entry ) ],
			bundle: true,
			nodePaths,
			minify: true,
			// keepNames protects constructor.name for dump_metadata labels.
			keepNames: true,
			format: 'iife',
			target: [ 'es2020' ],
			jsx: 'automatic',
			outfile: path.join( outDir, `${ base }.js` ),
			banner,
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
