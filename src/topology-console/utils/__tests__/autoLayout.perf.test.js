/**
 * Perf regression for the topology-console layout on the large `test.tsl`
 * topology (3145 nodes, 3200 edges). Pins autoLayout to a time budget.
 */
import fs from 'fs';
import path from 'path';
import { autoLayout } from '../autoLayout';
import { parseTsl } from '../parseTsl';

const BUDGET_MS = 4000;

const fixture = () =>
	parseTsl(
		fs.readFileSync(
			path.join( __dirname, 'fixtures', 'test.tsl' ),
			'utf8'
		)
	);

describe( 'topology-console layout — large topology perf (test.tsl)', () => {
	it( 'autoLayout (no-overrides path) lays out 3145 nodes well under budget', () => {
		const parsed = fixture();
		const start = Date.now();
		const out = autoLayout( parsed );
		const elapsed = Date.now() - start;
		// eslint-disable-next-line no-console
		console.log(
			`[autoLayout] ${ parsed.nodes.length } nodes ${ elapsed }ms`
		);
		expect( out.nodes ).toHaveLength( parsed.nodes.length );
		expect( elapsed ).toBeLessThan( BUDGET_MS );
	}, 120000 );
} );
