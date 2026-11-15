/**
 * Shared esbuild builder — the common core of every consumer's
 * `scripts/build.mjs`. The substrate, the bundled example and every sibling
 * plugin that ships dashboards import `buildDashboards()` from here, and a
 * plugin shipping blocks imports `buildBlocks()`, so each one declares only
 * WHAT to bundle and injects the tools.
 *
 * For each entry, emits to <outDir>:
 *   - <base>.js         minified bundle
 *   - <base>.css        extracted CSS (if any styles imported)
 *   - <base>.asset.php  WordPress enqueue manifest: { dependencies, version }
 *   - <base>-rtl.css    rtlcss companion (when there's CSS)
 * For a block entry, additionally:
 *   - style-<base>.css      the `style.scss` the entry reaches, split out of
 *                           <base>.css as `wp-scripts build` splits it
 *   - style-<base>-rtl.css  rtlcss companion
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
 * itself. It imports only node builtins and its sibling alias map, whose
 * `aliasImporter()` resolves the aliases inside Sass.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import aliasMap from './alias-map.cjs';
import { phpExport } from './php-export.mjs';

const { aliasImporter } = aliasMap;

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
const SUBSTRATE_VERSION = '2.160.0';

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
 * The substrate's one DataViews copy, which WordPress does not serve:
 * `Admin::DATAVIEWS_HANDLE` registers it, and its bundle publishes the global.
 *
 * @type {{global:string,handle:string}}
 */
const DATAVIEWS = {
	global: 'window.newspackNodesDataViews',
	handle: 'newspack-nodes-dataviews',
};

/**
 * Import specifier → the window global that supplies it at runtime and the
 * WordPress enqueue handle that guarantees the global is there.
 *
 * WordPress already serves these packages, so bundling a second copy ships
 * dead bytes, and a second React breaks hooks outright. `@wordpress/icons` is
 * absent deliberately: it publishes no runtime global, so a consumer importing
 * it bundles the icons it uses. `@wordpress/dataviews` is the one global the
 * substrate serves itself, from the bundle whose entry `provides` it.
 *
 * @type {Object<string,{global:string,handle:string}>}
 */
