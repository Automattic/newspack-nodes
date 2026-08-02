/**
 * The whole-tree guard behind `commandMintHygiene.test.js`.
 *
 * That file pins the minters it names. This one pins the SET of places that
 * stamp `ID` or `KEY` at all, so a new correlation site cannot appear without
 * someone editing this list and reading why it exists.
 *
 * Legitimate stamps are of two kinds, and neither is a command source:
 *  - an ECHO, copying an inbound message's ID/KEY onto its reply so the caller
 *    sees its own breadcrumb back,
 *  - a NON-command use of KEY, which is Tachikoma's STREAM slot (Timer's
 *    heartbeat tag, `notify()`'s event name).
 *
 * A *command* carries neither. It is addressed: `FROM = <the minting node>`,
 * the server replies `TO = FROM`, and the reply lands on that node. See ADR-7
 * and the AGENTS.md pitfall "A reply is already addressed — never correlate it".
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join( __dirname, '..', '..' );
const STAMP = /\[\s*(ID|KEY)\s*\]\s*=[^=]/;

// Every sanctioned stamp, with the reason it is not a correlation table.
const ALLOWED = {
	'runtime/command-interpreter-node.js':
		'echo: a reply carries the inbound ID/KEY back',
	'runtime/router-node.js':
		'echo: an undeliverable message returns its own ID',
	'runtime/node.js':
		'not a command: notify() stamps the event name into KEY (STREAM)',
	'runtime/timer-node.js': 'not a command: the heartbeat tag (STREAM)',
	'runtime/shell-node.js':
		'REPL affordance: `var message.id` / `message.key`, empty unless set',
	'topology-console/hooks/useCompletion.js':
		"not a correlation id: KEY='completion' marks the request kind",
};

const walk = ( dir, out = [] ) => {
	for ( const entry of readdirSync( dir ) ) {
		const path = join( dir, entry );
		if ( statSync( path ).isDirectory() ) {
			if ( /__tests__|__mocks__|test-utils/.test( path ) ) {
				continue;
			}
			walk( path, out );
			continue;
		}
		if ( ! path.endsWith( '.js' ) ) {
			continue;
		}
		readFileSync( path, 'utf8' )
			.split( '\n' )
			.forEach( ( line, i ) => {
				if ( STAMP.test( line ) ) {
					out.push( {
						file: path.slice( SRC.length + 1 ),
						line: i + 1,
						text: line.trim(),
					} );
				}
			} );
	}
	return out;
};

test( 'no command source stamps ID or KEY', () => {
	const offenders = walk( SRC )
		.filter( ( hit ) => ! ( hit.file in ALLOWED ) )
		.map( ( hit ) => `${ hit.file }:${ hit.line }  ${ hit.text }` );

	expect( offenders ).toEqual( [] );
} );

test( 'every allowlisted file still stamps something', () => {
	// A stale entry would silently widen the guard; drop it when the last
	// stamp in that file goes.
	const seen = new Set( walk( SRC ).map( ( hit ) => hit.file ) );

	expect( Object.keys( ALLOWED ).filter( ( f ) => ! seen.has( f ) ) ).toEqual(
		[]
	);
} );
