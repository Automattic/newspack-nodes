/**
 * ShellNode — the anonymous, React-driven REPL parser node. A typed line becomes a
 * single positional Message (the substrate's only format) and is filled into
 * the sink (`_command_interpreter`); builtins (`print`, `debug_level`) act and
 * emit their output through `_stdout`, returning nothing (ADR-13).
 *
 * Mirrors the verb vocabulary of PHP `class-shell.php` + the prior utils/shell.js
 * (ping / tell / send / send_eof / request / cmd + a bare-verb default). The
 * reply path is FROM=`_http/<ssePid>/<reply-node>`; typed input replies route
 * to `_output` (the Dumper). TO=`prefix(path)` (path defaults to `_http/{reader}`).
 */

import { markLocal } from './command-auth';
import { Core } from './core';
import { Node, serializeArg } from './node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	ID,
	KEY,
	TIMESTAMP,
	VALUE,
	TM_COMMAND,
	TM_PING,
	TM_INFO,
	TM_BYTESTREAM,
	TM_STRUCT,
	TM_EOF,
	TM_REQUEST,
	TM_NOREPLY,
} from './message';
import names from './reserved-node-names.json';

/**
 * Verb aliases the interpreter's dispatch table resolves — the ONE table the
 * static front-end applies on the tokenized verb (make/connect/disconnect and
 * the command family). Mirrors PHP Shell_Node::VERB_ALIASES.
 */
const VERB_ALIASES = {
	make: 'make_node',
	connect: 'connect_node',
	disconnect: 'disconnect_node',
	command: 'command_node',
	cmd: 'command_node',
};

/**
 * Shell BUILTINS: `var` sets shell state and `include` evals a file through
 * this same shell — neither ever becomes a message, so the static front-end
 * returns them as bare statements wherever they appear. Any other bare verb
 * inside a cwd is a command to that node, `make_node` included. Mirrors PHP
 * Shell_Node::BUILTIN_VERBS.
 */
const BUILTIN_VERBS = new Set( [ 'include', 'var' ] );

// `<name> [ <op> [ <value> ] ]` — the operator set of Shell3's `$H{'var'}`.
const VAR_GRAMMAR =
	/^([^\s=+\-*/.|]+(?:\.[^\s=+\-*/.|]+)*)\s*(\/\/=|\|\|=|[.+\-*/]=|\+\+|--|=)?([\s\S]*)$/;

/**
 * Per-quote-type escapes, following Shell3's string1/string2/string3
 * expansion. Double quotes expand sequences; single quotes and backticks stay
 * literal so a deferred `<token>` survives to its downstream binder. An
 * unlisted `\X` keeps both characters (Perl leaves it untouched too).
 */
const ESCAPES = {
	'"': {
		e: '\x1b',
		n: '\n',
		r: '\r',
		t: '\t',
		'"': '"',
		'\\': '\\',
		'<': '<',
		'>': '>',
	},
	"'": { "'": "'", '\\': '\\' },
	'`': { '`': '`', '\\': '\\' },
};

/**
 * The one tokenizer state machine ('/"/` + backslash escapes): splits on
 * unquoted whitespace; an empty quoted string still counts as a token. Yields
 * both forms per token — `value` (quote chars stripped, escapes resolved;
 * mirrors PHP Shell_Node::tokenize byte-for-byte) and `raw` (the span
 * verbatim, so quote TYPE survives: double quotes interpolate `<…>`, single
 * quotes/backticks defer them — see interpolate()).
 *
 * @param {string} line Trimmed line.
 * @return {{tokens: Array<{value: string, raw: string}>, openQuote: ?string}}
 *         Token pairs, plus the quote char of a run left open at EOL (or null).
 */
function scanTokens( line ) {
	const tokens = [];
	let buf = '';
	let raw = '';
	let inQuote = null;
	let inToken = false;
	for ( let i = 0; i < line.length; i++ ) {
		const ch = line[ i ];
		if ( null !== inQuote ) {
			// Escapes are quote-typed: only double quotes expand sequences.
			if ( '\\' === ch && i + 1 < line.length ) {
				const next = line[ ++i ];
				raw += ch + next;
				buf += ESCAPES[ inQuote ][ next ] ?? ch + next;
				continue;
			}
			raw += ch;
			if ( ch === inQuote ) {
				inQuote = null;
			} else {
				buf += ch;
			}
			continue;
		}
		// Shell3:411 string4 — `\X` is a literal X; a trailing `\` is skipped.
		if ( '\\' === ch && i + 1 < line.length ) {
			raw += ch + line[ i + 1 ];
			buf += line[ ++i ];
			inToken = true;
			continue;
		}
		// Shell3:303 — outside a quote, `#` comments out the rest.
		if ( '#' === ch ) {
			break;
		}
		if ( '"' === ch || "'" === ch || '`' === ch ) {
			inQuote = ch;
			inToken = true; // empty quoted string still counts as a token.
			raw += ch;
			continue;
		}
		if ( ' ' === ch || '\t' === ch ) {
			if ( inToken ) {
				tokens.push( { value: buf, raw } );
				buf = '';
				raw = '';
				inToken = false;
			}
			continue;
		}
		buf += ch;
		raw += ch;
		inToken = true;
	}
	if ( inToken ) {
		tokens.push( { value: buf, raw } );
	}
	return { tokens, openQuote: inQuote };
}

