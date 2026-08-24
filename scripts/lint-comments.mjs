/**
 * Pre-commit gate: inline comments are ONE line, <= 80 visual columns (JS twin
 * of scripts/lint-comments.php).
 *
 * Heuristic lexer over comment-only lines (only whitespace before the `//`),
 * so string contents rarely false-positive; a hit inside a template literal is
 * fixable with @longform. JSDoc blocks (slash-star-star) are exempt from
 * length. An INLINE comment tagged `@longform` (first line) is exempt — the
 * greppable marker for footgun comments whose full length is strictly
 * necessary. A JSDoc block is exempt already, so opening one of its lines with
 * that tag marks nothing and is itself an error; prose naming the tag is fine.
 * Directive comments (eslint-, prettier-, @ts-, istanbul, jsx pragma) are
 * exempt. Unit tests are exempt by path (__tests__/, *.test.js*, tests/).
 *
 * Exit 0 clean; exit 1 with `file:line: message` per violation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_COLS = 80;
const TAB_WIDTH = 4;

const isExemptPath = ( p ) =>
	/(^|\/)(tests?|__tests__|__mocks__|node_modules|build|vendor|coverage|dist|release|\.phpstan)\//.test(
		p
	) ||
	/\.test\.[jt]sx?$/.test( p ) ||
	// Build/lint config files carry their own explanatory prose; not source.
	/(^|\/)(\.eslintrc|\.prettierrc|\.stylelintrc|babel\.config|jest\.(config|setup|style-mock)|commitlint\.config|webpack\.config)\.[cm]?js$/.test(
		p
	);

const isDirective = ( text ) =>
	/^\s*(?:\/\/|\/\*)+\s*(?:eslint-|prettier-|@ts-|istanbul\s|jsx\s|global\s|translators:|@codeCoverageIgnore|@phpstan-|@codingStandardsIgnore)/.test(
		text
	);

const isLongform = ( text ) => text.includes( '@longform' );

/**
 * One JSDoc content line, stripped of its comment furniture.
 *
 * @param {string} trimmed The whitespace-trimmed source line.
 * @return {string} Its content.
 */
const docText = ( trimmed ) =>
	trimmed
		.replace( /\*\/$/, '' )
		.replace( /^\/?\*+/, '' )
		.trim();

/**
 * The line a JSDoc block carries a `@longform` tag on, or 0.
 *
 * The tag exempts an inline comment from the length gate, and a JSDoc block is
 * exempt already, so inside one it marks nothing while reading as an opt-out
 * the next editor goes hunting for. Only a content line OPENING with it is
 * that marker: prose NAMING the tag stays legal, or this gate's own
 * documentation could not describe the rule it enforces. PHP twin:
 * `longform_tag` in lint-comments.php.
 *
 * @param {Array} content `[ lineNumber, text ]` pairs.
 * @return {number} The offending line, or 0 when the block carries no tag.
 */
const longformTag = ( content ) => {
	for ( const [ n, text ] of content ) {
		if ( text.startsWith( '@longform' ) ) {
			return n;
		}
	}
	return 0;
};

/**
 * The line a JSDoc description sits BELOW the tags on, or 0.
 *
 * No renderer shows that text, so it reads as documentation while documenting
 * nothing. The separator is what identifies it: a wrapped tag description
 * continues on the very next line, so only a blank `*` followed by non-tag
 * text is this shape.
 *
 * @param {Array} content `[ lineNumber, text ]` pairs.
 * @return {number} The offending line, or 0 when the block is well-formed.
 */
const proseAfterTags = ( content ) => {
	let seenTag = false;
	let blank = false;
	for ( const [ n, text ] of content ) {
		if ( text.startsWith( '##' ) ) {
			// WP-CLI parses `## OPTIONS` / `## EXAMPLES` below the tags.
			return 0;
		}
		if ( text.startsWith( '@' ) ) {
			seenTag = true;
			blank = false;
		} else if ( '' === text ) {
			blank = true;
		} else {
			if ( seenTag && blank ) {
				return n;
			}
			blank = false;
		}
	}
	return 0;
};

const visualLength = ( line ) => {
	let col = 0;
	for ( const ch of line ) {
		col =
			'\t' === ch
				? ( Math.floor( col / TAB_WIDTH ) + 1 ) * TAB_WIDTH
				: col + 1;
	}
	return col;
};

