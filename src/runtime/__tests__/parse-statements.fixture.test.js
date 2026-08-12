/**
 * Cross-language golden pin (JS side). The statement-list fixtures under
 * tests/fixtures/statements/*.json were generated ONCE from PHP
 * Shell_Node::parse_statements(); the PHP StatementFrontEndParityTest asserts
 * PHP still reproduces them, and this asserts JS parseStatements() reproduces
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

const namesIn = ( dir, ext ) =>
	fs
		.readdirSync( path.join( ROOT, dir ) )
		.filter( ( file ) => file.endsWith( ext ) )
		.map( ( file ) => path.basename( file, ext ) );

// Fixture name → the .tsl the PHP harness drove through parse_statements().
const TSL_SOURCES = Object.fromEntries(
	TSL_DIRS.flatMap( ( dir ) =>
		namesIn( dir, '.tsl' ).map( ( name ) => [
			name,
			path.join( dir, `${ name }.tsl` ),
		] )
	)
);

const GOLDEN_NAMES = namesIn( 'tests/fixtures/statements', '.json' ).sort();

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
			expect( parseStatements( tsl ) ).toEqual( expected );
		}
	);
} );
