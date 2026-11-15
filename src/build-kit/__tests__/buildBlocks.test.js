/* @jest-environment node */
// Node env (not jsdom): esbuild won't run under jsdom.

const fs = require( 'node:fs/promises' );
const os = require( 'node:os' );
const path = require( 'node:path' );
const { createHash } = require( 'node:crypto' );

const FIXTURES = path.join( __dirname, 'fixtures/blocks' );

/**
 * Load the kit and the three tools a consumer injects.
 *
 * @return {Promise<Object>} `{ kit, esbuild, sass, rtlcss }`.
 */
async function tools() {
	return {
		kit: await import( '../index.mjs' ),
		esbuild: ( await import( 'esbuild' ) ).default,
		sass: await import( 'sass' ),
		rtlcss: ( await import( 'rtlcss' ) ).default,
	};
}

/**
 * Every file under a directory, relative to it, sorted.
 *
 * @param {string} dir Absolute directory.
 * @return {Promise<string[]>} The relative paths.
 */
async function filesUnder( dir ) {
	const all = await fs.readdir( dir, {
		recursive: true,
		withFileTypes: true,
	} );
	return all
		.filter( ( d ) => d.isFile() )
		.map( ( d ) => path.relative( dir, path.join( d.parentPath, d.name ) ) )
		.sort();
}

/**
 * The dependency list an `.asset.php` declares.
 *
 * @param {string} php The file's source.
 * @return {string[]} The handles, in file order.
 */
function depsOf( php ) {
	const list = php.match( /'dependencies' => array\(([^)]*)\)/ )[ 1 ];
	return [ ...list.matchAll( /'([^']+)'/g ) ].map( ( m ) => m[ 1 ] );
}

