#!/usr/bin/env node
/**
 * lint-english — fail the build on the clipped prose a reader has to read twice.
 *
 * The rules come from Strunk and White by way of `~/.claude/rules/voice.md`, and
 * the folded-negative rulings from the sweep that wrote them down. Each lives in
 * RULES as one row: an id, a pattern, the message saying what to write instead,
 * and its carve-outs as data beside the pattern.
 *
 * The gate has one shape for every file type. A reader in READERS blanks all
 * that is not prose, `paragraphs()` joins what is left so a phrase can wrap
 * across lines and across a docblock's prefix, and each rule runs over the
 * joined text. A hit reports the line its phrase starts on.
 *
 *     node scripts/lint-english.mjs <file-or-directory>…
 *
 * Exit 0 clean; exit 1 with `file:line: [id] message` per hit.
 *
 * A false positive is carved out here, in the rule's `keep`, and never reworded
 * around. The gate offers no opt-out comment and honours no marker, because every
 * opt-out in a source tree teaches the next reader to write one.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { walkFiles } from './lib/walk-files.mjs';

/** The sentence every hit ends on. */
const CARVE_OUT =
	'A false positive must be carved out of the gate itself, in newspack-nodes/scripts/lint-english.mjs: never reword around it. There is no opt-out comment.';

/** What a code span or a tag leaves in the prose: a rule cannot match across it. */
const CODE = '§';

/** What a URL leaves in the prose. */
const URL_MARK = '‹url›';

/** What a GitHub URL leaves, so `github-line` can see what stood beside it. */
const GITHUB_MARK = '‹github›';

/**
 * Trees and files outside our prose: generated, vendored, fixture data, mock
 * pages, legal text, or a history the gate must not rewrite. `walkFiles` prunes some of these
 * on its own, but lint-staged names files directly.
 */
const EXEMPT =
	/(^|\/)(node_modules|vendor|build|dist|release|coverage|\.phpstan|\.git|fixtures|__fixtures__|templates-fixtures)\/|(^|\/)docs\/.*\/mocks\/|(^|\/)tests\/(templates\/|INVENTORY\.md$)|(^|\/)(CHANGELOG|LICENSE)\.md$|\.min\.(js|css)$/;

/**
 * Community's specs and plans, which another repo's `docs/superpowers` is not.
 * It reads a resolved path, because a hook run inside the repo names `docs/…`.
 */
const COMMUNITY_DESIGN_DOCS =
	/\/newspack-community\/docs\/(?:fdn-arch|superpowers)\//;

/**
 * Is this path outside our prose?
 *
 * @param {string} path Path to check.
 * @return {boolean} True for a path the gate skips.
 */
const isExempt = ( path ) =>
	EXEMPT.test( path ) || COMMUNITY_DESIGN_DOCS.test( resolve( path ) );

/**
 * Where a line starts a new thought, whatever the line above it said.
 */
const BLOCK_START = /^(?:@\w|[-*+] |\d+[.)] |#{1,6} |\|)/;

/** A character replaced by a space, leaving the line count alone. */
const blank = ( text ) => text.replace( /[^\n]/g, ' ' );

/**
 * The source with everything but the pieces blanked.
 *
 * @param {string}                 source The file.
 * @param {Array<[number,string]>} pieces `[ offset, text ]`, in offset order.
 * @return {string} A string of the same lines, holding only the pieces.
 */
function overlay( source, pieces ) {
	const parts = [];
	let at = 0;
	for ( const [ start, text ] of pieces ) {
		parts.push( blank( source.slice( at, start ) ), text );
		at = start + text.length;
	}
	parts.push( blank( source.slice( at ) ) );
	return parts.join( '' );
}

/**
 * The offset of the newline ending a line, or the end of the file.
 *
 * @param {string} source The file.
 * @param {number} i      An offset on the line.
 * @return {number} The offset.
 */
function endOfLine( source, i ) {
	const end = source.indexOf( '\n', i );
	return -1 === end ? source.length : end;
}

/**
 * Keep a comment's body, to the end offset given.
 *
 * @param {string}                 source The file.
 * @param {number}                 start  Where the body starts.
 * @param {number}                 end    Where it stops.
 * @param {Array<[number,string]>} pieces The prose kept so far.
 * @return {number} Where scanning resumes.
 */
function keepLine( source, start, end, pieces ) {
	pieces.push( [ start, source.slice( start, end ) ] );
	return end;
}

/**
 * Keep a block comment's body, its `*` prefixes blanked.
 *
 * @param {string}                 source The file.
 * @param {number}                 i      Offset of the opener.
 * @param {Array<[number,string]>} pieces The prose kept so far.
 * @return {number} Where scanning resumes.
 */