/**
 * Quote-aware tokenizer ('/"/`): splits on unquoted whitespace, strips the
 * quote chars; an empty quoted string still counts as a token. Mirrors PHP
 * Shell_Node::tokenize so verb/arg slicing matches byte-for-byte.
 *
 * @param {string} line Interpolated, trimmed line.
 * @return {string[]} Tokens with quote chars removed and runs collapsed.
 */
export function tokenize( line ) {
	return scanTokens( line ).tokens.map( ( t ) => t.value );
}

/**
 * Inverse of tokenize() for a SINGLE token: quote+escape a value so tokenize()
 * delivers it back as one intact token. Used by the message composer to send
 * JSON to `send_struct` without the caller hand-escaping it [#32]. With the
 * escape-aware tokenizer this is exactly serializeArg, so any value — including
 * one carrying every quote char — round-trips (never unrepresentable).
 *
 * @param {string} value The token to quote (e.g. a JSON string).
 * @return {string} The value quoted+escaped so tokenize() recovers it intact.
 */
export function quoteToken( value ) {
	return serializeArg( value );
}

/**
 * Split a typed line on unquoted `;` into statements (quotes shield interior
 * `;`). Mirrors PHP Shell_Node::split_statements for a single line.
 *
 * @param {string} line Raw line from the REPL input.
 * @return {string[]} Zero or more individual statements.
 */
export function splitStatements( line ) {
	const statements = [];
	let buf = '';
	let inQuote = null;
	for ( let i = 0; i < line.length; i++ ) {
		const ch = line[ i ];
		if ( null !== inQuote ) {
			// Keep `\`-escapes verbatim; an escaped quote must not close here.
			if ( '\\' === ch && i + 1 < line.length ) {
				buf += ch + line[ ++i ];
				continue;
			}
			buf += ch;
			if ( ch === inQuote ) {
				inQuote = null;
			}
			continue;
		}
		if ( '\\' === ch && i + 1 < line.length ) {
			buf += ch + line[ ++i ];
			continue;
		}
		// A `;` inside a comment tail must not split the statement.
		if ( '#' === ch ) {
			buf += line.slice( i );
			break;
		}
		if ( "'" === ch || '"' === ch || '`' === ch ) {
			inQuote = ch;
			buf += ch;
			continue;
		}
		if ( ';' === ch ) {
			const trimmed = buf.trim();
			if ( '' !== trimmed ) {
				statements.push( trimmed );
			}
			buf = '';
			continue;
		}
		buf += ch;
	}
	const tail = buf.trim();
	if ( '' !== tail ) {
		statements.push( tail );
	}
	return statements;
}

/**
 * splitStatements over a whole script, each statement carrying the 1-based
 * first physical line of its run — the only thing parseStatements needs that
 * splitStatements didn't already compute. Mirrors PHP
 * Shell_Node::split_statements_indexed (mid-quote newlines are token content).
 *
 * @param {string} script Raw TSL text.
 * @return {Array<{text: string, line: number}>} Indexed statement runs.
 */
function splitStatementsIndexed( script ) {
	const statements = [];
	let buf = '';
	let inQuote = null;
	let stmtLine = 0;
	let lineNo = 0;
	for ( const line of String( script ).split( '\n' ) ) {
		lineNo++;
		if ( null !== inQuote ) {
			// Mid-quote: the newline is token content, keep accumulating.
			buf += '\n';
		} else {
			const leading = line.trim();
			if ( '' === leading ) {
				continue;
			}
			if ( '#' === leading[ 0 ] ) {
				// Whole-line comment — don't scan for `;` inside it.
				statements.push( { text: leading, line: lineNo } );
				continue;
			}
		}
		for ( let i = 0; i < line.length; i++ ) {
			const ch = line[ i ];
			if ( null !== inQuote ) {
				// An escaped quote must not close the run.
				if ( '\\' === ch && i + 1 < line.length ) {
					buf += ch + line[ ++i ];
					continue;
				}
				buf += ch;
				if ( ch === inQuote ) {
					inQuote = null;
				}
				continue;
			}
			if ( '\\' === ch && i + 1 < line.length ) {
				if ( 0 === stmtLine ) {
					stmtLine = lineNo;
				}
				buf += ch + line[ ++i ];
				continue;
			}
			// A `;` inside a comment tail must not split the statement.
			if ( '#' === ch ) {
				buf += line.slice( i );
				break;
			}
			if ( "'" === ch || '"' === ch || '`' === ch ) {
				if ( 0 === stmtLine ) {
					stmtLine = lineNo;
				}
				inQuote = ch;
				buf += ch;
				continue;
			}
			if ( ';' === ch ) {
				const trimmed = buf.trim();
				if ( '' !== trimmed ) {
					statements.push( { text: trimmed, line: stmtLine } );
				}
				buf = '';
				stmtLine = 0;
				continue;
			}
			if ( 0 === stmtLine && ' ' !== ch && '\t' !== ch ) {
				stmtLine = lineNo;
			}
			buf += ch;
		}
		if ( null === inQuote ) {
			const tail = buf.trim();
			if ( '' !== tail ) {
				statements.push( { text: tail, line: stmtLine } );
			}
			buf = '';
			stmtLine = 0;
		}
	}
	// EOF mid-quote: buildStatement gets the tail and throws on the open quote.
	const tail = buf.trim();
	if ( '' !== tail ) {
		statements.push( { text: tail, line: stmtLine } );
	}
	return statements;
}

