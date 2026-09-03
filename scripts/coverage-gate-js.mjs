#!/usr/bin/env node
/**
 * Per-file JS coverage gate for the pre-push hook — the JS counterpart to
 * scripts/coverage-gate.py, which gates PHP one class at a time. Reads the
 * `coverage-summary.json` jest writes and exits:
 *   1  if any file whose path contains --filter is below --threshold percent
 *      statement coverage (prints the offenders),
 *   0  if every matched file is at or above threshold, OR there is nothing to
 *      gate — no summary file (a plugin whose `test:js:coverage` is the `true`
 *      no-op, i.e. no jest/JS) or a summary with no matching src files,
 *   2  on a refusal: no summary path given, a summary that will not parse, or
 *      a --threshold that is not a number.
 *
 * The absent-summary case is a clean skip (unlike the PHP gate's missing-clover
 * failure) because the pre-push runs `npm run test:js:coverage` first and fails
 * the push if jest itself errored — so a real jest run always leaves a summary,
 * and its absence means the plugin simply has no JS to measure.
 *
 * Every other unreadable input refuses instead of passing, because both numbers
 * this gate compares degrade to NaN and `pct < NaN` is false for every file: a
 * threshold that will not parse, or a pct the summary reports as something
 * other than a number, would report success having gated nothing.
 * scripts/test-coverage-gate-js.sh pins each of those cases over fixtures.
 *
 * Newspack Nodes holds the authoritative copy — siblings vendor this file
 * through scripts/sync-shared-scripts.sh, so an edit belongs here.
 *
 * Usage: coverage-gate-js.mjs <coverage-summary.json> [--threshold 90] [--filter /src/]
 */

import fs from 'node:fs';

/**
 * Classify the command line into the summary path, threshold and filter.
 *
 * The first bare argument is the summary path and later ones are ignored, so a
 * stray token cannot retarget the gate at a file nobody meant to measure. A
 * --threshold that is not a number exits here rather than falling back to the
 * default, because a gate that quietly substitutes its own threshold stops
 * reporting what the caller asked for.
 *
 * @param {string[]} argv Arguments after the node binary and this script.
 * @return {{summary: (string|null), threshold: number, filter: (string|undefined)}} The parsed options.
 */
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

/**
 * One summary key with backslash separators rewritten to forward slashes.
 *
 * jest keys the summary with the host platform's separator, while --filter is
 * written one way (`/src/`), so matching the raw key would miss every file on
 * Windows and skip the whole tree.
 *
 * @param {string} s The file path as the summary keys it.
 * @return {string} The same path, separated by `/`.
 */
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
	/**
	 * The sort position of one file's statement pct — an unreadable pct ranks
	 * below every real percentage, so it heads the printed list.
	 *
	 * @param {number} p The file's statement pct, NaN when unreadable.
	 * @return {number} Its sort key.
	 */
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