describe( 'buildBlocks (integration, real esbuild)', () => {
	let kit;
	let root;
	let outDir;
	let manifest;

	const read = ( rel ) => fs.readFile( path.join( outDir, rel ), 'utf8' );

	beforeAll( async () => {
		const t = await tools();
		kit = t.kit;
		root = await fs.mkdtemp( path.join( os.tmpdir(), 'buildkit-blocks-' ) );
		outDir = path.join( root, 'out/blocks' );
		manifest = path.join( root, 'out/kea-manifest.php' );
		await kit.buildBlocks( {
			esbuild: t.esbuild,
			sass: t.sass,
			rtlcss: t.rtlcss,
			root,
			srcDir: FIXTURES,
			outDir,
			manifest,
			alias: {},
		} );
	}, 30000 );

	afterAll( async () => {
		await fs.rm( root, { recursive: true, force: true } );
	} );

	test( 'builds one directory per block.json and skips a directory without one', async () => {
		expect( ( await fs.readdir( outDir ) ).sort() ).toEqual( [
			'kea-card',
			'wren-note',
		] );
	} );

	test( 'a block with an editor, a view, styles and a render emits the wp-scripts file set', async () => {
		expect( await filesUnder( path.join( outDir, 'kea-card' ) ) ).toEqual( [
			'block.json',
			'index-rtl.css',
			'index.asset.php',
			'index.css',
			'index.js',
			'lazy/kea-panel-rtl.css',
			'lazy/kea-panel.asset.php',
			'lazy/kea-panel.css',
			'lazy/kea-panel.js',
			'render.php',
			'style-index-rtl.css',
			'style-index.css',
			'view-rtl.css',
			'view.asset.php',
			'view.css',
			'view.js',
		] );
	} );

	test( 'a block importing only style.scss emits no editor stylesheet', async () => {
		expect( await filesUnder( path.join( outDir, 'wren-note' ) ) ).toEqual(
			[
				'block.json',
				'index.asset.php',
				'index.js',
				'style-index-rtl.css',
				'style-index.css',
			]
		);
	} );

	test( 'the editor asset.php names the handles its imports reach', async () => {
		expect( depsOf( await read( 'kea-card/index.asset.php' ) ) ).toEqual( [
			'react-jsx-runtime',
			'wp-blocks',
			'wp-components',
			'wp-i18n',
		] );
	} );

	test( 'the view asset.php names the wp-api-fetch handle', async () => {
		expect( depsOf( await read( 'kea-card/view.asset.php' ) ) ).toEqual( [
			'wp-api-fetch',
		] );
	} );

	test( 'the asset.php version hashes the emitted bundle', async () => {
		const js = await fs.readFile(
			path.join( outDir, 'kea-card/index.js' )
		);
		const version = createHash( 'sha256' )
			.update( js )
			.digest( 'hex' )
			.slice( 0, 20 );
		expect( await read( 'kea-card/index.asset.php' ) ).toContain(
			`'version' => '${ version }'`
		);
	} );

	test( 'WordPress packages are read from their globals, not bundled', async () => {
		const js = await read( 'kea-card/index.js' );
		expect( js ).toContain( 'window.wp.components' );
		expect( js ).toContain( 'Kea card 4417' );
		expect( await read( 'kea-card/view.js' ) ).toContain(
			'window.wp.apiFetch'
		);
	} );

	test( 'style.scss splits into style-index.css and stays out of index.css', async () => {
		const editor = await read( 'kea-card/index.css' );
		const front = await read( 'kea-card/style-index.css' );
		expect( editor ).toContain( '.kea-editor-6271' );
		expect( editor ).not.toContain( '.kea-front-8803' );
		expect( front ).toContain( '.kea-front-8803' );
		expect( front ).not.toContain( '.kea-editor-6271' );
	} );

	test( 'each stylesheet has an rtlcss companion', async () => {
		expect( await read( 'kea-card/index-rtl.css' ) ).toMatch(
			/margin-right:\s*11px/
		);
		expect( await read( 'kea-card/style-index-rtl.css' ) ).toMatch(
			/padding-right:\s*17px/
		);
		expect( await read( 'kea-card/view-rtl.css' ) ).toMatch(
			/border-right:\s*3px solid/
		);
		expect( await read( 'wren-note/style-index-rtl.css' ) ).toMatch(
			/margin-left:\s*23px/
		);
	} );

	test( 'a lazy bundle builds on its own, with its stylesheet and handles', async () => {
		expect( await read( 'kea-card/lazy/kea-panel.js' ) ).toContain(
			'kea-panel-7419'
		);
		expect( await read( 'kea-card/lazy/kea-panel.css' ) ).toContain(
			'.kea-panel-2264'
		);
		expect( await read( 'kea-card/lazy/kea-panel-rtl.css' ) ).toMatch(
			/margin-right:\s*29px/
		);
		expect(
			depsOf( await read( 'kea-card/lazy/kea-panel.asset.php' ) )
		).toEqual( [ 'wp-element' ] );
	} );

	test( 'the view bundle carries none of the lazy module', async () => {
		const view = await read( 'kea-card/view.js' );
		expect( view ).toContain( 'lazy/kea-panel.js' );
		expect( view ).not.toContain( 'kea-panel-7419' );
		expect( await read( 'kea-card/view.css' ) ).not.toContain(
			'.kea-panel-2264'
		);
	} );

	test( 'a style.scss the view reaches folds into view.css', async () => {
		const view = await read( 'kea-card/view.css' );
		expect( view ).toContain( '.kea-chat-5512' );
		expect( await read( 'kea-card/style-index.css' ) ).not.toContain(
			'.kea-chat-5512'
		);
	} );

	test( 'the view stylesheet carries the view SCSS alone', async () => {
		const view = await read( 'kea-card/view.css' );
		expect( view ).toContain( '.kea-view-3319' );
		expect( view ).not.toContain( '.kea-front-8803' );
		expect( view ).not.toContain( '.kea-editor-6271' );
	} );

	test( 'block.json and render.php are copied byte for byte', async () => {
		for ( const file of [ 'block.json', 'render.php' ] ) {
			expect( await read( `kea-card/${ file }` ) ).toBe(
				await fs.readFile(
					path.join( FIXTURES, 'kea-card', file ),
					'utf8'
				)
			);
		}
	} );

	test( 'the manifest exports every block.json, keyed by slug, in slug order', async () => {
		const expected = [
			'<?php',
			'// This file is generated. Do not modify it manually.',
			'return array(',
			"\t'kea-card' => array(",
			"\t\t'$schema' => 'https://schemas.wp.org/trunk/block.json',",
			"\t\t'apiVersion' => 3,",
			"\t\t'name' => 'fixture/kea-card',",
			"\t\t'title' => 'Kea\\'s \"Card\"',",
			"\t\t'category' => 'widgets',",
			"\t\t'supports' => array(",
			"\t\t\t'html' => false",
			'\t\t),',
			"\t\t'keywords' => array(",
			'\t\t\t',
			'\t\t),',
			"\t\t'editorScript' => 'file:./index.js',",
			"\t\t'editorStyle' => 'file:./index.css',",
			"\t\t'style' => 'file:./style-index.css',",
			"\t\t'viewScript' => 'file:./view.js',",
			"\t\t'viewStyle' => 'file:./view.css',",
			"\t\t'render' => 'file:./render.php'",
			'\t),',
			"\t'wren-note' => array(",
			"\t\t'apiVersion' => 3,",
			"\t\t'name' => 'fixture/wren-note',",
			"\t\t'title' => 'Wren note',",
			"\t\t'editorScript' => 'file:./index.js',",
			"\t\t'style' => 'file:./style-index.css'",
			'\t)',
			');',
			'',
		].join( '\n' );
		expect( await fs.readFile( manifest, 'utf8' ) ).toBe( expected );
	} );
} );