export const WP_EXTERNALS = {
	'@wordpress/element': {
		global: 'window.wp.element',
		handle: 'wp-element',
	},
	'@wordpress/a11y': {
		global: 'window.wp.a11y',
		handle: 'wp-a11y',
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
	// The block canvas; Block_Editor_Bootstrap::load_canvas() enqueues it.
	'@wordpress/block-editor': {
		global: 'window.wp.blockEditor',
		handle: 'wp-block-editor',
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
	'@wordpress/url': {
		global: 'window.wp.url',
		handle: 'wp-url',
	},
	'@wordpress/hooks': {
		global: 'window.wp.hooks',
		handle: 'wp-hooks',
	},
	'@wordpress/html-entities': {
		global: 'window.wp.htmlEntities',
		handle: 'wp-html-entities',
	},
	// A rich-text format type, registered beside the blocks.
	'@wordpress/rich-text': {
		global: 'window.wp.richText',
		handle: 'wp-rich-text',
	},
	// A block's document sidebar and its server-rendered preview.
	'@wordpress/plugins': {
		global: 'window.wp.plugins',
		handle: 'wp-plugins',
	},
	'@wordpress/editor': {
		global: 'window.wp.editor',
		handle: 'wp-editor',
	},
	'@wordpress/server-side-render': {
		global: 'window.wp.serverSideRender',
		handle: 'wp-server-side-render',
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
	// Reached by @wordpress/dataviews and the @wordpress/ui it bundles.
	'@wordpress/compose': {
		global: 'window.wp.compose',
		handle: 'wp-compose',
	},
	'@wordpress/date': {
		global: 'window.wp.date',
		handle: 'wp-date',
	},
	'@wordpress/deprecated': {
		global: 'window.wp.deprecated',
		handle: 'wp-deprecated',
	},
	'@wordpress/keycodes': {
		global: 'window.wp.keycodes',
		handle: 'wp-keycodes',
	},
	'@wordpress/primitives': {
		global: 'window.wp.primitives',
		handle: 'wp-primitives',
	},
	// One registry, or unlocking wp.components' private APIs throws.
	'@wordpress/private-apis': {
		global: 'window.wp.privateApis',
		handle: 'wp-private-apis',
	},
	// One theme context, shared with wp.components.
	'@wordpress/theme': {
		global: 'window.wp.theme',
		handle: 'wp-theme',
	},
	'@wordpress/warning': {
		global: 'window.wp.warning',
		handle: 'wp-warning',
	},
	'@wordpress/dataviews': DATAVIEWS,
	// The self-contained entry, or a consumer would bundle a second copy.
	'@wordpress/dataviews/wp': DATAVIEWS,
	'react/jsx-runtime': {
		global: 'window.ReactJSXRuntime',
		handle: 'react-jsx-runtime',
	},
};

/**
 * Build the esbuild plugin that rewrites every `WP_EXTERNALS` import into a
 * read of its window global, a stub module in the `wp-external` namespace that
 * `bundledHandles()` finds in the metafile.
 *
 * Marking the packages `external` instead leaves a bare `require()` in an IIFE
 * bundle, which the browser has no loader for. A stub module returning the
 * global is what an IIFE can hold.
 *
 * @param {string[]} provides Specifiers this bundle supplies as their globals,
 *                            so it bundles them instead.
 * @return {Object} esbuild plugin.
 */
function wpExternalsPlugin( provides ) {
	return {
		name: 'wp-externals',
		setup( build ) {
			const filter = new RegExp(
				'^(' +
					Object.keys( WP_EXTERNALS )
						.filter( ( k ) => ! provides.includes( k ) )
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
					return {
						contents: `module.exports = ${
							WP_EXTERNALS[ args.path ].global
						};`,
						loader: 'js',
					};
				}
			);
		},
	};
}

/**
 * Compile one `.scss` file through the injected Sass package.
 *
 * The importing file's own directory joins the load path, so a partial
 * resolves relative to it, and the alias importer resolves the
 * `@newspack-nodes/*` surface inside `@use` and `@forward`.
 *
 * @param {Object}   sass      The consumer's sass module (namespace import).
 * @param {Object[]} importers Sass importers for `@use` urls.
 * @param {string}   file      Absolute path of the stylesheet.
 * @return {Promise<{css:string,watchFiles:string[]}>} The CSS, and every
 *         local file Sass loaded, for esbuild's watcher.
 */
async function compileScss( sass, importers, file ) {
	const result = await sass.compileAsync( file, {
		loadPaths: [ path.dirname( file ) ],
		importers,
	} );
	return {
		css: result.css,
		watchFiles: result.loadedUrls
			.filter( ( url ) => 'file:' === url.protocol )
			.map( ( url ) => fileURLToPath( url ) ),
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
				const { css, watchFiles } = await compileScss(
					sass,
					importers,
					args.path
				);
				// esbuild's watcher rebuilds when any of these changes.
				return { contents: css, loader: 'css', watchFiles };
			} );
		},
	};
}

/**
 * Build the esbuild plugin that diverts every `style.scss` a block entry
 * reaches out of the bundle's stylesheet, the split `wp-scripts build` makes:
 * `style.scss` is the CSS the front end loads, and every other stylesheet the
 * entry imports is editor-only.
 *
 * Each one compiles into `styles`, keyed by path, and loads as an empty JS
 * module, so it adds nothing to `<base>.css` and an entry importing only
 * `style.scss` emits no `<base>.css` at all. The post-build step writes what
 * `styles` holds. Register it ahead of `scssPlugin()`: esbuild stops at the
 * first `onLoad` that answers.
 *
 * @param {Object}                sass   The consumer's sass module.
 * @param {Object<string,string>} alias  esbuild alias map, for the importer.
 * @param {Map<string,string>}    styles Collector of each `style.scss`'s CSS,
 *                                       emptied as each build starts.
 * @return {Object} esbuild plugin.
 */