function checkFile( path ) {
	const lines = readFileSync( path, 'utf8' ).split( '\n' );
	const violations = [];
	const commentOnly = new Map();
	let inBlock = false;
	let blockStart = 0;
	let blockIsDoc = false;
	let blockExempt = false;
	let blockContent = [];

	// The two JSDoc rules, run wherever the block turns out to end.
	const closeBlock = () => {
		if ( ! blockIsDoc ) {
			return;
		}
		const tagged = longformTag( blockContent );
		if ( tagged ) {
			violations.push(
				`${ tagged }: @longform in a docblock (docblocks are exempt from the length gate; drop the tag)`
			);
		}
		const stray = proseAfterTags( blockContent );
		if ( stray ) {
			violations.push(
				`${ stray }: prose after the tag block (the description goes above the tags)`
			);
		}
	};

	lines.forEach( ( raw, i ) => {
		const n = i + 1;
		const line = raw.replace( /\r$/, '' );
		const trimmed = line.trim();

		if ( inBlock ) {
			blockContent.push( [ n, docText( trimmed ) ] );
			if ( ! trimmed.includes( '*/' ) ) {
				return;
			}
			inBlock = false;
			if ( ! blockIsDoc && ! blockExempt && n > blockStart ) {
				violations.push(
					`${ blockStart }: multi-line /* */ comment (use JSDoc, one line, or @longform)`
				);
			}
			closeBlock();
			return;
		}
		if ( trimmed.startsWith( '/*' ) ) {
			blockIsDoc = trimmed.startsWith( '/**' );
			blockExempt = isLongform( trimmed ) || isDirective( trimmed );
			blockStart = n;
			blockContent = [ [ n, docText( trimmed ) ] ];
			if ( ! trimmed.includes( '*/' ) ) {
				inBlock = true;
				return;
			}
			if (
				! blockIsDoc &&
				! blockExempt &&
				visualLength( line ) > MAX_COLS
			) {
				violations.push(
					`${ n }: comment exceeds ${ MAX_COLS } columns (condense, or tag @longform)`
				);
			}
			closeBlock();
			return;
		}
		if ( trimmed.startsWith( '//' ) ) {
			commentOnly.set( n, trimmed );
			if (
				! isLongform( trimmed ) &&
				! isDirective( trimmed ) &&
				visualLength( line ) > MAX_COLS
			) {
				violations.push(
					`${ n }: comment exceeds ${ MAX_COLS } columns (condense, or tag @longform)`
				);
			}
		}
	} );

	// Block check: >= 2 consecutive comment-only lines, first not @longform.
	let runStart = 0;
	let runLen = 0;
	let prev = 0;
	const flush = () => {
		if ( runLen < 2 ) {
			return;
		}
		let nonDirective = 0;
		for ( let l = runStart; l < runStart + runLen; l++ ) {
			if ( ! isDirective( commentOnly.get( l ) ?? '' ) ) {
				nonDirective++;
			}
		}
		if (
			nonDirective >= 2 &&
			! isLongform( commentOnly.get( runStart ) ?? '' )
		) {
			violations.push(
				`${ runStart }: ${ runLen }-line comment block (one line, JSDoc, or @longform)`
			);
		}
	};
	for ( const line of [ ...commentOnly.keys() ].sort( ( a, b ) => a - b ) ) {
		if ( line === prev + 1 && runLen > 0 ) {
			runLen++;
		} else {
			flush();
			runStart = line;
			runLen = 1;
		}
		prev = line;
	}
	flush();

	return violations.sort( ( a, b ) => parseInt( a, 10 ) - parseInt( b, 10 ) );
}

const SKIP_DIRS = new Set( [
	'node_modules',
	'build',
	'vendor',
	'release',
	'.git',
] );
const isSourceFile = ( p ) => /\.[cm]?jsx?$/.test( p );

function* walkFiles( dir ) {
	for ( const entry of readdirSync( dir, { withFileTypes: true } ) ) {
		const full = join( dir, entry.name );
		if ( entry.isDirectory() ) {
			if ( ! SKIP_DIRS.has( entry.name ) ) {
				yield* walkFiles( full );
			}
		} else if ( entry.isFile() && isSourceFile( full ) ) {
			yield full;
		}
	}
}

function* expandArg( arg ) {
	if ( ! existsSync( arg ) ) {
		return;
	}
	if ( statSync( arg ).isDirectory() ) {
		yield* walkFiles( arg );
	} else {
		yield arg;
	}
}

let failed = false;
for ( const arg of process.argv.slice( 2 ) ) {
	for ( const path of expandArg( arg ) ) {
		if ( ! isSourceFile( path ) || isExemptPath( path ) ) {
			continue;
		}
		for ( const violation of checkFile( path ) ) {
			process.stderr.write( `${ path }:${ violation }\n` );
			failed = true;
		}
	}
}
process.exit( failed ? 1 : 0 );