function keepBlock( source, i, pieces ) {
	const close = source.indexOf( '*/', i + 2 );
	const end = -1 === close ? source.length : close;
	pieces.push( [
		i + 2,
		source.slice( i + 2, end ).replace( /^[ \t]*\*+/gm, blank ),
	] );
	return end + 2;
}

/**
 * A `//` or slash-star comment, in any language that spells them so.
 *
 * @param {string}                 source The file.
 * @param {number}                 i      Offset of the slash.
 * @param {Array<[number,string]>} pieces The prose kept so far.
 * @return {number|undefined} Where scanning resumes, undefined for no comment.
 */
function slashComment( source, i, pieces ) {
	if ( '/' === source[ i + 1 ] ) {
		return keepLine( source, i + 2, endOfLine( source, i ), pieces );
	}
	return '*' === source[ i + 1 ] ? keepBlock( source, i, pieces ) : undefined;
}

/**
 * A slash-star comment, the only spelling CSS has.
 *
 * @param {string}                 source The file.
 * @param {number}                 i      Offset of the slash.
 * @param {Array<[number,string]>} pieces The prose kept so far.
 * @return {number|undefined} Where scanning resumes, undefined for no comment.
 */
function blockComment( source, i, pieces ) {
	return '*' === source[ i + 1 ] ? keepBlock( source, i, pieces ) : undefined;
}

/**
 * Skip a quoted string that may hold a backslash escape.
 *
 * @param {boolean} multiline Whether the string may cross a newline.
 * @return {function(string,number):number} The token.
 */
const quoted = ( multiline ) => ( source, i ) => {
	const quote = source[ i ];
	for ( let at = i + 1; at < source.length; at++ ) {
		if ( '\\' === source[ at ] ) {
			at++;
		} else if ( quote === source[ at ] ) {
			return at + 1;
		} else if ( '\n' === source[ at ] && ! multiline ) {
			return at;
		}
	}
	return source.length;
};

/** A string that a newline ends, which bounds a stray JSX apostrophe. */
const lineString = quoted( false );

/**
 * Skip a template literal, nested expressions included.
 *
 * @param {string} source The file.
 * @param {number} i      Offset of the opening backtick.
 * @return {number} Where scanning resumes.
 */
function templateLiteral( source, i ) {
	for ( let at = i + 1; at < source.length; at++ ) {
		if ( '\\' === source[ at ] ) {
			at++;
		} else if ( '`' === source[ at ] ) {
			return at + 1;
		} else if ( '$' === source[ at ] && '{' === source[ at + 1 ] ) {
			at = templateExpression( source, at + 2 ) - 1;
		}
	}
	return source.length;
}

/**
 * Skip a template literal's `${…}`, from inside its opening brace.
 *
 * @param {string} source The file.
 * @param {number} i      Offset after the opening brace.
 * @return {number} Offset after the closing brace.
 */
function templateExpression( source, i ) {
	let depth = 1;
	for ( let at = i; at < source.length; at++ ) {
		const ch = source[ at ];
		if ( '`' === ch ) {
			at = templateLiteral( source, at ) - 1;
		} else if ( "'" === ch || '"' === ch ) {
			at = lineString( source, at ) - 1;
		} else if ( '{' === ch ) {
			depth++;
		} else if ( '}' === ch && 0 === --depth ) {
			return at + 1;
		}
	}
	return source.length;
}