function blockStyleSplitPlugin( sass, alias, styles ) {
	const importers = [ aliasImporter( alias ) ];
	return {
		name: 'block-style-split',
		setup( build ) {
			build.onStart( () => styles.clear() );
			build.onLoad(
				{ filter: /(^|[\\/])style\.scss$/ },
				async ( args ) => {
					const { css, watchFiles } = await compileScss(
						sass,
						importers,
						args.path
					);
					styles.set( args.path, css );
					return { contents: '', loader: 'js', watchFiles };
				}
			);
		},
	};
}

/**
 * Render the `<base>.asset.php` enqueue manifest WordPress reads alongside a
 * bundle, emitted sorted and deduped so the file only changes when the deps do.
 *
 * @param {Set<string>} handles Enqueue handles the bundle pulled from
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
 * Write a stylesheet and its rtlcss companion, or remove both when there is
 * no CSS, so a build that stops emitting one leaves no stale copy behind.
 *
 * @param {string}      outDir Absolute output directory.
 * @param {string}      name   Basename, without `.css`.
 * @param {string|null} css    The stylesheet, or null for none.
 * @param {Object}      rtlcss The consumer's rtlcss module (default import).
 * @return {Promise<void>} Resolves once both files are written or removed.
 */
async function writeStylesheet( outDir, name, css, rtlcss ) {
	const file = path.join( outDir, `${ name }.css` );
	const rtl = path.join( outDir, `${ name }-rtl.css` );
	if ( null === css ) {
		await rm( file, { force: true } );
		await rm( rtl, { force: true } );
		return;
	}
	await writeFile( file, css );
	await writeFile( rtl, rtlcss.process( css ) );
}

/**
 * Build the esbuild plugin that finishes each successful run: it writes
 * `<base>.asset.php` from the handles the emitted JS reads plus a content
 * hash of it, then, when the entry produced CSS, the rtlcss
 * `<base>-rtl.css` companion `is_rtl()` loads, and for a block entry the
 * minified `style-<base>.css` and its companion from what `styles` holds.
 * `onEnd` fires on every rebuild, watch-mode ones included.
 *
 * Hashing the emitted JS beats stamping a build timestamp: the manifest stays
 * byte-identical when nothing changed, so a rebuild leaves the tracked `build/`
 * tree alone. Whether the build emitted CSS is read from the metafile, never
 * from the disk: a build whose entry no longer imports a stylesheet removes
 * the `<base>.css` and `<base>-rtl.css` an earlier build left in `outDir`, and
 * one that no longer reaches a `style.scss` removes `style-<base>.css`.
 *
 * @param {string}                  entry  Entry path relative to `root`,
 *                                         for the log line.
 * @param {string}                  outDir Absolute directory the bundle
 *                                         is emitted to.
 * @param {string}                  base   Output basename — the entry
 *                                         filename without its `.js`.
 * @param {string}                  root   Consumer plugin root, so the
 *                                         log line prints a relative
 *                                         output path.
 * @param {Object}                  rtlcss The consumer's rtlcss module
 *                                         (default import).
 * @param {Map<string,string>|null} styles What the block-style-split
 *                                         plugin collected, or null for
 *                                         an entry that splits none.
 * @return {Object} esbuild plugin.
 */
function postBuildPlugin( entry, outDir, base, root, rtlcss, styles ) {
	return {
		name: 'post-build',
		setup( build ) {
			build.onEnd( async ( result ) => {
				if ( result.errors.length ) {
					return;
				}
				const jsPath = path.join( outDir, `${ base }.js` );
				const jsBytes = await readFile( jsPath );
				const handles = bundledHandles( result.metafile, jsPath );
				const version = createHash( 'sha256' )
					.update( jsBytes )
					.digest( 'hex' )
					.slice( 0, 20 );
				await writeFile(
					path.join( outDir, `${ base }.asset.php` ),
					emitAssetPhp( handles, version )
				);

				const cssPath = path.resolve( outDir, `${ base }.css` );
				const emittedCss = Object.keys( result.metafile.outputs ).some(
					( out ) => path.resolve( out ) === cssPath
				);
				await writeStylesheet(
					outDir,
					base,
					emittedCss ? await readFile( cssPath, 'utf8' ) : null,
					rtlcss
				);
				if ( styles ) {
					await writeStylesheet(
						outDir,
						`style-${ base }`,
						await splitCss( build.esbuild, styles ),
						rtlcss
					);
				}

				console.log(
					`✓ ${ entry } → ${ path.relative(
						root,
						outDir
					) }/${ base }.* [deps: ${
						[ ...handles ].join( ', ' ) || '(none)'
					}] [v${ version }]`
				);
			} );
		},
	};
}

