/* @jest-environment node */
// Node env (not jsdom): esbuild won't run under jsdom; tests pure exports.

describe( 'build-kit pure exports', () => {
	let kit;

	beforeAll( async () => {
		kit = await import( '../index.mjs' );
	} );

	test( 'WP_EXTERNALS maps @wordpress/element to the wp-element handle', () => {
		expect( kit.WP_EXTERNALS[ '@wordpress/element' ] ).toEqual( {
			global: 'window.wp.element',
			handle: 'wp-element',
		} );
	} );

	test( 'WP_EXTERNALS maps react/jsx-runtime to the jsx-runtime global', () => {
		expect( kit.WP_EXTERNALS[ 'react/jsx-runtime' ] ).toEqual( {
			global: 'window.ReactJSXRuntime',
			handle: 'react-jsx-runtime',
		} );
	} );

	test( 'WP_EXTERNALS maps @wordpress/blocks to the wp-blocks handle', () => {
		expect( kit.WP_EXTERNALS[ '@wordpress/blocks' ] ).toEqual( {
			global: 'window.wp.blocks',
			handle: 'wp-blocks',
		} );
	} );

	test( 'WP_EXTERNALS maps @wordpress/block-library to the wp-block-library handle', () => {
		expect( kit.WP_EXTERNALS[ '@wordpress/block-library' ] ).toEqual( {
			global: 'window.wp.blockLibrary',
			handle: 'wp-block-library',
		} );
	} );

	test( 'emitAssetPhp emits a sorted, deduped, quoted dependency manifest', () => {
		const php = kit.emitAssetPhp(
			new Set( [ 'wp-element', 'wp-api-fetch', 'wp-element' ] ),
			'abc123'
		);
		expect( php ).toBe(
			"<?php return array('dependencies' => array('wp-api-fetch', 'wp-element'), 'version' => 'abc123');\n"
		);
	} );

	test( 'emitAssetPhp emits an empty dependency array when nothing was used', () => {
		expect( kit.emitAssetPhp( new Set(), 'deadbeef' ) ).toBe(
			"<?php return array('dependencies' => array(), 'version' => 'deadbeef');\n"
		);
	} );

	test( 'buildDashboards is an exported function', () => {
		expect( typeof kit.buildDashboards ).toBe( 'function' );
	} );

	// The hint names the ONE knob. It used to synthesize a per-alias variable
	// name — all four of which assertNoRetiredOverrides now refuses, so the
	// message sent the operator into a second, different failure.
	test( 'assertAliasPathsExist names the missing alias and NEWSPACK_NODES_SRC', () => {
		expect( () =>
			kit.assertAliasPathsExist( {
				'@newspack-nodes/debug-overlay':
					'/nonexistent-9317/DebugOverlay.js',
			} )
		).toThrow( /@newspack-nodes\/debug-overlay.*NEWSPACK_NODES_SRC/s );
	} );

	test( 'assertAliasPathsExist passes a real path silently', () => {
		expect( () =>
			kit.assertAliasPathsExist( { '@newspack-nodes/shared': __dirname } )
		).not.toThrow();
	} );

	test( 'buildDashboards fails fast on a dead alias path, before esbuild', async () => {
		await expect(
			kit.buildDashboards( {
				esbuild: {},
				sass: {},
				rtlcss: {},
				root: '/tmp',
				entries: [],
				alias: { '@newspack-nodes/shared': '/nonexistent-4482' },
			} )
		).rejects.toThrow( /NEWSPACK_NODES_SRC/ );
	} );

	test( 'substrateVersion reads the substrate package.json version', () => {
		// eslint-disable-next-line import/no-relative-packages
		const pkg = require( '../../../package.json' );
		expect( kit.substrateVersion() ).toBe( pkg.version );
	} );
} );

