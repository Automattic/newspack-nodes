/**
 * ShellNode — the anonymous, React-driven REPL parser node. A typed line becomes a
 * single positional Message (the substrate's only format) and is filled into
 * the sink (`_command_interpreter`); local builtins (`clear`, `debug_level`)
 * return a `{ kind: 'local', … }` signal for TopologyConsole to act on instead.
 *
 * Mirrors the verb vocabulary of PHP `class-shell.php` + the prior utils/shell.js
 * (ping / tell / send / send_eof / request / cmd + a bare-verb default). The
 * reply path is FROM=`_http/<ssePid>/<reply-node>`; typed input replies route
 * to `_output` (the Dumper). TO=`prefix(path)` (path defaults to `_http/{reader}`).
 */

import { Node, serializeArg } from './node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	LOCAL,
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
export function scanTokens( line ) {
	const tokens = [];
	let buf = '';
	let raw = '';
	let inQuote = null;
	let inToken = false;
	for ( let i = 0; i < line.length; i++ ) {
		const ch = line[ i ];
		if ( null !== inQuote ) {
			// Inside a quote, `\` escapes the next char (see serializeArg).
			if ( '\\' === ch && i + 1 < line.length ) {
				raw += ch + line[ i + 1 ];
				buf += line[ ++i ];
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
 * tokenize(), but each token is its RAW span, quote chars and escapes intact.
 * For TSL round-trips: the quote type carries interpolation semantics, so an
 * editor must reproduce the authored span verbatim, never re-quote it.
 *
 * @param {string} line Trimmed line.
 * @return {string[]} Raw spans, index-aligned with tokenize().
 */
export function tokenizeSpans( line ) {
	return scanTokens( line ).tokens.map( ( t ) => t.raw );
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
		if ( text.endsWith( '\\' ) ) {
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

export class ShellNode extends Node {
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
	}

	/**
	 * Parse + dispatch one line. Returns the local/error signal for the host to
	 * act on, or null when a Message was filled into the sink (or input empty).
	 *
	 * @param {string} line Raw REPL line.
	 * @return {Object|null} A `{ kind: … }` signal, or null.
	 */
	fill( line ) {
		this.counter++;
		const parsed = this.parse( line );
		if ( null === parsed ) {
			return null;
		}
		if ( Array.isArray( parsed ) ) {
			this.dispatch( parsed );
			return null;
		}
		// A local-builtin / error signal — hand it back to the host.
		return parsed;
	}

	/**
	 * Parse one typed line. Returns a local-signal object for builtins/errors,
	 * a positional Message array for everything to send, or null for empty input.
	 *
	 * @param {string} line Raw REPL line.
	 * @return {Object|Array|null} `{ kind: 'local'|'error', … }`, a Message, or null.
	 */
	parse( line ) {
		let raw = line || '';
		// Backslash splice first (bash: hi\ + bye = hibye), mirroring PHP.
		if ( raw.endsWith( '\\' ) && '' === this.quoteContinuation ) {
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
			return {
				kind: 'error',
				text: 'include is not supported in the browser shell',
			};
		}

		if ( 'clear' === verb ) {
			return { kind: 'local', name: 'clear' };
		}

		if ( 'echo' === verb ) {
			return { kind: 'local', name: 'echo', text: join( 0 ) };
		}

		if ( 'show_parse' === verb ) {
			this.showParse = ! this.showParse;
			return { kind: 'local', name: 'show_parse', on: this.showParse };
		}

		if ( 'status' === verb ) {
			return {
				kind: 'local',
				name: 'status',
				lines: this.statusLines.slice(),
			};
		}

		// `var name=value`: splits on the FIRST `=`; `:` names are reserved.
		if ( 'var' === verb ) {
			const assignment = join( 0 );
			const eq = assignment.indexOf( '=' );
			if ( -1 === eq ) {
				return { kind: 'error', text: 'var: expected name=value' };
			}
			const name = assignment.slice( 0, eq ).trim();
			const value = assignment.slice( eq + 1 ).trim();
			if ( '' === name ) {
				return { kind: 'error', text: 'var: empty name' };
			}
			if ( name.includes( ':' ) ) {
				return {
					kind: 'error',
					text: `var: invalid name '${ name }' (':' is reserved for read-only namespaces like config:)`,
				};
			}
			this.vars[ name ] = value;
			return null;
		}

		if ( 'debug_level' === verb ) {
			const arg = args[ 0 ] ?? '';
			const level = '' === arg ? null : parseInt( arg, 10 );
			if (
				null !== level &&
				( Number.isNaN( level ) || level < 0 || level > 2 )
			) {
				return { kind: 'error', text: 'usage: debug_level [0|1|2]' };
			}
			return { kind: 'local', name: 'debug_level', level };
		}

		// Undocumented skin builtins: emit a local signal for the host.
		if ( 'list_skins' === verb ) {
			return { kind: 'local', name: 'list_skins' };
		}
		if ( 'set_skin' === verb ) {
			const skin = join( 0 );
			if ( '' === skin ) {
				return { kind: 'error', text: 'usage: set_skin <name>' };
			}
			return { kind: 'local', name: 'set_skin', skin };
		}

		// `cd` navigates the path tree locally (no message); `..` walks up.
		if ( 'cd' === verb || 'chdir' === verb ) {
			this.path = this.cd( this.path, args[ 0 ] ?? '' );
			return null;
		}

		const message = newMessage();
		const to = args[ 0 ] ?? '';
		message[ FROM ] = this.replyFrom( names.OUTPUT );
		message[ TO ] = this.prefix( to );
		// LOCAL provenance taint — minted here, stripped at the wire (pack()).
		message[ LOCAL ] = true;

		if ( 'cmd' === verb || 'command' === verb || 'command_node' === verb ) {
			const name = args[ 1 ] ?? '';
			if ( ! to || ! name ) {
				return {
					kind: 'error',
					text: 'usage: cmd <path> <verb> [<args>]',
				};
			}
			message[ TYPE ] = TM_COMMAND;
			message[ VALUE ] = { name, arguments: args.slice( 2 ) };
			return this.stampNoreply( message );
		}

		if ( 'send' === verb || 'send_node' === verb ) {
			if ( ! to ) {
				return { kind: 'error', text: 'usage: send <path> <bytes>' };
			}
			message[ TYPE ] = TM_BYTESTREAM;
			// Line-terminate so line-oriented nodes don't merge sends.
			message[ VALUE ] = `${ join( 1 ) }\n`;
			return this.stampNoreply( message );
		}

		if ( 'request' === verb || 'request_node' === verb ) {
			if ( ! to ) {
				return { kind: 'error', text: 'usage: request <path> <args>' };
			}
			message[ TYPE ] = TM_REQUEST;
			message[ VALUE ] = join( 1 );
			return this.stampNoreply( message );
		}

		if ( 'tell' === verb || 'tell_node' === verb ) {
			if ( ! to ) {
				return { kind: 'error', text: 'usage: tell <path> <bytes>' };
			}
			message[ TYPE ] = TM_INFO;
			message[ VALUE ] = join( 1 );
			return this.stampNoreply( message );
		}

		if ( 'send_struct' === verb || 'send_struct_node' === verb ) {
			if ( ! to ) {
				return {
					kind: 'error',
					text: 'usage: send_struct <path> <json>',
				};
			}
			let value;
			try {
				value = JSON.parse( join( 1 ) );
			} catch ( e ) {
				return { kind: 'error', text: `send_struct: ${ e.message }` };
			}
			message[ TYPE ] = TM_STRUCT;
			message[ VALUE ] = value;
			return this.stampNoreply( message );
		}

		if ( 'send_eof' === verb ) {
			if ( ! to ) {
				return { kind: 'error', text: 'usage: send_eof <path>' };
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
					out += key.startsWith( 'config:' )
						? String( this.config[ key.slice( 7 ) ] ?? '' )
						: String( this.vars[ key ] ?? '' );
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
	 * Build a TM_COMMAND via this.command(...) (inherited from Node), stamp the
	 * Shell session's FROM/LOCAL provenance + the target TO (path), and fill
	 * it through this.sink. Mirrors Tachikoma::Nodes::Shell::send_command —
	 * callers issue commands as method calls instead of via parse().
	 *
	 * @param {string}   path Routing target (TO). Empty = local interpreter.
	 * @param {string}   name Command verb (e.g. 'connect_node').
	 * @param {string[]} args Positional argument tokens.
	 * @return {void}
	 */
	sendCommand( path, name, args = [] ) {
		const m = this.command( name, args );
		m[ FROM ] = this.replyFrom( names.OUTPUT );
		// `path` is RELATIVE to the cwd — prefix() joins them.
		m[ TO ] = this.prefix( path );
		m[ LOCAL ] = true;
		this.stampNoreply( m );
		this.dispatch( m );
	}

	// FROM = the bare reply node; `_sse:{pid}` wraps it into a private address.
	replyFrom( replyNode ) {
		return replyNode;
	}

	// Slash-join cwd with an extra path arg, dropping empty pieces.
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
		return message;
	}

	/**
	 * The single send chokepoint: announce the Message to the `onDispatch` tap,
	 * then fill it into the sink. Every outgoing Message — sendCommand, a parsed
	 * REPL line, a GUI gesture — routes through here so the tap sees them all.
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
	 * `got EOF while waiting for tokens` — report it and clear.
	 *
	 * @return {Object|null} An error signal, or null when nothing was pending.
	 */
	flushPending() {
		const pending = (
			this.quoteContinuation || this.lineContinuation
		).trim();
		this.quoteContinuation = '';
		this.lineContinuation = '';
		this.pendingQuote = '';
		if ( '' === pending ) {
			return null;
		}
		return {
			kind: 'error',
			text: `got EOF while waiting for tokens: ${ pending }`,
		};
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

	get name() {
		return this._name;
	}

	// The Shell is the unnamed REPL front-end; naming it is fatal.
	set name( value ) {
		throw new Error( 'Shell must not be named' );
	}

	// Instance accessor for the quote-aware tokenizer (Shell_Node::tokenize).
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

	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Anonymous, React-driven REPL parser.',
			arguments: [],
			commands: [],
		};
	}
}