/**
 * The enqueue handles of the `WP_EXTERNALS` stubs a bundle carries, read from
 * the metafile: a stub that only tree-shaken code imported contributes no
 * bytes, so the manifest names exactly the globals the bundle reads.
 *
 * @param {Object} metafile The build's esbuild metafile.
 * @param {string} jsPath   Absolute path of the emitted bundle.
 * @return {Set<string>} The handles.
 */
function bundledHandles( metafile, jsPath ) {
	const [ , output ] = Object.entries( metafile.outputs ).find(
		( [ out ] ) => path.resolve( out ) === path.resolve( jsPath )
	);
	const handles = new Set();
	for ( const [ input, { bytesInOutput } ] of Object.entries(
		output.inputs
	) ) {
		if ( input.startsWith( 'wp-external:' ) && bytesInOutput > 0 ) {
			handles.add(
				WP_EXTERNALS[ input.slice( 'wp-external:'.length ) ].handle
			);
		}
	}
	return handles;
}

/**
 * Join and minify the `style.scss` stylesheets one block entry reached, in
 * path order so a rebuild writes the same bytes.
 *
 * @param {Object}             esbuild The esbuild running the build, whose
 *                                     `transform()` minifies.
 * @param {Map<string,string>} styles  CSS keyed by `style.scss` path.
 * @return {Promise<string|null>} The stylesheet, or null for an entry that
 *         reached no `style.scss`.
 */
async function splitCss( esbuild, styles ) {
	if ( 0 === styles.size ) {
		return null;
	}
	const css = [ ...styles.keys() ]
		.sort()
		.map( ( file ) => styles.get( file ) )
		.join( '\n' );
	return ( await esbuild.transform( css, { loader: 'css', minify: true } ) )
		.code;
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
 * @param {Object}                                                                     opts
 * @param {Object}                                                                     opts.esbuild     The consumer's esbuild module (default import).
 * @param {Object}                                                                     opts.sass        The consumer's sass module (namespace import).
 * @param {Object}                                                                     opts.rtlcss      The consumer's rtlcss module (default import).
 * @param {string}                                                                     opts.root        Absolute ROOT dir of the consumer plugin; every entry path resolves from it.
 * @param {Array<{entry:string,outDir:string,provides?:string[],splitStyle?:boolean}>} opts.entries     One bundle per element; `outDir` is created if missing, `provides` names the `WP_EXTERNALS` specifiers the bundle publishes as their globals, and `splitStyle` splits each `style.scss` it reaches into `style-<base>.css`, as a block's editor entry does.
 * @param {Object<string,string>}                                                      opts.alias       esbuild alias map, as `alias-map.cjs` projects it from the substrate `src`.
 * @param {string[]}                                                                   [opts.nodePaths] esbuild resolve nodePaths, pinning a bare import like `d3` to the consumer's own copy.
 * @param {boolean}                                                                    [opts.watch]     Stay alive rebuilding on change.
 * @param {string}                                                                     [opts.logLevel]  esbuild log level.
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
	const makeContext = ( { entry, outDir, provides = [], splitStyle } ) => {
		const styles = splitStyle ? new Map() : null;
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
			// The post-build step reads which files this build emitted.
			metafile: true,
			loader: {
				'.js': 'jsx',
				'.svg': 'dataurl',
				'.png': 'dataurl',
			},
			alias,
			plugins: [
				wpExternalsPlugin( provides ),
				...( styles
					? [ blockStyleSplitPlugin( sass, alias, styles ) ]
					: [] ),
				scssPlugin( sass, alias ),
				postBuildPlugin( entry, outDir, base, root, rtlcss, styles ),
			],
			logLevel,
		} );
	};

	for ( const e of entries ) {
		await mkdir( e.outDir, { recursive: true } );
	}
	const contexts = await Promise.all( entries.map( makeContext ) );
	if ( watch ) {
		await Promise.all( contexts.map( ( c ) => c.watch() ) );
		console.log( '👀 watching for changes…' );
		// Keep node alive; esbuild's watcher runs in a worker thread.
	} else {
		try {
			await Promise.all( contexts.map( ( c ) => c.rebuild() ) );
		} finally {
			// A failed build frees esbuild too, so node exits.
			await Promise.all( contexts.map( ( c ) => c.dispose() ) );
		}
	}
}