/**
 * A line continues only on an ODD run of trailing backslashes — an even run is
 * escaped literals (`a\\` is one backslash, a complete line). Mirrors PHP
 * Shell_Node::is_continuation.
 *
 * @param {string} line Statement text.
 * @return {boolean} True when the next line splices onto this one.
 */
function isContinuation( line ) {
	return 0 !== ( line.length - line.replace( /\\+$/, '' ).length ) % 2;
}

/**
 * Fold trailing-backslash continuations across the statement stream — the same
 * splice parse() performs, applied statelessly. The joined statement keeps the
 * FIRST physical line of its run. Mirrors PHP
 * Shell_Node::join_statement_continuations.
 *
 * @param {Array<{text: string, line: number}>} indexed Indexed statements.
 * @return {Array<{text: string, line: number}>} Continuation-joined statements.
 */
function joinStatementContinuations( indexed ) {
	const out = [];
	let acc = '';
	let accLine = 0;
	for ( const statement of indexed ) {
		if ( 0 === accLine ) {
			accLine = statement.line;
		}
		const { text } = statement;
		if ( isContinuation( text ) ) {
			acc += text.slice( 0, -1 );
			continue;
		}
		out.push( { text: acc + text, line: accLine } );
		acc = '';
		accLine = 0;
	}
	if ( '' !== acc ) {
		// Runtime parity: a dangling continuation at EOF fails loud.
		throw new Error(
			`got EOF while waiting for tokens at line ${ accLine }`
		);
	}
	return out;
}

/**
 * Tokenize one joined statement and resolve its verb alias + cwd into the
 * canonical `{ verb, values, spans, raw, line }` record — mirrors PHP
 * Shell_Node::build_statement. Returns null for a comment/blank or a cd/chdir
 * (which only mutates the throwaway shell's cwd). Reuses the ShellNode's own
 * cd()/prefix() so the static and runtime paths route identically.
 *
 * @param {ShellNode} shell The shared throwaway shell carrying the cwd.
 * @param {string}    text  One joined statement.
 * @param {number}    line  1-based first physical source line.
 * @return {?{verb: string, values: string[], spans: string[], raw: string, line: number}}
 *         The canonical statement record, or null for a comment/blank/cd.
 * @throws {Error} On an unterminated quote at end-of-input.
 */
function buildStatement( shell, text, line ) {
	if ( '' === text || '#' === text[ 0 ] ) {
		return null;
	}
	const scanned = scanTokens( text );
	if ( scanned.openQuote ) {
		throw new Error( `got EOF while waiting for tokens: ${ text.trim() }` );
	}
	if ( 0 === scanned.tokens.length ) {
		return null;
	}
	const tokenValues = scanned.tokens.map( ( t ) => t.value );
	const verb = VERB_ALIASES[ tokenValues[ 0 ] ] ?? tokenValues[ 0 ];

	if ( 'cd' === verb || 'chdir' === verb ) {
		shell.path = shell.cd( shell.path, tokenValues[ 1 ] ?? '' );
		return null;
	}
	const tokenSpans = scanned.tokens.map( ( t ) => t.raw );
	let values;
	let spans;
	if ( 'command_node' === verb ) {
		const path = shell.prefix( tokenValues[ 1 ] ?? '' );
		values = [ 'command_node', path, ...tokenValues.slice( 2 ) ];
		spans = [ 'command_node', path, ...tokenSpans.slice( 2 ) ];
	} else if ( BUILTIN_VERBS.has( verb ) || '' === shell.path ) {
		// Builtins and root-level bare verbs are not cwd-routed.
		values = [ verb, ...tokenValues.slice( 1 ) ];
		spans = [ verb, ...tokenSpans.slice( 1 ) ];
	} else {
		// A bare verb inside a cwd is a command to that node.
		values = [
			'command_node',
			shell.path,
			verb,
			...tokenValues.slice( 1 ),
		];
		spans = [ 'command_node', shell.path, verb, ...tokenSpans.slice( 1 ) ];
	}
	return {
		verb: values[ 0 ],
		values,
		spans,
		raw: spans.join( ' ' ).trim(),
		line,
	};
}

/**
 * The one static TSL statement front-end (JS side): split → join backslash
 * continuations → tokenize → resolve verb aliases + cwd, keeping BOTH token
 * forms. Mirrors PHP Shell_Node::parse_statements byte-for-byte and is
 * parity-pinned against it (tests/fixtures/statements). No side effects: no
 * interpolation, no vars, no node construction.
 *
 * Each statement is `{ verb, values, spans, raw, line }`: `verb` the canonical
 * verb; `values` the quote-stripped tokens (`values[0] === verb`, and for `cmd`
 * `values[1]` is the cwd-resolved path); `spans` the same tokens with quote
 * chars + escapes verbatim; `raw` the canonical single-line form; `line` the
 * 1-based first physical source line.
 *
 * @param {string} text Raw TSL text.
 * @return {Array<{verb: string, values: string[], spans: string[], raw: string, line: number}>}
 *         The canonical statement list, comments/blanks/cd dropped.
 * @throws {Error} On an unterminated quote at end-of-input.
 */