// Integration: drive buildDashboards end-to-end with real esbuild/sass/rtlcss.
describe( 'buildDashboards (integration, real esbuild)', () => {
	const fs = require( 'node:fs/promises' );
	const os = require( 'node:os' );
	const path = require( 'node:path' );

	let kit;
	let esbuild;
	let sass;
	let rtlcss;
	let root;
	let outDir;

	beforeAll( async () => {
		kit = await import( '../index.mjs' );
		esbuild = ( await import( 'esbuild' ) ).default;
		sass = await import( 'sass' );
		rtlcss = ( await import( 'rtlcss' ) ).default;

		root = await fs.mkdtemp( path.join( os.tmpdir(), 'buildkit-it-' ) );
		outDir = path.join( root, 'build/widget' );
		// Fixture entry: externalized WP package + a stylesheet (CSS+RTL).
		await fs.writeFile(
			path.join( root, 'style.scss' ),
			'.box { margin-left: 4px; }'
		);
		await fs.writeFile(
			path.join( root, 'entry.js' ),
			"import { createElement } from '@wordpress/element';\nimport './style.scss';\nexport const x = createElement;\n"
		);

		await kit.buildDashboards( {
			esbuild,
			sass,
			rtlcss,
			root,
			entries: [ { entry: 'entry.js', outDir } ],
			alias: {},
		} );
	}, 30000 );

	afterAll( async () => {
		await fs.rm( root, { recursive: true, force: true } );
	} );

	test( 'emits the base-named bundle (entry.js → entry.js, not index.js)', async () => {
		const js = await fs.readFile( path.join( outDir, 'entry.js' ), 'utf8' );
		expect( js.length ).toBeGreaterThan( 0 );
	} );

	test( 'bundle opens with the substrate semver banner', async () => {
		const js = await fs.readFile( path.join( outDir, 'entry.js' ), 'utf8' );
		expect(
			js.startsWith( `/* @newspack-nodes ${ kit.substrateVersion() } */` )
		).toBe( true );
	} );

	test( 'asset.php manifest lists the externalized WP handle + a version', async () => {
		const asset = await fs.readFile(
			path.join( outDir, 'entry.asset.php' ),
			'utf8'
		);
		expect( asset ).toContain( "'wp-element'" );
		expect( asset ).toMatch( /'version' => '[0-9a-f]{20}'/ );
	} );

	test( 'emits the CSS and its rtlcss companion', async () => {
		const css = await fs.readFile(
			path.join( outDir, 'entry.css' ),
			'utf8'
		);
		expect( css ).toContain( 'margin-left' );
		// rtlcss flips margin-left → margin-right.
		const rtl = await fs.readFile(
			path.join( outDir, 'entry-rtl.css' ),
			'utf8'
		);
		expect( rtl ).toContain( 'margin-right' );
	} );
} );

// The Sass alias importer must hand Sass a file URL, not a hand-built string.
describe( 'buildDashboards Sass alias with URL-special path characters', () => {
	const fs = require( 'node:fs/promises' );
	const os = require( 'node:os' );
	const path = require( 'node:path' );

	let root;

	afterEach( async () => {
		await fs.rm( root, { recursive: true, force: true } );
	} );

	test( 'resolves an aliased @use under a dir holding #, % and a space', async () => {
		const kit = await import( '../index.mjs' );
		const esbuild = ( await import( 'esbuild' ) ).default;
		const sass = await import( 'sass' );
		const rtlcss = ( await import( 'rtlcss' ) ).default;

		root = await fs.mkdtemp( path.join( os.tmpdir(), 'buildkit-url-' ) );
		const shared = path.join( root, 'shared #7 50% dir' );
		await fs.mkdir( path.join( shared, 'styles' ), { recursive: true } );
		await fs.writeFile(
			path.join( shared, 'styles', '_marker.scss' ),
			'.marker-from-alias { padding-left: 13px; }'
		);
		await fs.writeFile(
			path.join( root, 'style.scss' ),
			"@use '@fixture-alias/styles/marker';"
		);
		await fs.writeFile(
			path.join( root, 'entry.js' ),
			"import './style.scss';\nexport const y = 1;\n"
		);
		const outDir = path.join( root, 'build/aliased' );

		await kit.buildDashboards( {
			esbuild,
			sass,
			rtlcss,
			root,
			entries: [ { entry: 'entry.js', outDir } ],
			alias: { '@fixture-alias': shared },
		} );

		const css = await fs.readFile(
			path.join( outDir, 'entry.css' ),
			'utf8'
		);
		expect( css ).toContain( '.marker-from-alias' );
		expect( css ).toContain( '13px' );
	}, 30000 );
} );