/**
 * Find the blocks under a source directory: each subdirectory holding a
 * `block.json`, in slug order, so adding a block needs no edit and a
 * directory of shared code is passed over. A missing source directory holds
 * no blocks. Only ENOENT is read as absence: a malformed `block.json` throws
 * its `SyntaxError`, failing the build instead of dropping the block.
 *
 * @param {string} srcDir Directory holding one subdirectory per block.
 * @return {Promise<Array<{slug:string,dir:string,metadata:Object}>>} Every
 *         block found, with its parsed metadata.
 */
async function discoverBlocks( srcDir ) {
	let dirents;
	try {
		dirents = await readdir( srcDir, { withFileTypes: true } );
	} catch ( err ) {
		if ( 'ENOENT' === err.code ) {
			return [];
		}
		throw err;
	}
	const blocks = [];
	for ( const dirent of dirents.filter( ( d ) => d.isDirectory() ) ) {
		const dir = path.join( srcDir, dirent.name );
		let json;
		try {
			json = await readFile( path.join( dir, 'block.json' ), 'utf8' );
		} catch ( err ) {
			if ( 'ENOENT' === err.code ) {
				continue;
			}
			throw err;
		}
		blocks.push( { slug: dirent.name, dir, metadata: JSON.parse( json ) } );
	}
	return blocks.sort( ( a, b ) => ( a.slug < b.slug ? -1 : 1 ) );
}

/**
 * Render the blocks manifest: every block's metadata keyed by its slug, the
 * collection `wp_register_block_types_from_metadata_collection()` reads in
 * place of each `block.json`.
 *
 * @param {Array<{slug:string,metadata:Object}>} blocks Discovered blocks.
 * @return {string} PHP source returning the collection.
 */
function blocksManifest( blocks ) {
	const entries = blocks
		.map(
			( b ) =>
				`\t${ phpExport( b.slug ) } => ${ phpExport(
					b.metadata,
					'\t'
				) }`
		)
		.join( ',\n' );
	return `<?php\n// This file is generated. Do not modify it manually.\nreturn array(\n${ entries }\n);\n`;
}

/**
 * Copy a file when it exists; a missing source copies nothing.
 *
 * @param {string} from Source path.
 * @param {string} to   Destination path.
 * @return {Promise<void>} Resolves once copied, or at once for no source.
 */
async function copyIfPresent( from, to ) {
	try {
		await copyFile( from, to );
	} catch ( err ) {
		if ( 'ENOENT' !== err.code ) {
			throw err;
		}
	}
}

/**
 * The `.js` files directly under a block's `lazy/` directory, sorted, or none
 * when it has no such directory.
 *
 * @param {string} blockDir Absolute block source directory.
 * @return {Promise<string[]>} The file names.
 */
async function lazyScripts( blockDir ) {
	try {
		return (
			await readdir( path.join( blockDir, 'lazy' ), {
				withFileTypes: true,
			} )
		)
			.filter( ( d ) => d.isFile() && d.name.endsWith( '.js' ) )
			.map( ( d ) => d.name )
			.sort();
	} catch ( err ) {
		if ( 'ENOENT' === err.code ) {
			return [];
		}
		throw err;
	}
}