export function parseStatements( text ) {
	const shell = new ShellNode();
	const statements = [];
	for ( const joined of joinStatementContinuations(
		splitStatementsIndexed( text )
	) ) {
		const statement = buildStatement( shell, joined.text, joined.line );
		if ( null !== statement ) {
			statements.push( statement );
		}
	}
	return statements;
}

/**
 * Serialize an argument that may already BE authored TSL.
 *
 * A draft keeps raw spans, quote characters intact, because the quote type
 * carries interpolation semantics — double quotes interpolate `<…>`, single
 * quotes and backticks defer. Re-quoting a span would change what it MEANS, so
 * a value that already tokenizes to itself as one span is emitted verbatim.
 *
 * @param {string} value Raw span or plain value.
 * @return {string} The argument as it should appear in a TSL line.
 */
export function serializeDraftArg( value ) {
	const s = String( value );
	const scanned = scanTokens( s );
	const spans = scanned.tokens.map( ( t ) => t.raw );
	// @longform An UNBALANCED quote scans self-identical, so emitting it
	// verbatim corrupts the .tsl. A `;` survives inside a token but SPLITS the
	// statement it lands on, so a bare one must be quoted too. `#` cannot
	// reach the bare test at all — scanTokens breaks the token there — and is
	// listed with it because `serializeArg` must quote both for the same
	// reason: they change the LINE, not the token.
	const bare = 1 === spans.length && scanned.tokens[ 0 ]?.value === s;
	const stable =
		1 === spans.length &&
		spans[ 0 ] === s &&
		! scanned.openQuote &&
		! ( bare && /[#;]/.test( s ) );
	return stable ? s : serializeArg( s );
}

/**
 * The REPL front-end Node: `fill( message )` turns the typed line carried in a
 * TM_BYTESTREAM VALUE into positional Messages filled into the sink. It also
 * carries the shell state a line is
 * parsed against — the cwd, the `var` namespace, and any held continuation —
 * and doubles as the throwaway shell `parseStatements()` drives the static TSL
 * front-end with. Anonymous by contract: naming it throws.
 */
export class ShellNode extends Node {
	/**
	 * Build an unwired shell — empty cwd, no vars, replies wanted, nothing
	 * pending. The host supplies the rest after construction: `path`, `config`,
	 * `statusLines`, the `onDispatch` tap, and the `sink` the graph wires.
	 */
	constructor() {
		super();
		// cwd: node-path bare verbs route to by default. Set by the host.
		this.path = '';
		// `var`-set values, read back by <name> interpolation (PHP Core::$var).
		this.vars = {};
		// Read-only namespace via <config:foo> (PHP Core::$config).
		this.config = {};
		// Lines emitted by the local `status` builtin; host-populated.
		this.statusLines = [];
		// When true, parsed lines are reported back to the host for echoing.
		this.showParse = false;
		// Interactive REPLs want replies; a script/topology loader unsets it.
		this._wantReply = true;
		// Open-quote continuation (raw); resumes on the next line.
		this.quoteContinuation = '';
		// The open quote char while continuing ('' = none); drives the prompt.
		this.pendingQuote = '';
		// Backslash continuation: ONE trailing \<newline> splices with nothing.
		this.lineContinuation = '';
		// Dispatch tap: invoked with every outgoing Message before the sink.
		this.onDispatch = null;
		// The skins are the host's: it owns the stylesheet and the storage.
		this.host = {};
	}

	/**
	 * The one entry point (ADR-1): a TM_BYTESTREAM whose VALUE is the typed
	 * line or script. Splits it into statements, parses each, and fills the
	 * sink with whatever became a Message. Builtins act and emit through
	 * `stdout()`; nothing comes back (ADR-13). Port of PHP `Shell_Node::fill()`.
	 *
	 * The Shell stays unnamed and unroutable, so no message can ARRIVE here by
	 * routing: a caller either holds this reference or sinks into it.
	 *
	 * @param {Array} message Positional Message carrying the line in VALUE.
	 */
	fill( message ) {
		if ( ! this.sink ) {
			throw new Error( 'fill requires a wired sink' );
		}
		const type = message[ TYPE ];
		const value = message[ VALUE ];
		if ( TM_EOF === type ) {
			// Input closed mid-statement: report before draining.
			this.flushPending();
			message[ FROM ] = this.replyFrom( names.OUTPUT );
			message[ TO ] = this.path;
			this.sink.fill( message );
			return;
		}
		if ( ! ( type & TM_BYTESTREAM ) || 'string' !== typeof value ) {
			// Not REPL input; PHP passes it through rather than dropping it.
			this.sink.fill( message );
			return;
		}
		for ( const { text } of splitStatementsIndexed( value ) ) {
			const parsed = this.parse( text );
			if ( null === parsed ) {
				continue;
			}
			this.counter++;
			if ( '' === parsed[ KEY ] ) {
				parsed[ KEY ] = message[ KEY ];
			}
			this.dispatch( parsed );
		}
	}

	/**
	 * Parse one typed line into the positional Message it should send, or null
	 * when it produced none — a builtin that already acted, or empty input. An
	 * internal of `fill()`; nothing outside the node calls it (ADR-1).
	 *
	 * @param {string} line Raw REPL line.
	 * @return {Array|null} A positional Message, or null.
	 */
	parse( line ) {
		let raw = line || '';
		// Backslash splice first (bash: hi\ + bye = hibye), mirroring PHP.
		if ( isContinuation( raw ) && '' === this.quoteContinuation ) {
			this.lineContinuation += raw.slice( 0, -1 );
			return null;
		}
		if ( '' !== this.lineContinuation ) {
			raw = this.lineContinuation + raw;
			this.lineContinuation = '';
		}
		if ( '' !== this.quoteContinuation ) {
			raw = this.quoteContinuation + '\n' + raw;
			this.quoteContinuation = '';
		}
		// Settle comments first: interpolating an inert line warns spuriously.
		const trimmedRaw = raw.trim();
		if ( ! trimmedRaw || '#' === trimmedRaw[ 0 ] ) {
			return null;
		}
		// Interpolate first so `<var>` can expand into leading whitespace.
		const trimmed = this.interpolate( raw ).trim();
		if ( ! trimmed || '#' === trimmed[ 0 ] ) {
			return null;
		}
		const scanned = scanTokens( trimmed );
		if ( scanned.openQuote ) {
			// Tachikoma parity: continue on the next line; interpolate ONCE.
			this.quoteContinuation = raw;
			this.pendingQuote = scanned.openQuote;
			return null;
		}
		this.pendingQuote = '';
		const tokens = scanned.tokens.map( ( t ) => t.value );
		if ( 0 === tokens.length ) {
			return null;
		}
		const verb = tokens[ 0 ];
		const args = tokens.slice( 1 );
		// args[n] joined with single spaces, mirroring PHP implode(' ', slice).
		const join = ( from ) => args.slice( from ).join( ' ' );

		// `include` reads a topology file from disk — impossible in-browser.
		if ( 'include' === verb ) {
			this.stdout( 'include is not supported in the browser shell\n' );
			return null;
		}

		// PHP erases the terminal; in the browser the Dumper owns the display.
		if ( 'clear' === verb ) {
			Core.node( names.OUTPUT )?.clear();
			return null;
		}

		// Shell3:1363 — verbatim; the newline is the caller's. No `echo`.
		if ( 'print' === verb ) {
			this.stdout( join( 0 ) );
			return null;
		}

		if ( 'show_parse' === verb ) {
			this.showParse = ! this.showParse;
			this.stdout( `show_parse: ${ this.showParse ? 'on' : 'off' }\n` );
			return null;
		}

		if ( 'status' === verb ) {
			this.statusLines.forEach( ( l ) => this.stdout( `${ l }\n` ) );
			return null;
		}

		if ( 'var' === verb ) {
			return this.varCommand( join( 0 ) );
		}

		if ( 'debug_level' === verb ) {
			const arg = args[ 0 ] ?? '';
			const level = '' === arg ? null : parseInt( arg, 10 );
			if (
				null !== level &&
				( Number.isNaN( level ) || level < 0 || level > 2 )
			) {
				this.stdout( 'usage: debug_level [0|1|2]\n' );
				return null;
			}
			const dumper = Core.node( names.OUTPUT );
			if ( dumper?.setDebugLevel ) {
				// No argument toggles; PHP's `debug_level` does the same.
				const toggled = dumper.debugLevelRef.current > 0 ? 0 : 1;
				dumper.setDebugLevel( null !== level ? level : toggled );
				this.stdout(
					`debug_level: ${ dumper.debugLevelRef.current }\n`
				);
			}
			return null;
		}

		// Skins are the host's: it owns the stylesheet, the shell does not.
		if ( 'list_skins' === verb ) {
			this.host.listSkins?.();
			return null;
		}
		if ( 'set_skin' === verb ) {
			const skin = join( 0 );
			if ( '' === skin ) {
				this.stdout( 'usage: set_skin <name>\n' );
				return null;
			}
			this.host.setSkin?.( skin );
			return null;
		}

		// `cd` navigates the path tree locally (no message); `..` walks up.
		if ( 'cd' === verb || 'chdir' === verb ) {
			this.path = this.cd( this.path, args[ 0 ] ?? '' );
			return null;
		}

		const message = newMessage();
		const to = args[ 0 ] ?? '';
		// Shell3:2240-2242 — var scope; overriding FROM re-routes the reply.
		message[ FROM ] =
			this.vars[ 'message.from' ] || this.replyFrom( names.OUTPUT );
		message[ KEY ] = this.vars[ 'message.key' ] ?? '';
		message[ ID ] = this.vars[ 'message.id' ] ?? '';
		// A forged TIMESTAMP is a debugging tool; unset keeps the mint clock.
		if ( this.vars[ 'message.timestamp' ] ) {
			message[ TIMESTAMP ] = this.vars[ 'message.timestamp' ];
		}
		message[ TO ] = this.prefix( to );

		if ( 'cmd' === verb || 'command' === verb || 'command_node' === verb ) {
			const name = args[ 1 ] ?? '';
			if ( ! to || ! name ) {
				this.stdout( 'usage: cmd <path> <verb> [<args>]\n' );
				return null;
			}
			message[ TYPE ] = TM_COMMAND;
			message[ VALUE ] = { name, arguments: args.slice( 2 ) };
			return this.stampNoreply( message );
		}

		if ( 'send' === verb || 'send_node' === verb ) {
			if ( ! to ) {
				this.stdout( 'usage: send <path> <bytes>\n' );
				return null;
			}
			message[ TYPE ] = TM_BYTESTREAM;
			// Line-terminate so line-oriented nodes don't merge sends.
			message[ VALUE ] = `${ join( 1 ) }\n`;
			return this.stampNoreply( message );
		}

		if ( 'request' === verb || 'request_node' === verb ) {
			if ( ! to ) {
				this.stdout( 'usage: request <path> <args>\n' );
				return null;
			}
			message[ TYPE ] = TM_REQUEST;
			message[ VALUE ] = join( 1 );
			return this.stampNoreply( message );
		}

		if ( 'tell' === verb || 'tell_node' === verb ) {
			if ( ! to ) {
				this.stdout( 'usage: tell <path> <bytes>\n' );
				return null;
			}
			message[ TYPE ] = TM_INFO;
			message[ VALUE ] = join( 1 );
			return this.stampNoreply( message );
		}

		if ( 'send_struct' === verb || 'send_struct_node' === verb ) {
			if ( ! to ) {
				this.stdout( 'usage: send_struct <path> <json>\n' );
				return null;
			}
			let value;
			try {
				value = JSON.parse( join( 1 ) );
			} catch ( e ) {
				this.stdout( `send_struct: ${ e.message }\n` );
				return null;
			}
			message[ TYPE ] = TM_STRUCT;
			message[ VALUE ] = value;
			return this.stampNoreply( message );
		}

		if ( 'send_eof' === verb ) {
			if ( ! to ) {
				this.stdout( 'usage: send_eof <path>\n' );
				return null;
			}
			message[ TYPE ] = TM_EOF;
			return this.stampNoreply( message );
		}

		if ( 'ping' === verb ) {
			message[ TYPE ] = TM_PING;
			// Receiver bounces TO=FROM; VALUE is the send timestamp for RTT.
			message[ VALUE ] = Date.now() / 1000;
			return this.stampNoreply( message );
		}

		if ( 'pwd' === verb ) {
			// TO is the bare cwd (not prefixed); arguments echo the cwd.
			message[ TYPE ] = TM_COMMAND;
			message[ TO ] = this.path;
			message[ VALUE ] = {
				name: 'pwd',
				arguments: '' === this.path ? [] : [ this.path ],
			};
			return this.stampNoreply( message );
		}

		// Bare verb: TM_COMMAND at the cwd (path); args are the token tail.
		message[ TYPE ] = TM_COMMAND;
		message[ TO ] = this.prefix( '' );
		message[ VALUE ] = { name: verb, arguments: args };
		return this.stampNoreply( message );
	}

	/**
	 * `var [ <name> [ <op> [ <value> ] ] ]` — follows Shell3's var_assignment,
	 * mirroring PHP Shell_Node::var_command. Bare lists every var; a name alone
	 * prints its value and autovivifies it to empty (Shell3.pm:2715); `<name> =`
	 * with no value DELETES it (Shell3.pm:2839); else the operator set applies.
	 *
	 * @param {string} assignment The raw token tail.
	 * @return {Object|null} A local echo/error signal, or null.
	 */
	varCommand( assignment ) {
		// trimStart only: a trailing whitespace VALUE must reach the grammar.
		const line = assignment.replace( /^\s+/, '' );
		if ( '' === line.replace( /\s+$/, '' ) ) {
			const text = Object.keys( this.vars )
				.sort()
				.map(
					( n ) =>
						`${ n }=${ String( this.vars[ n ] ).replace(
							/\n$/,
							''
						) }\n`
				)
				.join( '' );
			if ( '' !== text ) {
				this.stdout( text );
			}
			return null;
		}

		const m = VAR_GRAMMAR.exec( line );
		if ( ! m ) {
			this.stdout( 'var: expected <name> [ <op> [ <value> ] ]\n' );
			return null;
		}
		const [ , name, op = '', rest = '' ] = m;
		// Shell3:2825 — a value TOKEN sets (even if blank); none deletes.
		const hasValue = '' !== rest;
		if ( name.includes( ':' ) ) {
			this.stdout(
				`var: invalid name '${ name }' (':' is reserved for read-only namespaces like config:)\n`
			);
			return null;
		}
		// ltrim only: tokenize stripped the edges, so the tail is content.
		const value = rest.replace( /^\s+/, '' );

		if ( '' === op ) {
			// Shell3:630 fatals on trailing junk where an operator belongs.
			if ( '' !== value.trim() ) {
				this.stdout(
					`var: unexpected token in assignment: ${ value }\n`
				);
				return null;
			}
			// Reading defines the key — Shell3's `$hash->{$name} //= q()`.
			this.vars[ name ] ??= '';
			const read = String( this.vars[ name ] );
			// Printed verbatim: an empty value prints nothing at all.
			if ( '' !== read ) {
				this.stdout( read );
			}
			return null;
		}
		return this.operate( name, op, value, hasValue );
	}

	/**
	 * Shell3's `operate()` / `operate_with_value()` over one var.
	 *
	 * @param {string}  name     Var name.
	 * @param {string}  op       One of `= .= += -= *= /= //= ||= ++ --`.
	 * @param {string}  value    Right-hand side, already stripped.
	 * @param {boolean} hasValue Whether a value token followed the operator;
	 *                           false selects the delete / `++` / `--` branch.
	 * @return {Object|null} A local error signal, or null.
	 */
	operate( name, op, value, hasValue ) {
		const exists = name in this.vars;
		const current = exists ? String( this.vars[ name ] ) : '';
		// JS prints an integral Number without a fractional part, as Perl does.
		const num = ( s ) => Number( parseFloat( s ) ) || 0;

		if ( ! hasValue ) {
			// Valueless: only these three exist; the rest are usage errors.
			if ( '=' === op ) {
				delete this.vars[ name ];
			} else if ( '++' === op ) {
				this.vars[ name ] = String( num( current ) + 1 );
			} else if ( '--' === op ) {
				this.vars[ name ] = String( num( current ) - 1 );
			} else {
				this.stdout( `var: bad arguments: ${ op }\n` );
				return null;
			}
			return null;
		}

		switch ( op ) {
			case '=':
				this.vars[ name ] = value;
				return null;
			case '.=':
				this.vars[ name ] = exists ? `${ current } ${ value }` : value;
				return null;
			case '//=':
				if ( ! exists ) {
					this.vars[ name ] = value;
				}
				return null;
			case '||=':
				if ( '' === current || '0' === current ) {
					this.vars[ name ] = value;
				}
				return null;
			case '/=':
				if ( 0 === num( value ) ) {
					this.stdout( 'var: division by zero\n' );
					return null;
				}
				this.vars[ name ] = String( num( current ) / num( value ) );
				return null;
			case '+=':
				this.vars[ name ] = String( num( current ) + num( value ) );
				return null;
			case '-=':
				this.vars[ name ] = String( num( current ) - num( value ) );
				return null;
			case '*=':
				this.vars[ name ] = String( num( current ) * num( value ) );
				return null;
			default:
				this.stdout( `var: invalid operator: ${ op }\n` );
				return null;
		}
	}

	/**
	 * Quote-aware single-tier interpolation (mirrors PHP Shell_Node::interpolate,
	 * runs before tokenizing). Outside quotes and inside double quotes: `<name>` →
	 * vars, `<config:foo>` → config, unknown → ''. Inside single quotes or
	 * backticks the `<…>` is left LITERAL (standard shell semantics) so a token
	 * can be deferred to a downstream binder — e.g. a Topic line writes
	 * `<config:logs_dir>/jobs.p'<partition>'`, expanding the dir now and handing
	 * the raw `<partition>` to Topic. Quote chars survive; tokenize() strips them.
	 *
	 * @param {string} line Raw line.
	 * @return {string} Interpolated line.
	 */
	interpolate( line ) {
		const token = /<([a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z_][a-zA-Z0-9_]*)?)>/y;
		let out = '';
		let literal = null; // active '/` span suppressing expansion.
		let i = 0;
		while ( i < line.length ) {
			const ch = line[ i ];
			if ( null !== literal ) {
				out += ch;
				if ( ch === literal ) {
					literal = null;
				}
				i++;
				continue;
			}
			// An escape pair passes through; tokenize() resolves it later.
			if ( '\\' === ch && i + 1 < line.length ) {
				out += ch + line[ i + 1 ];
				i += 2;
				continue;
			}
			// A comment tail is inert — copy it verbatim, expand nothing.
			if ( '#' === ch ) {
				return out + line.slice( i );
			}
			if ( "'" === ch || '`' === ch ) {
				literal = ch;
				out += ch;
				i++;
				continue;
			}
			if ( '<' === ch ) {
				token.lastIndex = i;
				const m = token.exec( line );
				if ( m ) {
					const key = m[ 1 ];
					if ( key.startsWith( 'config:' ) ) {
						out += String( this.config[ key.slice( 7 ) ] ?? '' );
					} else {
						// get_shared: undefined warns, defined-empty is silent.
						if ( ! ( key in this.vars ) ) {
							// Raw like Shell3's `print {*STDERR}` — no prefix.
							Core._stderr(
								`WARNING: use of uninitialized value <${ key }>\n`
							);
						}
						out += String( this.vars[ key ] ?? '' );
					}
					i += m[ 0 ].length;
					continue;
				}
			}
			out += ch;
			i++;
		}
		return out;
	}

	/**
	 * Resolve a relative/absolute path against the cwd (mirrors PHP Shell_Node::cd).
	 * `/` resets to the browser-local graph root; `/x` is absolute; `..` walks up;
	 * anything else appends. The result is TO-ready (no leading/trailing slash).
	 *
	 * @param {string} cwd  Current path.
	 * @param {string} path The `cd` argument.
	 * @return {string} The new cwd.
	 */
	cd( cwd, path ) {
		if ( '/' !== path && '' !== path && '/' === path[ 0 ] ) {
			cwd = path;
		} else if ( '/' === path ) {
			cwd = '';
		} else if ( '' !== path && /^\.\.\/?/.test( path ) ) {
			cwd = cwd.replace( /\/?[^/]+$/, '' );
			path = path.replace( /^\.\.\/?/, '' );
			cwd = this.cd( cwd, path );
		} else if ( '' !== path ) {
			cwd += '/' + path;
		}
		return cwd.replace( /^\/+/, '' ).replace( /\/+$/, '' );
	}

	/**
	 * The FROM this session stamps: the bare reply node, unwrapped. A private
	 * per-session address is `_sse:{pid}`'s job downstream, not the Shell's.
	 *
	 * @param {string} replyNode Name of the node the reply should land on.
	 * @return {string} The FROM path to stamp.
	 */
	replyFrom( replyNode ) {
		return replyNode;
	}

	/**
	 * Slash-join the cwd with a path argument, dropping empty pieces — how a
	 * cwd-relative token becomes the TO a message carries.
	 *
	 * @param {string} path Path relative to the cwd; '' yields the bare cwd.
	 * @return {string} The joined path.
	 */
	prefix( path ) {
		const parts = [];
		if ( '' !== this.path ) {
			parts.push( this.path );
		}
		if ( path ) {
			parts.push( path );
		}
		return parts.join( '/' );
	}

	/**
	 * When want_reply is off, OR TM_NOREPLY onto a TM_COMMAND (no-op otherwise).
	 * Mirrors PHP Shell_Node::stamp_noreply — mutates in place and returns the
	 * message so message-return branches can `return this.stampNoreply( message )`.
	 *
	 * @param {Array} message Message to stamp in place.
	 * @return {Array} The same message.
	 */
	stampNoreply( message ) {
		const type = message[ TYPE ] ?? 0;
		if ( ! this._wantReply && type & TM_COMMAND ) {
			message[ TYPE ] = type | TM_NOREPLY;
		}
		// The Shell's completion point: every parse branch ends here.
		return markLocal( message );
	}

	/**
	 * The single send chokepoint: announce the Message to the `onDispatch` tap,
	 * then fill it into the sink. Every outgoing Message routes through here,
	 * so the tap sees them all. An internal of `fill()` (ADR-1).
	 *
	 * @param {Array} message Positional Message to send.
	 * @return {void}
	 */
	dispatch( message ) {
		this.onDispatch?.( message );
		this.sink?.fill( message );
	}

	/**
	 * End-of-input gate: a held continuation at EOF is Tachikoma's
	 * `got EOF while waiting for tokens` — report it through `_stdout` and
	 * clear, as PHP's `flush_pending(): void` does.
	 */
	flushPending() {
		const pending = (
			this.quoteContinuation || this.lineContinuation
		).trim();
		this.quoteContinuation = '';
		this.lineContinuation = '';
		this.pendingQuote = '';
		if ( '' === pending ) {
			return;
		}
		this.stdout( `got EOF while waiting for tokens: ${ pending }\n` );
	}

	/**
	 * Emit a line as a Message into `_stdout`, bypassing `_output`: the Dumper
	 * renders MESSAGES, and a builtin's output is text. Mirrors PHP
	 * `Shell_Node::stdout()`.
	 *
	 * @param {string} text Line to print, newline included by the caller.
	 */
	stdout( text ) {
		const stdout = Core.node( names.STDOUT );
		if ( ! stdout ) {
			return;
		}
		const m = newMessage();
		m[ TYPE ] = TM_BYTESTREAM;
		m[ VALUE ] = text;
		stdout.fill( m );
	}

	/** True while a quote/backslash continuation holds an open statement. */
	hasPending() {
		return '' !== this.quoteContinuation || '' !== this.lineContinuation;
	}

	/**
	 * The continuation prompt while a statement is held: the open quote char
	 * (`'> `) or a bare `> ` for a backslash splice; '' when nothing pends.
	 *
	 * @return {string} Prompt text for the host to render.
	 */
	pendingPrompt() {
		if ( '' !== this.quoteContinuation ) {
			return `${ this.pendingQuote }> `;
		}
		return '' !== this.lineContinuation ? '> ' : '';
	}

	/**
	 * The node name, always the empty string the base constructor set — the
	 * setter below refuses every assignment.
	 *
	 * @return {string} The empty name.
	 */
	get name() {
		return this._name;
	}

	/**
	 * Refuses every name: the Shell is the unnamed REPL front-end, and naming a
	 * node registers it as a routable destination, which this one is not.
	 *
	 * @param {string} value The rejected name.
	 * @throws {Error} Always.
	 */
	set name( value ) {
		throw new Error( 'Shell must not be named' );
	}

	/**
	 * Instance accessor for the module-level quote-aware tokenizer, so a host
	 * holding only the shell can tokenize (mirrors PHP Shell_Node::tokenize).
	 *
	 * @param {string} line Interpolated, trimmed line.
	 * @return {string[]} Tokens with quote chars removed and runs collapsed.
	 */
	tokenize( line ) {
		return tokenize( line );
	}

	/**
	 * Accessor (Tachikoma Shell want_reply): interactive sessions reply; scripts /
	 * topology loads don't. Pass a bool to set; call with no arg to read.
	 *
	 * @param {?boolean} value New want_reply, or undefined/null to read.
	 * @return {boolean} The current want_reply.
	 */
	wantReply( value = null ) {
		if ( null !== value ) {
			this._wantReply = value;
		}
		return this._wantReply;
	}

	/**
	 * Console-palette entry. `Hidden` keeps the anonymous Shell out of the
	 * palette; it takes no positional configuration.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Anonymous, React-driven REPL parser.',
			arguments: [],
			commands: [],
		};
	}
}
