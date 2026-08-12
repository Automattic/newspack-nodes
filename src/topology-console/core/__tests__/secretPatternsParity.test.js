/**
 * Pins the browser's redaction vocabulary to PHP's. `Core::SECRET_NAME_PATTERNS`
 * decides what `dump_node()` masks server-side and `Node::REDACTED` is the
 * marker it writes; the runtime mirrors both, for the drop audit and for what
 * the REPL echoes into localStorage. Adding `bearer` on the PHP side while this
 * list stands still leaves the browser storing it in cleartext, and each side
 * stays internally consistent — so only a cross-language pin catches it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { SECRET_NAME_PATTERNS } from '../../../runtime/core';
import { REDACTED } from '../../../runtime/node';

const INCLUDES = path.resolve( __dirname, '../../../../includes' );

function phpPatterns() {
	const source = fs.readFileSync(
		path.join( INCLUDES, 'class-core.php' ),
		'utf8'
	);
	const list = source.match(
		/const SECRET_NAME_PATTERNS\s*=\s*\[([^\]]*)\]/
	);
	expect( list ).not.toBeNull();
	return Array.from( list[ 1 ].matchAll( /'([^']+)'/g ), ( m ) => m[ 1 ] );
}

function phpRedacted() {
	const source = fs.readFileSync(
		path.join( INCLUDES, 'class-node.php' ),
		'utf8'
	);
	const marker = source.match( /const REDACTED\s*=\s*'([^']*)'/ );
	expect( marker ).not.toBeNull();
	return marker[ 1 ];
}

describe( 'secret redaction PHP parity', () => {
	it( 'matches Core::SECRET_NAME_PATTERNS exactly, in order', () => {
		expect( SECRET_NAME_PATTERNS ).toEqual( phpPatterns() );
	} );

	it( 'uses the same marker as Node::REDACTED', () => {
		expect( REDACTED ).toBe( phpRedacted() );
	} );
} );
