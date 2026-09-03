/**
 * Pre-commit gate: inline comments are ONE line, <= 80 visual columns.
 *
 * Arguments are files or directories — lint-staged passes the staged paths,
 * `npm run lint:js` passes `.`. `scripts/lint-comments.php` is the PHP half of
 * the same gate; a rule the two spell differently is a rule neither enforces,
 * so each function with a counterpart names it. Placement, generic spacing and
 * `--fix` are the PHP half's alone.
 *
 * LENGTH: a `//` line and a non-doc slash-star comment are one line and at
 * most 80 columns, and two adjacent comment lines are a paragraph wanting a
 * JSDoc block instead. JSDoc blocks are exempt from length. An INLINE
 * comment tagged `@longform` (first line) is exempt — the greppable marker
 * for footgun comments whose full length is strictly necessary. Directive
 * comments are exempt too, because splitting one changes what its tool reads.
 *
 * DOCBLOCK SHAPE: a JSDoc block is exempt from length already, so opening one
 * of its lines with that tag marks nothing and is itself an error; prose
 * naming the tag is fine. A description sitting below the tag block renders
 * nowhere, and is an error for the same reason.
 *
 * The lexer is a heuristic over comment-only lines (only whitespace before the
 * `//`), so string contents rarely false-positive; a hit inside a template
 * literal is fixable with @longform.
 *
 * Exit 0 clean; exit 1 with `file:line: message` per violation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The column budget every non-exempt comment line fits inside. */
const MAX_COLS = 80;

/** Columns a tab advances to. The PHP twin counts the same stop. */
const TAB_WIDTH = 4;

/**
 * Is this path exempt from the comment rules?
 *
 * Unit tests are exempt by the project's own standard; the rest hold vendored
 * or generated files nobody hand-edits. `walkFiles` prunes four of these
 * directories on its own, but lint-staged names files directly, and those
 * never went through the walk.
 *
 * @param {string} p Path to check.
 * @return {boolean} True when the file is not linted.
 */
const isExemptPath = ( p ) =>
	/(^|\/)(tests?|__tests__|__mocks__|node_modules|build|vendor|coverage|dist|release|\.phpstan)\//.test(
		p
	) ||
	/\.test\.[jt]sx?$/.test( p ) ||
	// Build/lint config files carry their own explanatory prose; not source.
	/(^|\/)(\.eslintrc|\.prettierrc|\.stylelintrc|babel\.config|jest\.(config|setup|style-mock)|commitlint\.config|webpack\.config)\.[cm]?js$/.test(
		p
	);

/**
 * Is this comment a directive to another tool?
 *
 * A directive addresses eslint, prettier, TypeScript, istanbul, the JSX
 * pragma, gettext's `translators:` note, or a coverage or static-analysis
 * tool. Each reads one fixed spelling on one line, so the comment can be
 * neither wrapped nor condensed.
 *
 * @param {string} text One trimmed comment line.
 * @return {boolean} True when the comment is a directive.
 */
const isDirective = ( text ) =>
	/^\s*(?:\/\/|\/\*)+\s*(?:eslint-|prettier-|@ts-|istanbul\s|jsx\s|global\s|translators:|@codeCoverageIgnore|@phpstan-|@codingStandardsIgnore)/.test(
		text
	);

/**
 * Does this comment carry the `@longform` opt-out?
 *
 * The tag may sit anywhere on the line it exempts, and on a multi-line
 * comment it is the FIRST line that carries it: the exemption belongs to a
 * marker the next reader can grep for, not to a position.
 *
 * @param {string} text One trimmed comment line.
 * @return {boolean} True when the comment opts out of the length rule.
 */
const isLongform = ( text ) => text.includes( '@longform' );

/**
 * One JSDoc content line, stripped of its comment furniture.
 *
 * PHP twin: `doc_lines` in lint-comments.php, which strips a whole block in
 * one call because a PHP docblock arrives as a single token.
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
 * @param {Array<[number,string]>} content `[ lineNumber, text ]` pairs.
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
 * text is this shape. PHP twin: `prose_after_tags` in lint-comments.php.
 *
 * @param {Array<[number,string]>} content `[ lineNumber, text ]` pairs.
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

/**
 * Visual length with tabs expanded to the next TAB_WIDTH stop.
 *
 * Code points, not UTF-16 units: `for...of` counts an astral character once,
 * as the screen does and as the PHP twin's `mb_str_split` does, so a sentence
 * that fits in a PHP comment fits in a JS one.
 *
 * @param {string} line One source line.
 * @return {number} Visual columns.
 */
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

/**
 * Every violation in one file.
 *
 * One pass classifies each line — continuing a block comment, opening one, or
 * standing alone as a `//` comment — and the run check follows it, because a
 * run's length is known only once the run ends. The two JSDoc rules run from
 * `closeBlock`, which every path ending a block calls, so a block closing on
 * its opening line is judged the same as one spanning twenty.
 *
 * @param {string} path Path to check.
 * @return {Array<string>} `line: message` violations, ordered by line.
 */
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

/**
 * Directories the walk never descends.
 *
 * Pruning beats filtering the walk's results: `node_modules` holds tens of
 * thousands of files against the checkout's few hundred sources, and the walk
 * would stat every one of them only to discard it.
 */
const SKIP_DIRS = new Set( [
	'node_modules',
	'build',
	'vendor',
	'release',
	'.git',
] );

/**
 * Does this path name a file the gate reads?
 *
 * @param {string} p Path to check.
 * @return {boolean} True for `.js` and `.jsx` and their `.cjs`/`.mjs` forms.
 */
const isSourceFile = ( p ) => /\.[cm]?jsx?$/.test( p );

/**
 * Every source file under a directory, depth-first.
 *
 * @param {string} dir Directory to walk.
 * @return {IterableIterator<string>} Paths of the source files found.
 */
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

/**
 * The files one command-line argument names.
 *
 * A directory expands to the source files under it and a file passes through,
 * so `lint-comments.mjs .` and the explicit paths lint-staged passes reach the
 * same checker. A path that does not exist yields nothing.
 *
 * @param {string} arg One argv entry.
 * @return {IterableIterator<string>} Paths to check.
 */
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