describe( 'buildBlocks edges', () => {
	let root;

	beforeEach( async () => {
		root = await fs.mkdtemp( path.join( os.tmpdir(), 'buildkit-edge-' ) );
	} );

	afterEach( async () => {
		await fs.rm( root, { recursive: true, force: true } );
	} );

	test( 'fails fast on a dead alias path, before esbuild', async () => {
		const { kit } = await tools();
		await expect(
			kit.buildBlocks( {
				esbuild: {},
				sass: {},
				rtlcss: {},
				root,
				srcDir: FIXTURES,
				outDir: path.join( root, 'out' ),
				alias: { '@newspack-nodes/shared': '/nonexistent-6640' },
			} )
		).rejects.toThrow( /NEWSPACK_NODES_SRC/ );
	} );

	test( 'a malformed block.json fails the build', async () => {
		const { kit, esbuild, sass, rtlcss } = await tools();
		const srcDir = path.join( root, 'src' );
		await fs.mkdir( path.join( srcDir, 'moa-broken' ), {
			recursive: true,
		} );
		await fs.writeFile(
			path.join( srcDir, 'moa-broken/block.json' ),
			'{ "name": '
		);
		await expect(
			kit.buildBlocks( {
				esbuild,
				sass,
				rtlcss,
				root,
				srcDir,
				outDir: path.join( root, 'out' ),
				alias: {},
			} )
		).rejects.toThrow( SyntaxError );
	} );

	test( 'a missing source directory builds no blocks and an empty manifest', async () => {
		const { kit, esbuild, sass, rtlcss } = await tools();
		const manifest = path.join( root, 'takahe-manifest.php' );
		await kit.buildBlocks( {
			esbuild,
			sass,
			rtlcss,
			root,
			srcDir: path.join( root, 'no-blocks-3381' ),
			outDir: path.join( root, 'out' ),
			manifest,
			alias: {},
		} );
		expect( await fs.readFile( manifest, 'utf8' ) ).toBe(
			'<?php\n// This file is generated. Do not modify it manually.\nreturn array(\n\n);\n'
		);
	} );

	test( 'no manifest is written unless one is named', async () => {
		const { kit, esbuild, sass, rtlcss } = await tools();
		const outDir = path.join( root, 'out' );
		await kit.buildBlocks( {
			esbuild,
			sass,
			rtlcss,
			root,
			srcDir: FIXTURES,
			outDir,
			alias: {},
		} );
		expect( ( await fs.readdir( root ) ).sort() ).toEqual( [ 'out' ] );
		expect( ( await fs.readdir( outDir ) ).sort() ).toEqual( [
			'kea-card',
			'wren-note',
		] );
	}, 30000 );

	test( 'a rebuild that drops the style.scss import removes style-index.css', async () => {
		const { kit, esbuild, sass, rtlcss } = await tools();
		const srcDir = path.join( root, 'src' );
		await fs.cp( FIXTURES, srcDir, { recursive: true } );
		const outDir = path.join( root, 'out' );
		const contexts = [];
		const capturing = {
			context: async ( opts ) => {
				const ctx = await esbuild.context( opts );
				contexts.push( ctx );
				return {
					rebuild: () => ctx.rebuild(),
					dispose: async () => {},
				};
			},
		};
		try {
			await kit.buildBlocks( {
				esbuild: capturing,
				sass,
				rtlcss,
				root,
				srcDir,
				outDir,
				alias: {},
			} );
			const wren = path.join( outDir, 'wren-note' );
			expect( await filesUnder( wren ) ).toContain( 'style-index.css' );

			await fs.writeFile(
				path.join( srcDir, 'wren-note/index.js' ),
				"import { registerBlockType } from '@wordpress/blocks';\nregisterBlockType( 'fixture/wren-note', {} );\n"
			);
			await Promise.all( contexts.map( ( c ) => c.rebuild() ) );

			expect( await filesUnder( wren ) ).toEqual( [
				'block.json',
				'index.asset.php',
				'index.js',
			] );
		} finally {
			await Promise.all( contexts.map( ( c ) => c.dispose() ) );
		}
	}, 30000 );
} );
