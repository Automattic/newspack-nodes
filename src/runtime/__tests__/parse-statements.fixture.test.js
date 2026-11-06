/**
 * Cross-language golden pin (JS side). The statement-list fixtures under
 * tests/fixtures/statements/*.json are PHP Shell_Node::parse_statements()
 * output, committed; the PHP StatementFrontEndParityTest asserts PHP
 * reproduces them, and this asserts JS parseStatements() reproduces
 * the identical JSON from the identical .tsl input. Drift in either tokenizer
 * or front-end that isn't mirrored fails one side immediately.
 *
 * Sources are DISCOVERED from the same directories the PHP harness globs, and
 * the two sets are pinned against each other, so a fixture added on one side
 * cannot silently cover only one language: an unmatched golden and an
 * ungoldened source each fail here.
 */

import fs from 'fs';
import path from 'path';
import { parseStatements } from '../shell-node';

const ROOT = path.join( __dirname, '../../..' );
const STATEMENTS_DIR = path.join( ROOT, 'tests/fixtures/statements' );

// The .tsl trees StatementFrontEndParityTest::tsl_fixtures() globs.
const TSL_DIRS = [
	'topologies',
	'examples/example-ai-newsletter/topologies',
	'tests/fixtures',
];

// Fixture name → the .tsl or .tsl.php parse_statements() was driven through.
const TSL_SOURCES = Object.fromEntries(
	TSL_DIRS.flatMap( ( dir ) =>
		fs
			.readdirSync( path.join( ROOT, dir ) )
			.filter( ( file ) => /\.tsl(\.php)?$/.test( file ) )
			.map( ( file ) => [
				file.replace( /\.tsl(\.php)?$/, '' ),
				path.join( dir, file ),
			] )
	)
);

const GOLDEN_NAMES = fs
	.readdirSync( path.join( ROOT, 'tests/fixtures/statements' ) )
	.filter( ( file ) => file.endsWith( '.json' ) )
	.map( ( file ) => path.basename( file, '.json' ) )
	.sort();

// The pin is on what both front ends PARSE. A line NUMBER is diagnostic only,
// and pinning it would make every comment edit in a shipped .tsl a fixture
// regeneration — churn between an author and a comment, not a guarantee.
const withoutLines = ( statements ) =>
	statements.map( ( { line, ...rest } ) => rest );

describe( 'parseStatements — PHP-generated fixture parity', () => {
	it( 'covers every committed golden, and every golden has a source', () => {
		expect( Object.keys( TSL_SOURCES ).sort() ).toEqual( GOLDEN_NAMES );
	} );

	it.each( Object.entries( TSL_SOURCES ) )(
		'JS reproduces the committed statement list for %s',
		( name, tslRelPath ) => {
			const tsl = fs.readFileSync(
				path.join( ROOT, tslRelPath ),
				'utf8'
			);
			const expected = JSON.parse(
				fs.readFileSync(
					path.join( STATEMENTS_DIR, `${ name }.json` ),
					'utf8'
				)
			);
			expect( withoutLines( parseStatements( tsl ) ) ).toEqual(
				withoutLines( expected )
			);
		}
	);
} );
