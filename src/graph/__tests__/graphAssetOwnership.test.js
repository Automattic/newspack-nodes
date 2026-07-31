/* @jest-environment node */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// postcss-scss declares PostCSS as a required peer; this integration parses
// freshly emitted CSS artifacts.
// eslint-disable-next-line import/no-extraneous-dependencies
import postcss from 'postcss';

const ROOT = path.resolve( __dirname, '../../..' );
const BUILD_SCRIPT = path.join( ROOT, 'scripts/build.mjs' );

const normalize = ( value ) => value.replace( /\s+/g, ' ' ).trim();

const ruleSignatures = ( css, from ) => {
	const signatures = new Set();
	postcss.parse( css, { from } ).walkRules( ( rule ) => {
		const ancestors = [];
		let parent = rule.parent;
		while ( parent && 'root' !== parent.type ) {
			if ( 'atrule' === parent.type ) {
				ancestors.unshift( `@${ parent.name } ${ parent.params }` );
			}
			parent = parent.parent;
		}
		const body = ( rule.nodes || [] )
			.filter( ( node ) => 'decl' === node.type )
			.map(
				( declaration ) =>
					`${ declaration.prop }:${ normalize( declaration.value ) }${
						declaration.important ? '!important' : ''
					}`
			)
			.join( ';' );
		signatures.add(
			`${ ancestors.join( '/' ) }|${ normalize(
				rule.selector
			) }|${ body }`
		);
	} );
	return signatures;
};

it( 'delivers graph CSS only in the graph bundle after a fresh isolated build', async () => {
	const source = await fs.readFile( BUILD_SCRIPT, 'utf8' );
	const entryPaths = [ ...source.matchAll( /\bentry:\s*'([^']+)'/g ) ].map(
		( match ) => match[ 1 ]
	);
	expect( entryPaths ).toContain( 'src/graph/index.js' );
	expect( new Set( entryPaths ).size ).toBe( entryPaths.length );

	const outputRoot = await fs.mkdtemp(
		path.join( os.tmpdir(), 'nodes-graph-ownership-' )
	);
	const outputDirs = new Map(
		entryPaths.map( ( entry ) => [
			entry,
			path.join( outputRoot, path.basename( path.dirname( entry ) ) ),
		] )
	);
	const log = jest.spyOn( console, 'log' ).mockImplementation( () => {} );

	try {
		const kit = await import( '../../build-kit/index.mjs' );
		const esbuild = ( await import( 'esbuild' ) ).default;
		const sass = await import( 'sass' );
		const rtlcss = ( await import( 'rtlcss' ) ).default;
		await kit.buildDashboards( {
			esbuild,
			sass,
			rtlcss,
			root: ROOT,
			entries: entryPaths.map( ( entry ) => ( {
				entry,
				outDir: outputDirs.get( entry ),
			} ) ),
			alias: {
				'@newspack-nodes/runtime': path.join(
					ROOT,
					'src/runtime/index.js'
				),
				'@newspack-nodes/debug-overlay': path.join(
					ROOT,
					'src/debug-overlay/DebugOverlay.js'
				),
				'@newspack-nodes/shared': path.join( ROOT, 'src/shared' ),
			},
		} );

		const graphCssPath = path.join(
			outputDirs.get( 'src/graph/index.js' ),
			'index.css'
		);
		const graphRules = ruleSignatures(
			await fs.readFile( graphCssPath, 'utf8' ),
			graphCssPath
		);
		expect( graphRules.size ).toBeGreaterThan( 100 );

		const duplicates = [];
		for ( const entry of entryPaths ) {
			if ( 'src/graph/index.js' === entry ) {
				continue;
			}
			const cssPath = path.join( outputDirs.get( entry ), 'index.css' );
			try {
				const deliveredRules = ruleSignatures(
					await fs.readFile( cssPath, 'utf8' ),
					cssPath
				);
				for ( const signature of graphRules ) {
					if ( deliveredRules.has( signature ) ) {
						duplicates.push( `${ entry }:${ signature }` );
					}
				}
			} catch ( error ) {
				if ( 'ENOENT' !== error.code ) {
					throw error;
				}
			}
		}

		expect( duplicates ).toEqual( [] );
	} finally {
		log.mockRestore();
		await fs.rm( outputRoot, { recursive: true, force: true } );
	}
}, 30000 );