/** What stands before a slash that opens a regex rather than divides. */
const REGEX_PRECEDES =
	/(?:^|[(,=:[!&|?{};+\-*%~^]|\b(?:return|typeof|case|of|in|yield|await|delete|void|new|throw|else|do))\s*$/;

/**
 * Skip a regex literal, which ends on its line or was never one.
 *
 * @param {string} source The file.
 * @param {number} i      Offset of the slash.
 * @return {number|undefined} Offset after the literal, undefined for no literal.
 */
function regexLiteral( source, i ) {
	let inClass = false;
	for ( let at = i + 1; at < source.length; at++ ) {
		const ch = source[ at ];
		if ( '\n' === ch ) {
			return undefined;
		}
		if ( '\\' === ch ) {
			at++;
		} else if ( '[' === ch ) {
			inClass = true;
		} else if ( ']' === ch ) {
			inClass = false;
		} else if ( '/' === ch && ! inClass ) {
			return at + 1;
		}
	}
	return undefined;
}

/**
 * A JS slash: a comment, a regex literal or a division.
 *
 * @param {string}                 source The file.
 * @param {number}                 i      Offset of the slash.
 * @param {Array<[number,string]>} pieces The prose kept so far.
 * @return {number|undefined} Where scanning resumes, undefined for a division.
 */
function jsSlash( source, i, pieces ) {
	const comment = slashComment( source, i, pieces );
	if ( undefined !== comment ) {
		return comment;
	}
	const before = source.slice( Math.max( 0, i - 12 ), i );
	return REGEX_PRECEDES.test( before )
		? regexLiteral( source, i )
		: undefined;
}

/**
 * Where a PHP line comment ends: its newline, or a closing tag before it.
 *
 * @param {string} source The file.
 * @param {number} i      An offset in the comment.
 * @return {number} The offset.
 */
function phpLineEnd( source, i ) {
	const eol = endOfLine( source, i );
	const close = source.indexOf( '?>', i );
	return -1 === close || close > eol ? eol : close;
}

/**
 * A PHP slash: `//` runs to a closing tag as well as to a newline.
 *
 * @param {string}                 source The file.
 * @param {number}                 i      Offset of the slash.
 * @param {Array<[number,string]>} pieces The prose kept so far.
 * @return {number|undefined} Where scanning resumes, undefined for no comment.
 */
function phpSlash( source, i, pieces ) {
	return '/' === source[ i + 1 ]
		? keepLine( source, i + 2, phpLineEnd( source, i ), pieces )
		: blockComment( source, i, pieces );
}

/**
 * A PHP hash comment, which `#[` is not: that opens an attribute.
 *
 * @param {string}                 source The file.
 * @param {number}                 i      Offset of the hash.
 * @param {Array<[number,string]>} pieces The prose kept so far.
 * @return {number|undefined} Where scanning resumes, undefined for an attribute.
 */
function phpHash( source, i, pieces ) {
	return '[' === source[ i + 1 ]
		? undefined
		: keepLine( source, i + 1, phpLineEnd( source, i ), pieces );
}

/**
 * Skip to the end of a heredoc whose terminator matches.
 *
 * @param {string} source     The file.
 * @param {number} bodyStart  Where the body starts.
 * @param {string} terminator The pattern naming the closing line.
 * @return {number|undefined} Offset after it, undefined when it never comes.
 */
function heredocEnd( source, bodyStart, terminator ) {
	const close = new RegExp( terminator, 'gm' );
	close.lastIndex = bodyStart;
	return close.exec( source ) ? close.lastIndex : undefined;
}

/**
 * A PHP heredoc or nowdoc.
 *
 * @param {string} source The file.
 * @param {number} i      Offset of the `<`.
 * @return {number|undefined} Offset after it, undefined for anything else.
 */
function phpHeredoc( source, i ) {
	const open = /<<<[ \t]*(['"]?)(\w+)\1\r?\n/y;
	open.lastIndex = i;
	const match = open.exec( source );
	return match
		? heredocEnd( source, open.lastIndex - 1, `^[ \\t]*${ match[ 2 ] }\\b` )
		: undefined;
}

/**
 * Skip from a closing tag to the next opening tag, or to the end of the file.
 *
 * @param {string} source The file.
 * @param {number} i      Where the inline HTML starts.
 * @return {number} Where the PHP resumes.
 */
function phpResume( source, i ) {
	const open = /<\?(?:php|=)/g;
	open.lastIndex = i;
	return open.exec( source ) ? open.lastIndex : source.length;
}

/**
 * A question mark, which ends PHP mode when a `>` follows it.
 *
 * @param {string} source The file.
 * @param {number} i      Offset of the `?`.
 * @return {number|undefined} Where the PHP resumes, undefined for no closing tag.
 */
function phpClose( source, i ) {
	return '>' === source[ i + 1 ] ? phpResume( source, i + 2 ) : undefined;
}

/**
 * An unquoted `url(…)`, whose `//` opens no comment.
 *
 * @param {string} source The file.
 * @param {number} i      Offset of the `u`.
 * @return {number|undefined} Offset after it, undefined for anything else.
 */
function cssUrl( source, i ) {
	if ( ! source.startsWith( 'url(', i ) ) {
		return undefined;
	}
	const close = source.indexOf( ')', i );
	return -1 === close ? undefined : close + 1;
}

/**
 * A shell hash, a comment only at the start of a word. The shebang stays out.
 *
 * @param {string}                 source The file.
 * @param {number}                 i      Offset of the hash.
 * @param {Array<[number,string]>} pieces The prose kept so far.
 * @return {number|undefined} Where scanning resumes, undefined inside a word.
 */
function shellHash( source, i, pieces ) {
	if ( 0 === i && '!' === source[ 1 ] ) {
		return endOfLine( source, 0 );
	}
	return 0 === i || /[\s;()|&]/.test( source[ i - 1 ] )
		? keepLine( source, i + 1, endOfLine( source, i ), pieces )
		: undefined;
}

/**
 * Skip a double-quoted shell string, substitutions included.
 *
 * @param {string} source The file.
 * @param {number} i      Offset of the opening quote.
 * @return {number} Offset after the closing quote.
 */
function shellString( source, i ) {
	for ( let at = i + 1; at < source.length; at++ ) {
		if ( '\\' === source[ at ] ) {
			at++;
		} else if ( '"' === source[ at ] ) {
			return at + 1;
		} else if ( '$' === source[ at ] && '(' === source[ at + 1 ] ) {
			at = shellSubstitution( source, at + 2 ) - 1;
		}
	}
	return source.length;
}

/**
 * Skip a `$(…)` inside a string, from inside its opening parenthesis.
 *
 * @param {string} source The file.
 * @param {number} i      Offset after the opening parenthesis.
 * @return {number} Offset after the closing parenthesis.
 */
function shellSubstitution( source, i ) {
	let depth = 1;
	for ( let at = i; at < source.length; at++ ) {
		const ch = source[ at ];
		if ( '\\' === ch ) {
			at++;
		} else if ( "'" === ch ) {
			at = shellSingle( source, at ) - 1;
		} else if ( '"' === ch ) {
			at = shellString( source, at ) - 1;
		} else if ( '(' === ch ) {
			depth++;
		} else if ( ')' === ch && 0 === --depth ) {
			return at + 1;
		}
	}
	return source.length;
}

/**
 * Skip a single-quoted shell string, which has no escapes.
 *
 * @param {string} source The file.
 * @param {number} i      Offset of the opening quote.
 * @return {number} Offset after the closing quote.
 */
function shellSingle( source, i ) {
	const close = source.indexOf( "'", i + 1 );
	return -1 === close ? source.length : close + 1;
}

/**
 * A shell heredoc, skipped with the rest of the line that opened it.
 *
 * @param {string} source The file.
 * @param {number} i      Offset of the `<`.
 * @return {number|undefined} Offset after it, undefined for anything else.
 */
function shellHeredoc( source, i ) {
	if ( source.startsWith( '<<<', i ) ) {
		return i + 3;
	}
	const open = /<<-?[ \t]*['"\\]?([A-Za-z_]\w*)/y;
	open.lastIndex = i;
	const match = open.exec( source );
	return match
		? heredocEnd(
				source,
				endOfLine( source, i ),
				`^[ \\t]*${ match[ 1 ] }[ \\t]*$`
		  )
		: undefined;
}

/**
 * Each language's scanner: what to do at a character that can open something.
 * A token answers the offset to resume at, or undefined to step past it.
 */
const JS_TOKENS = {
	'/': jsSlash,
	"'": lineString,
	'"': lineString,
	'`': templateLiteral,
};
const PHP_TOKENS = {
	'/': phpSlash,
	'#': phpHash,
	"'": quoted( true ),
	'"': quoted( true ),
	'<': phpHeredoc,
	'?': phpClose,
};
const SCSS_TOKENS = {
	'/': slashComment,
	"'": lineString,
	'"': lineString,
	u: cssUrl,
};
const CSS_TOKENS = { ...SCSS_TOKENS, '/': blockComment };
const SHELL_TOKENS = {
	'#': shellHash,
	"'": shellSingle,
	'"': shellString,
	'<': shellHeredoc,
	'\\': ( source, i ) => i + 2,
};

/**
 * A reader for a language of comments in code.
 *
 * @param {Object}                  tokens The language's scanner.
 * @param {function(string):number} start  Where the code starts in a file.
 * @return {function(string):string} The reader.
 */
const codeReader =
	( tokens, start = () => 0 ) =>
	( source ) => {
		const pieces = [];
		let i = start( source );
		while ( i < source.length ) {
			i = tokens[ source[ i ] ]?.( source, i, pieces ) ?? i + 1;
		}
		return overlay( source, pieces );
	};

/**
 * Blank fenced code, block-quote prefixes and link definitions. The inline
 * forms go in `scrub()`, because a comment can hold them too.
 *
 * @param {string} source The file.
 * @return {string} The prose lines.
 */
function markdownReader( source ) {
	let fence = '';
	return source
		.split( '\n' )
		.map( ( line ) => {
			const marker = /^\s*(`{3,}|~{3,})/.exec( line )?.[ 1 ][ 0 ] ?? '';
			if ( fence ) {
				fence = marker === fence ? '' : fence;
				return '';
			}
			fence = marker;
			return marker
				? ''
				: line
						.replace( /^\s*(?:> ?)+/, '' )
						.replace( /^\s*\[[^\]]+\]:\s+\S+.*$/, '' );
		} )
		.join( '\n' );
}

/**
 * The offset after a tag, nested gyrobase tags and quoted values included.
 *
 * @param {string} source The file.
 * @param {number} i      Offset of the `<`.
 * @return {number} Offset after its `>`.
 */
function tagEnd( source, i ) {
	for ( let at = i + 1; at < source.length; at++ ) {
		const ch = source[ at ];
		if ( '>' === ch ) {
			return at + 1;
		}
		if ( '"' === ch || "'" === ch ) {
			at = tagValueEnd( source, at ) - 1;
		} else if ( opensEvTag( source, at ) ) {
			at = tagEnd( source, at ) - 1;
		}
	}
	return source.length;
}

/**
 * The offset after a tag's quoted value, which may hold a gyrobase tag.
 *
 * @param {string} source The file.
 * @param {number} i      Offset of the opening quote.
 * @return {number} Offset after the closing quote.
 */
function tagValueEnd( source, i ) {
	for ( let at = i + 1; at < source.length; at++ ) {
		if ( source[ i ] === source[ at ] ) {
			return at + 1;
		}
		if ( opensEvTag( source, at ) ) {
			at = tagEnd( source, at ) - 1;
		}
	}
	return source.length;
}

/**
 * Does a gyrobase tag open here?
 *
 * @param {string} source The file.
 * @param {number} at     An offset.
 * @return {boolean} True at the `<` of an `<ev…`.
 */
function opensEvTag( source, at ) {
	return (
		'<' === source[ at ] &&
		'ev' === source.substr( at + 1, 2 ).toLowerCase()
	);
}

/** An element whose body is code rather than prose. */
const RAW_ELEMENT = /<(script|style|pre|code)\b/iy;

/**
 * Keep the text between tags and the bodies of comments. Every tag leaves a
 * CODE mark, so no rule matches across one; an evComment is prose only because
 * its tags are tags.
 *
 * @param {string} source The file.
 * @return {string} The prose lines.
 */
function htmlReader( source ) {
	const pieces = [];
	let i = 0;
	while ( i < source.length ) {
		const open = source.indexOf( '<', i );
		if ( -1 === open ) {
			pieces.push( [ i, source.slice( i ) ] );
			break;
		}
		pieces.push( [ i, source.slice( i, open ) ] );
		RAW_ELEMENT.lastIndex = open;
		const raw = RAW_ELEMENT.exec( source );
		if ( source.startsWith( '<!--', open ) ) {
			const close = source.indexOf( '-->', open );
			const end = -1 === close ? source.length : close;
			pieces.push( [ open + 4, source.slice( open + 4, end ) ] );
			i = end + 3;
		} else if ( raw ) {
			const close = new RegExp( `</${ raw[ 1 ] }\\s*>`, 'gi' );
			close.lastIndex = open;
			i = close.exec( source ) ? close.lastIndex : source.length;
		} else if ( /[a-z/!?]/i.test( source[ open + 1 ] ?? '' ) ) {
			pieces.push( [ open, CODE ] );
			i = tagEnd( source, open );
		} else {
			pieces.push( [ open, '<' ] );
			i = open + 1;
		}
	}
	return overlay( source, pieces );
}

/** Each file type's reader: file to prose, one line of output per line of input. */
const READERS = [
	[ /\.php$/, codeReader( PHP_TOKENS, ( s ) => phpResume( s, 0 ) ) ],
	[ /\.[cm]?jsx?$|\.tsx?$/, codeReader( JS_TOKENS ) ],
	[ /\.scss$/, codeReader( SCSS_TOKENS ) ],
	[ /\.css$/, codeReader( CSS_TOKENS ) ],
	[
		/\.sh$|\.local$|(^|\/)(pre-commit|pre-push|commit-msg)$/,
		codeReader( SHELL_TOKENS ),
	],
	[ /\.md$/, markdownReader ],
	[ /\.html?$/, htmlReader ],
];

/** Every path a reader claims, which is what a directory walk matches. */
const READABLE = new RegExp(
	READERS.map( ( [ pattern ] ) => pattern.source ).join( '|' )
);

/**
 * One line of prose, its code spans and URLs replaced by marks.
 *
 * @param {string} line A masked line.
 * @return {string} The line, whitespace collapsed.
 */
const scrub = ( line ) =>
	line
		.replace( /(`+).+?\1/g, CODE )
		.replace( /\bhttps?:\/\/[^\s)>\]'"]+/g, ( url ) =>
			/^https?:\/\/(?:www\.)?github\.com\//.test( url )
				? GITHUB_MARK
				: URL_MARK
		)
		.replace( /\]\((?!‹)[^)\s]*/g, `](${ URL_MARK }` )
		.replace( /’/g, "'" )
		.replace( /\s+/g, ' ' )
		.trim();

/**
 * The prose of a masked file, one entry per paragraph.
 *
 * @param {string} masked What a reader answered.
 * @return {Array<{text:string,lines:Array<[number,number]>}>} Each paragraph's
 *     joined text, with the `[ offset, line ]` each source line starts at.
 */
function paragraphs( masked ) {
	const segments = [];
	let segment = null;
	masked.split( '\n' ).forEach( ( raw, i ) => {
		const text = scrub( raw );
		if ( ! text || BLOCK_START.test( text ) ) {
			segment = null;
		}
		if ( ! text ) {
			return;
		}
		if ( ! segment ) {
			segment = { text: '', lines: [] };
			segments.push( segment );
		}
		const at = segment.text ? segment.text.length + 1 : 0;
		segment.lines.push( [ at, i + 1 ] );
		segment.text = segment.text ? `${ segment.text } ${ text }` : text;
	} );
	return segments;
}

/**
 * The phrases that keep a folded negative's own meaning: a rule that fires on
 * `no` leaves these alone wherever it ends. `match` covers a pattern running
 * past the word; `after` covers one that stops on it.
 */
const IDIOMS = 'longer|more|one|op|js|matter|doubt|need';
const KEEP_IDIOMS = [
	{ match: new RegExp( `\\bno[- ](?:${ IDIOMS })\\b`, 'i' ) },
	{ after: new RegExp( `^[- ](?:${ IDIOMS })\\b|^-`, 'i' ) },
];

/** The words before a `that` opening a statement, never a relative clause. */
const COMPLEMENTIZERS =
	'and|not|than|front|dry-run|basis|evidence|fact|proof|claim|sign|premise|assumption|invariant|merely|only|means?|meant|proves?|proved|shows?|showed|ensures?|ensured|guarantees?|asserts?|asserted|checks?|checked|confirms?|confirmed|verif(?:y|ies|ied)|says?|said|knows?|knew|sure|given|such|so|now|except|assumes?|assumed|implies|implied|requires?|required|expects?|expected|states?|stated|tests?|tested|holds?|believes?|notes?|noted|finds?|found|sees?|saw|see';

/**
 * Where `actually` and `really` carry a contrast that cutting them would lose:
 * after a negation, beside a word in capitals, in a noun clause asking what
 * holds, and in a sentence that states the contrast.
 */
const KEEP_CONTRAST = [
	{ before: /(?:\b(?:not|never|without|instead of)|n't) $/i },
	{ match: /^[A-Z]+$/ },
	{ after: /^ [A-Z]{2,}\b/ },
	{ after: /^[^.;:!?]{0,60}\. Without\b/ },
	{
		before: /\b(?:what|whatever|where|wherever|whichever|whether|how)\b(?: [^ .,;:!?]+){0,5} $/i,
	},
	{
		after: /^[^.;:!?]{0,60}(?:[,—–] not\b|\brather than\b|\binstead of\b)/i,
	},
	{
		before: /\bbut $|\b(?:in effect|real|production code)\b[^.;:!?]{0,60}$/i,
	},
];

/**
 * A possessive beside another in its clause borrows that one's noun. A copula
 * ahead of it stays a hit, because "the window is the boot's" has no parallel:
 * its subject is the noun it stands in for.
 */
const COPULA = '(?:is|are|was|were)';
const KEEP_PARALLEL = [
	{
		match: new RegExp( `^(?!${ COPULA }\\b)`, 'i' ),
		before: new RegExp(
			`(?:(?<!\\b(?:it|that|what|there|here|who|let))'s|\\b(?:its|their|our|your|his|her|whose))\\b[^.;:!?]{0,80}(?<!\\b${ COPULA } (?:still |also )?)$`,
			'i'
		),
	},
	{
		after: /^(?:,? (?:and|or|nor|not|never|but|else|then|rather than|than)(?: [\w§-]+){1,3}|, (?:a|an|the|each|every|one|this) [\w§-]+)'s(?=[.,;:)]|$)/i,
	},
];

/**
 * Every rule, one row each.
 *
 * `keep` lists a rule's carve-outs. Each names at least one of `before`, `match`
 * and `after`, regexes over the text ahead of the hit, the hit and the text
 * following it, or `wrapped`, true for a hit crossing a line break, and spares
 * the hit when every slot it names holds. `only` limits a rule to the paths it
 * matches. `just` has no row, because it also means "only" and "a moment ago",
 * and no pattern separates those from the dead use.
 *
 * @type {Array<{id:string,pattern:RegExp,message:string,keep?:Array<Object>,only?:RegExp}>}
 */
const RULES = [
	{
		id: 'folded-relative',
		pattern: /\b(?:which|that|whose) (?:no|none|nothing|nobody)\b/gi,
		message:
			'A negative folded into a relative clause: state the negative outright ("which every Code leaves unset").',
		keep: [
			...KEEP_IDIOMS,
			{
				match: /^that /i,
				before: new RegExp(
					`(?:\\b(?:${ COMPLEMENTIZERS })|,) $`,
					'i'
				),
			},
			{
				match: /^that (?:nothing|nobody)$/i,
				after: /^(?: [\w-]+){0,3} (?:is|are|was|were)\b/i,
			},
		],
	},
	{
		id: 'folded-contact',
		pattern:
			/\b(?:a|an|the|any|every|each|some) [\w-]+ (?:no [\w-]+|nothing|nobody) [a-z]+(?:s|ed)\b/gi,
		message:
			'A contact clause holding a negative: name the subject ("a request that every rule skips").',
		keep: [ ...KEEP_IDIOMS, { match: / (?:is|was|has)$/i } ],
	},
	{
		id: 'folded-subordinate',
		pattern:
			/\b(?:when|while|if|where|because|since|once|until|unless) (?:no|none)\b|\bas no [\w-]+ [a-z]+s\b|\b(?:when|while|if|where|because|since|as|once|until|unless) (?:nothing|nobody) (?:else |ever |yet |still )*(?:(?:can|will|would|could|may|might|should|must) [a-z]+|[a-z]+(?:s|ed)) (?:a|an|the|it|this|that|its|their|them|one|any)\b/gi,
		message:
			'A negative as the subject of a subordinate clause: say what holds ("only when every layer left it unset").',
		keep: [
			...KEEP_IDIOMS,
			{ match: / (?:is|was|has) \w+$/i },
			{ match: /^as no /i, before: /\bread(?:s|ing)? $/i },
		],
	},
	{
		id: 'folded-preposition',
		pattern:
			/\b(?:in|on|at|into|onto|to|from|under|against|through|by|of) (?:no|none of)\b/gi,
		message:
			'A negative folded into a preposition\'s object: say the negative outright ("is not counted in any column").',
		keep: [
			...KEEP_IDIOMS,
			{
				after: /^ (?:particular|means|way|time|avail|use|cost|return|event|(?:set )?order)\b/i,
			},
			{ before: /\bpulls? $/i },
		],
	},
	{
		id: 'is-no',
		pattern: /\b(?:is|are|was|were|reads as) (?:no|none)(?= [\w§])/gi,
		message: 'Clipped "is no X": write "is not an X".',
		keep: [
			...KEEP_IDIOMS,
			{ before: /\bthere $/i },
			{ match: /none$/i, after: /^ or\b/i },
			{
				after: /^ (?:help|substitute|protection|evidence|fault|place)\b/i,
			},
			{
				after: /^ (?:less|better|worse|bigger|larger|smaller|greater|wider|narrower|different|fewer|older|newer|earlier|later|sooner|faster|slower|shorter|cheaper|deeper|higher|lower)\b/i,
			},
		],
	},
	{
		id: 'possessive-noun',
		pattern:
			/\b(?:the|a|an|no|this|each|every|one) [\w-]+'s(?=[.,;:)]|$)|\b(?:is|are|was|were) (?:still |also )?[\w-]+'s(?=[.,;:)]|$)/gi,
		message: 'A possessive standing in for its noun: name the noun.',
		keep: [ { match: /\b(?:each|every|the) other's$/i }, ...KEEP_PARALLEL ],
	},
	{
		id: 'dropped-noun',
		pattern:
			/\b(?:is|are|was|were) ones? (?:the|a|an|this|that|each|every) [\w-]+ [a-z]+(?:s|ed)\b/gi,
		message: 'A dropped noun: name what "one" stands for.',
	},
	{
		id: 'arrow-chain',
		pattern: /→[^→.,;|]{1,60}→| -> [^.,;|]{1,60} -> /g,
		message: 'An arrow chain: write the sentence.',
		only: /\.md$/,
		keep: [
			{ wrapped: true },
			{ match: /\band\b|^→ \*\*[^*]+\*\* →$/ },
			{
				before: /\b(?:WP Admin|wp-admin|Admin|WordPress|Dashboard|Inspector|Settings|Appearance|DevTools) $/i,
			},
		],
	},
	{
		id: 'throat-clearing',
		pattern:
			/\b(?:it's|it is) worth noting\b|\bi should mention\b|\bit should be noted\b|\bneedless to say\b/gi,
		message: 'Throat-clearing: cut it and start at the verb.',
	},
	{
		id: 'dead-very',
		pattern: /\bvery\b/gi,
		message: 'A dead qualifier: cut "very".',
		keep: [
			{ before: /\b(?:the|these|those|this|that) $/i },
			{ after: /^-|^ (?:first|last|next|same|end|start)\b/i },
		],
	},
	{
		id: 'dead-quite',
		pattern: /\bquite\b/gi,
		message: 'A dead qualifier: cut "quite".',
	},
	{
		id: 'dead-rather',
		pattern: /\brather\b/gi,
		message: 'A dead qualifier: cut "rather".',
		keep: [ { after: /^ than\b/i }, { before: /(?:\bwould |'d )$/i } ],
	},
	{
		id: 'dead-really',
		pattern: /\breally\b/gi,
		message: 'A dead qualifier: cut "really".',
		keep: KEEP_CONTRAST,
	},
	{
		id: 'dead-actually',
		pattern: /\bactually\b/gi,
		message: 'A dead qualifier: cut "actually".',
		keep: KEEP_CONTRAST,
	},
	{
		id: 'dead-somewhat',
		pattern: /\bsomewhat\b/gi,
		message: 'A dead qualifier: cut "somewhat".',
	},
	{
		id: 'dead-fairly',
		pattern: /\bfairly\b/gi,
		message: 'A dead qualifier: cut "fairly".',
		keep: [ { after: /^[.,;:]/ } ],
	},
	{
		id: 'github-line',
		pattern: /‹github›\)? ?\(:\d+(?:-\d+)?\)/g,
		message:
			'A line number beside a GitHub link: put it in the URL as #L181 or #L84-L97.',
	},
];

/**
 * The source line a paragraph offset sits on.
 *
 * @param {Array<[number,number]>} lines  `[ offset, line ]` pairs.
 * @param {number}                 offset An offset in the paragraph.
 * @return {number} The line.
 */
const lineAt = ( lines, offset ) =>
	lines.findLast( ( [ start ] ) => start <= offset )[ 1 ];

/**
 * Does a carve-out spare this hit?
 *
 * @param {Object}                 rule            The rule.
 * @param {Object}                 paragraph       From `paragraphs()`.
 * @param {string}                 paragraph.text  The joined prose.
 * @param {Array<[number,number]>} paragraph.lines Where each line starts.
 * @param {Object}                 found           The match.
 * @return {boolean} True when every slot of some carve-out holds.
 */
function isKept( rule, { text, lines }, found ) {
	const end = found.index + found[ 0 ].length;
	const before = text.slice( 0, found.index );
	const after = text.slice( end );
	const wrapped = lineAt( lines, found.index ) !== lineAt( lines, end - 1 );
	return ( rule.keep ?? [] ).some(
		( slots ) =>
			( slots.before?.test( before ) ?? true ) &&
			( slots.match?.test( found[ 0 ] ) ?? true ) &&
			( slots.after?.test( after ) ?? true ) &&
			( ! slots.wrapped || wrapped )
	);
}

/**
 * Every hit in one file.
 *
 * @param {string}                  path Path to check.
 * @param {function(string):string} read The reader its type names.
 * @return {Array<string>} One report line per hit.
 */
function checkFile( path, read ) {
	const reports = [];
	const rules = RULES.filter( ( rule ) => rule.only?.test( path ) ?? true );
	for ( const paragraph of paragraphs(
		read( readFileSync( path, 'utf8' ) )
	) ) {
		for ( const rule of rules ) {
			for ( const found of paragraph.text.matchAll( rule.pattern ) ) {
				if ( isKept( rule, paragraph, found ) ) {
					continue;
				}
				const line = lineAt( paragraph.lines, found.index );
				reports.push(
					`${ path }:${ line }: [${ rule.id }] "${ found[ 0 ] }": ${ rule.message } ${ CARVE_OUT }`
				);
			}
		}
	}
	return reports;
}

/**
 * The files one command-line argument names.
 *
 * @param {string} arg One argv entry.
 * @return {IterableIterator<string>} Paths to check.
 */
function* expandArg( arg ) {
	if ( ! existsSync( arg ) ) {
		return;
	}
	if ( statSync( arg ).isDirectory() ) {
		yield* walkFiles( arg, {
			match: READABLE,
			exempt: isExempt,
		} );
	} else {
		yield arg;
	}
}

let failed = false;
for ( const arg of process.argv.slice( 2 ) ) {
	for ( const path of expandArg( arg ) ) {
		const read = READERS.find( ( [ pattern ] ) => pattern.test( path ) );
		if ( ! read || isExempt( path ) ) {
			continue;
		}
		for ( const report of checkFile( path, read[ 1 ] ) ) {
			process.stderr.write( `${ report }\n` );
			failed = true;
		}
	}
}
process.exit( failed ? 1 : 0 );
