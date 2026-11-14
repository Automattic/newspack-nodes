/**
 * The shell's scrolling region is named in a leaf module, so a block that
 * measures against it imports the name without bundling the shell.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PAGE_CONTENT_CLASS } from '../pageContent';
import { PAGE_CONTENT_CLASS as shellClass } from '../DashboardShell';

describe( 'pageContent', () => {
	test( 'names the region the shell renders, and the shell hands on the same name', () => {
		expect( PAGE_CONTENT_CLASS ).toBe( 'newspack-nodes-page-content' );
		expect( shellClass ).toBe( PAGE_CONTENT_CLASS );
	} );

	test( 'imports nothing, so a consumer bundles one string', () => {
		const source = readFileSync(
			path.resolve( __dirname, '../pageContent.js' ),
			'utf8'
		);
		expect( source ).not.toMatch( /^\s*import\b/m );
	} );
} );