// A watch build rebuilds the SAME context; holding dispose back models that.
describe( 'buildDashboards rebuild (integration, real esbuild)', () => {
	const fs = require( 'node:fs/promises' );
	const os = require( 'node:os' );
	const path = require( 'node:path' );

	let kit;
	let esbuild;
	let sass;
	let rtlcss;
	let root;
	let outDir;
	let contexts;

	const writeEntry = ( lines ) =>
		fs.writeFile( path.join( root, 'entry.js' ), lines.join( '\n' ) );
	const exists = ( file ) =>
		fs.access( path.join( outDir, file ) ).then(
			() => true,
			() => false
		);
	const rebuild = () => Promise.all( contexts.map( ( c ) => c.rebuild() ) );

	beforeAll( async () => {
		kit = await import( '../index.mjs' );
		esbuild = ( await import( 'esbuild' ) ).default;
		sass = await import( 'sass' );
		rtlcss = ( await import( 'rtlcss' ) ).default;

		root = await fs.mkdtemp( path.join( os.tmpdir(), 'buildkit-re-' ) );
		outDir = path.join( root, 'build/rewidget' );
		await fs.writeFile(
			path.join( root, 'style.scss' ),
			'.box-6113 { padding-left: 7px; }'
		);
		await writeEntry( [
			"import { createElement } from '@wordpress/element';",
			"import { __ } from '@wordpress/i18n';",
			"import './style.scss';",
			'export const x = [ createElement, __ ];',
		] );

		contexts = [];
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
		await kit.buildDashboards( {
			esbuild: capturing,
			sass,
			rtlcss,
			root,
			entries: [ { entry: 'entry.js', outDir } ],
			alias: {},
		} );
	}, 30000 );

	afterAll( async () => {
		await Promise.all( contexts.map( ( c ) => c.dispose() ) );
		await fs.rm( root, { recursive: true, force: true } );
	} );

	test( 'the first build emits both stylesheets and both handles', async () => {
		expect( await exists( 'entry.css' ) ).toBe( true );
		expect( await exists( 'entry-rtl.css' ) ).toBe( true );
		const asset = await fs.readFile(
			path.join( outDir, 'entry.asset.php' ),
			'utf8'
		);
		expect( asset ).toContain( "'wp-i18n'" );
	} );

	test( 'a rebuild drops the handle of an import the entry removed', async () => {
		await writeEntry( [
			"import { createElement } from '@wordpress/element';",
			"import './style.scss';",
			'export const x = createElement;',
		] );
		await rebuild();
		const asset = await fs.readFile(
			path.join( outDir, 'entry.asset.php' ),
			'utf8'
		);
		expect( asset ).toContain( "'wp-element'" );
		expect( asset ).not.toContain( "'wp-i18n'" );
	} );

	test( 'a rebuild with no stylesheet left removes both CSS files', async () => {
		await writeEntry( [
			"import { createElement } from '@wordpress/element';",
			'export const x = createElement;',
		] );
		await rebuild();
		expect( await exists( 'entry.js' ) ).toBe( true );
		expect( await exists( 'entry.css' ) ).toBe( false );
		expect( await exists( 'entry-rtl.css' ) ).toBe( false );
	} );
} );