/**
 * Build (or watch) a plugin's blocks by the `wp-scripts build` block.json
 * convention: each `<srcDir>/<slug>/` holding a `block.json` builds into
 * `<outDir>/<slug>/`.
 *
 * Per block, `index.js` (the editor) and `view.js` (the front end, when there
 * is one) build as `buildDashboards()` entries. The editor entry splits each
 * `style.scss` it reaches into `style-index.css`; the view entry folds every
 * stylesheet into `view.css`, so a `style.scss` reached through a dynamic
 * `import()`, which esbuild inlines, still loads with the view's
 * `viewStyle`. Each `<slug>/lazy/<name>.js` builds as an entry of its own
 * into `<slug>/lazy/`, with no style split, for code a block loads only on
 * demand: the build does not rewrite an `import()`, so the block loads its
 * lazy bundle by URL itself, and the bundle's `.asset.php` names the handles
 * it needs enqueued. `block.json`, and `render.php` when there is one, are
 * copied, because WordPress reads both from the build when it registers and
 * renders the block. Copies and the manifest are made once, so a watch build
 * rebuilds the bundles and stylesheets alone.
 *
 * @param {Object}                opts
 * @param {Object}                opts.esbuild     The consumer's esbuild module (default import).
 * @param {Object}                opts.sass        The consumer's sass module (namespace import).
 * @param {Object}                opts.rtlcss      The consumer's rtlcss module (default import).
 * @param {string}                opts.root        Absolute ROOT dir of the consumer plugin, which log lines name paths from.
 * @param {string}                opts.srcDir      Absolute directory holding one subdirectory per block.
 * @param {string}                opts.outDir      Absolute directory each block builds a subdirectory of.
 * @param {string}                [opts.manifest]  Absolute path to write the blocks manifest to; none is written without it.
 * @param {Object<string,string>} opts.alias       esbuild alias map, as `alias-map.cjs` projects it from the substrate `src`.
 * @param {string[]}              [opts.nodePaths] esbuild resolve nodePaths.
 * @param {boolean}               [opts.watch]     Stay alive rebuilding on change.
 * @param {string}                [opts.logLevel]  esbuild log level.
 * @return {Promise<void>} Resolves once every block is built and the manifest
 *         written, or, in watch mode, once every watcher is running.
 */
export async function buildBlocks( {
	esbuild,
	sass,
	rtlcss,
	root,
	srcDir,
	outDir,
	manifest,
	alias,
	nodePaths,
	watch,
	logLevel,
} ) {
	const blocks = await discoverBlocks( srcDir );
	const entries = [];
	for ( const block of blocks ) {
		const blockOut = path.join( outDir, block.slug );
		await mkdir( blockOut, { recursive: true } );
		await copyFile(
			path.join( block.dir, 'block.json' ),
			path.join( blockOut, 'block.json' )
		);
		await copyIfPresent(
			path.join( block.dir, 'render.php' ),
			path.join( blockOut, 'render.php' )
		);
		entries.push( {
			entry: path.relative( root, path.join( block.dir, 'index.js' ) ),
			outDir: blockOut,
			splitStyle: true,
		} );
		const view = path.join( block.dir, 'view.js' );
		if ( existsSync( view ) ) {
			entries.push( {
				entry: path.relative( root, view ),
				outDir: blockOut,
			} );
		}
		for ( const file of await lazyScripts( block.dir ) ) {
			entries.push( {
				entry: path.relative(
					root,
					path.join( block.dir, 'lazy', file )
				),
				outDir: path.join( blockOut, 'lazy' ),
			} );
		}
	}
	await buildDashboards( {
		esbuild,
		sass,
		rtlcss,
		root,
		entries,
		alias,
		nodePaths,
		watch,
		logLevel,
	} );
	if ( manifest ) {
		await mkdir( path.dirname( manifest ), { recursive: true } );
		await writeFile( manifest, blocksManifest( blocks ) );
		console.log(
			`✓ ${ path.relative( root, manifest ) } (${ blocks.length } block${
				1 === blocks.length ? '' : 's'
			})`
		);
	}
}
