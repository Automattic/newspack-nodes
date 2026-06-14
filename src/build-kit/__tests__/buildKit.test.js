/* @jest-environment node */
// Runs in the node env (not jsdom): the integration test drives the real
// esbuild, which refuses to run under jsdom's patched Buffer/Uint8Array. None
// of these tests touch the DOM.
//
// Tests the pure pieces of the shared esbuild build-kit. The kit is ESM
// (.mjs) build tooling injected with esbuild/sass/rtlcss; here we only
// exercise the dependency-free exports, so a dynamic import is enough.

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
} );

// Integration: drive buildDashboards end-to-end with the REAL esbuild/sass/
// rtlcss (the injected deps) over a throwaway fixture entry, and assert the
// emitted artifacts. This exercises the load-bearing core the smoke test above
// can't: the DI threading, the alias/outfile wiring, wpExternalsPlugin handle
// collection, scssPlugin(sass), and postBuildPlugin's asset.php + RTL emission.
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
		// A fixture entry that pulls in an externalized WP package (so a handle
		// is recorded) AND a stylesheet (so CSS + RTL are emitted).
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
