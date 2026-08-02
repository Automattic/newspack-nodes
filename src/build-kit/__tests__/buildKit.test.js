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
