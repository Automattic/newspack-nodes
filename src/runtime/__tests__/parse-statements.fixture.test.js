/**
 * Cross-language golden pin (JS side). The statement-list fixtures under
 * tests/fixtures/statements/*.json were generated ONCE from PHP
 * Shell_Node::parse_statements(); the PHP StatementFrontEndParityTest asserts
 * PHP still reproduces them, and this asserts JS parseStatements() reproduces
 * the identical JSON from the identical .tsl input. Drift in either tokenizer
 * or front-end that isn't mirrored fails one side immediately.
 */

import fs from 'fs';
import path from 'path';
import { parseStatements } from '../shell-node';

const ROOT = path.join( __dirname, '../../..' );
const STATEMENTS_DIR = path.join( ROOT, 'tests/fixtures/statements' );

// Fixture name → the .tsl the PHP harness drove through parse_statements().
const TSL_SOURCES = {
	'eln-aggregator': 'tests/fixtures/eln-aggregator.tsl',
	'eln-combined': 'tests/fixtures/eln-combined.tsl',
	'eln-flame-builder': 'tests/fixtures/eln-flame-builder.tsl',
	'eln-hub-control': 'tests/fixtures/eln-hub-control.tsl',
	'eln-job-router': 'tests/fixtures/eln-job-router.tsl',
	'eln-performance': 'tests/fixtures/eln-performance.tsl',
	'eln-request-builder': 'tests/fixtures/eln-request-builder.tsl',
	'example-ai-newsletter':
		'examples/example-ai-newsletter/topologies/example-ai-newsletter.tsl',
	'hub-control': 'topologies/hub-control.tsl',
	'job-intake': 'topologies/job-intake.tsl',
	'job-worker': 'topologies/job-worker.tsl',
	'request-builder': 'tests/fixtures/request-builder.tsl',
	'topic-probe': 'topologies/topic-probe.tsl',
};

describe( 'parseStatements — PHP-generated fixture parity', () => {
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
