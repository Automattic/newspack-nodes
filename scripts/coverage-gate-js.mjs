#!/usr/bin/env node
/**
 * Per-file JS coverage gate for the pre-push hook — the JS counterpart to
 * scripts/coverage-gate.py. Reads jest's coverage/coverage-summary.json and
 * exits:
 *   1  if any file under --filter is below --threshold percent statement
 *      coverage (prints the offenders),
 *   0  if every matched file is at/above threshold, OR there is nothing to
 *      gate — no summary file (a plugin whose `test:js:coverage` is the `true`
 *      no-op, i.e. no jest/JS) or a summary with no matching src files.
 *   2  if the summary exists but cannot be parsed.
 *
 * The absent-summary case is a clean skip (unlike the PHP gate's missing-clover
 * failure) because the pre-push runs `npm run test:js:coverage` first and fails
 * the push if jest itself errored — so a real jest run always leaves a summary,
 * and its absence means the plugin simply has no JS to measure.
 *
 * Usage: coverage-gate-js.mjs <coverage-summary.json> [--threshold 90] [--filter /src/]
 */

import fs from 'node:fs';

function parseArgs( argv ) {
	const args = { summary: null, threshold: 90, filter: '/src/' };
	for ( let i = 0; i < argv.length; i++ ) {
		if ( '--threshold' === argv[ i ] ) {
			const raw = argv[ ++i ];
			// Number( '' ) is 0, and a 0 threshold gates nothing.
			args.threshold =
				'' === String( raw ?? '' ).trim() ? NaN : Number( raw );
			if ( ! Number.isFinite( args.threshold ) ) {
				process.stderr.write(
					`coverage-gate-js: --threshold needs a number, got '${
						raw ?? ''
					}'\n`
				);
				process.exit( 2 );
			}
		} else if ( '--filter' === argv[ i ] ) {
			args.filter = argv[ ++i ];
		} else if ( null === args.summary ) {
			args.summary = argv[ i ];
		}
	}
	return args;
}

const { summary, threshold, filter } = parseArgs( process.argv.slice( 2 ) );

if ( ! summary ) {
	process.stderr.write(
		'coverage-gate-js: no coverage-summary.json path given\n'
	);
	process.exit( 2 );
}
if ( ! fs.existsSync( summary ) ) {
	// No jest coverage produced — a plugin with no JS. Nothing to gate.
	process.exit( 0 );
}

let data;
try {
	data = JSON.parse( fs.readFileSync( summary, 'utf8' ) );
} catch ( e ) {
	process.stderr.write(
		`coverage-gate-js: cannot read ${ summary }: ${ e.message }\n`
	);
	process.exit( 2 );
}

const norm = ( s ) => s.split( '\\' ).join( '/' );
const offenders = [];
let matched = 0;
for ( const [ file, metrics ] of Object.entries( data ) ) {
	if ( 'total' === file ) {
		continue;
	}
	if ( filter && ! norm( file ).includes( filter ) ) {
		continue;
	}
	matched++;
	const pct = Number( metrics.statements?.pct );
	// Unreadable pct is an offender: `NaN < threshold` reads as covered.
	if ( ! Number.isFinite( pct ) || pct < threshold ) {
		offenders.push( [ norm( file ).split( filter ).pop(), pct ] );
	}
}

if ( 0 === matched ) {
	// Summary present but no src files — nothing to gate.
	process.exit( 0 );
}

if ( offenders.length ) {
	// An unreadable pct sorts first: it is the least trustworthy number here.
	const rank = ( p ) => ( Number.isFinite( p ) ? p : -1 );
	offenders.sort( ( a, b ) => rank( a[ 1 ] ) - rank( b[ 1 ] ) );
	process.stderr.write(
		`\nJS COVERAGE GATE FAILED — ${ offenders.length } below ${ threshold }% (of ${ matched } files):\n\n`
	);
	const width = Math.max( ...offenders.map( ( [ name ] ) => name.length ) );
	for ( const [ name, pct ] of offenders ) {
		const shown = Number.isFinite( pct ) ? `${ pct.toFixed( 1 ) }%` : '?';
		process.stderr.write( `  * ${ name.padEnd( width ) }  ${ shown }\n` );
	}
	process.exit( 1 );
}

process.stderr.write(
	`JS coverage gate: all ${ matched } files at or above ${ threshold }%\n`
);
process.exit( 0 );
