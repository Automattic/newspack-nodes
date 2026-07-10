/**
 * Structural invariant (JS twin of MessageConstructionInvariantTest.php): every
 * message is created via newMessage() / unpack() in runtime/message.js, never
 * hand-rolled. Messages are positional arrays, so this scans src/ for the
 * hand-construction idiom — a `[ TM_*, <timestamp> ` literal (a TM_ type
 * constant leading an array, followed by a numeric / Date.now() second field) —
 * and fails on any outside message.js itself.
 *
 * Scope: PRODUCTION code under src/ (excluding __tests__). Round-trip / wire-format
 * test fixtures legitimately build the exact positional frame they assert on
 * (e.g. `pack( [ TM_BYTESTREAM, 1, … ] )`) — the literal IS the test — so tests
 * are not scanned; the invariant is runtime consistency.
 *
 * Reach (same as the PHP guard): it catches the idiom that uses the TM_*
 * constants. It can't catch a fully bare-number literal (`[ 1, Date.now()/1000,
 * … ]`) with no TM_ token — indistinguishable from any array by regex. A
 * lint-as-a-test, not a type guarantee. A `[ TM_A, TM_B ]` type-set is NOT
 * flagged (its 2nd element is another TM_, not a timestamp).
 */

import fs from 'fs';
import path from 'path';

// A message literal: [ TM_*, <number|Date.now> — not a bitmask (no comma).
const TM_MESSAGE = /\[\s*TM_[A-Z_]+\s*,\s*(?:[0-9]|Date\.now)/;

const SRC = path.resolve( process.cwd(), 'src' );
const EXEMPT = new Set( [
	'message.js',
	'message-construction-invariant.test.js',
] );

function jsFiles( dir ) {
	const out = [];
	for ( const entry of fs.readdirSync( dir, { withFileTypes: true } ) ) {
		// Skip deps + test fixtures (round-trip tests build literal frames).
		if ( 'node_modules' === entry.name || '__tests__' === entry.name ) {
			continue;
		}
		const full = path.join( dir, entry.name );
		if ( entry.isDirectory() ) {
			out.push( ...jsFiles( full ) );
		} else if ( entry.name.endsWith( '.js' ) ) {
			out.push( full );
		}
	}
	return out;
}

describe( 'message construction invariant', () => {
	it( 'builds every message via newMessage()/unpack(), never a hand-rolled [ TM_*, <ts> ] literal', () => {
		const violations = jsFiles( SRC )
			.filter( ( file ) => ! EXEMPT.has( path.basename( file ) ) )
			.filter( ( file ) =>
				TM_MESSAGE.test( fs.readFileSync( file, 'utf8' ) )
			)
			.map( ( file ) => path.relative( SRC, file ) );
		expect( violations ).toEqual( [] );
	} );
} );
