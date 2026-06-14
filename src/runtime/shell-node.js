/**
 * ShellNode — the anonymous, React-driven REPL parser node. A typed line becomes a
 * single positional Message (the substrate's only format) and is filled into
 * the sink (`_command_interpreter`); local builtins (`clear`, `debug_level`)
 * return a `{ kind: 'local', … }` signal for TopologyConsole to act on instead.
 *
 * Mirrors the verb vocabulary of PHP `class-shell.php` + the prior utils/shell.js
 * (ping / tell / send / send_eof / request / cmd + a bare-verb default). The
 * reply pivot is FROM=`_http/<ssePid>/<reply-node>`; typed input replies route
 * to `_output` (the Dumper). TO=`prefix(path)` (path defaults to `_http/{reader}`).
 */

import { Node } from './node';
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
 * Quote-aware tokenizer ('/"/`): splits on unquoted whitespace, strips the
 * quote chars; an empty quoted string still counts as a token. Mirrors PHP
 * Shell_Node::tokenize so verb/arg slicing matches byte-for-byte.
 *
 * @param {string} line Interpolated, trimmed line.
 * @return {string[]} Tokens with quote chars removed and runs collapsed.
 */
export function tokenize( line ) {
	const tokens = [];
	let buf = '';
	let inQuote = null;
	let inToken = false;
	for ( let i = 0; i < line.length; i++ ) {
		const ch = line[ i ];
		if ( null !== inQuote ) {
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
			continue;
		}
		if ( ' ' === ch || '\t' === ch ) {
			if ( inToken ) {
				tokens.push( buf );
				buf = '';
				inToken = false;
			}
			continue;
		}
		buf += ch;
		inToken = true;
	}
	if ( inToken ) {
		tokens.push( buf );
	}
	return tokens;
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

export class ShellNode extends Node {
	constructor() {
		super();
		// cwd: the node-path bare verbs route to by default. Settable by the host.
		this.path = '';
		// `var`-set values, read back by <name> interpolation (PHP Core::$var).
		this.vars = {};
		// Read-only namespace exposed via <config:foo> interpolation (PHP Core::$config).
		this.config = {};
		// Lines emitted by the local `status` builtin; host-populated.
		this.statusLines = [];
		// When true, parsed lines are reported back to the host for echoing.
		this.showParse = false;
		// Interactive REPLs want their command replies (default). A script/topology
		// loader sets this false so commands go out TM_NOREPLY — the interpreter then
		// suppresses replies that would otherwise dead-end. Mirrors PHP Shell_Node::$want_reply.
		this._wantReply = true;
		// Dispatch tap: invoked with every outgoing Message just before it fills
		// the sink. The UI sets this to observe graph-mutating commands (make_node
		// / connect_node / …) for the Reset Graph chip. Verb-agnostic — the Shell
		// only announces the dispatch; the consumer classifies.
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
		this.counter += 1;
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
		// Interpolate first so `<var>` can expand into leading whitespace (PHP order).
		const trimmed = this.interpolate( line || '' ).trim();
		if ( ! trimmed || '#' === trimmed[ 0 ] ) {
			return null;
		}
		const tokens = tokenize( trimmed );
		if ( 0 === tokens.length ) {
			return null;
		}
		const verb = tokens[ 0 ];
		const args = tokens.slice( 1 );
		// args[n] joined with single spaces, mirroring PHP implode(' ', slice).
		const join = ( from ) => args.slice( from ).join( ' ' );

		// `include` reads a topology file from disk in PHP — impossible in the browser.
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

		// `var name=value` (spaces around `=` optional, value may be empty or
		// multi-word). Splits on the FIRST `=`, matching the .tsl frontmatter
		// parser; `:` names are reserved for read-only namespaces like config:.
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

		// `cd` navigates the path tree locally (no message). `/` = browser-internal
		// graph; `/_http` = the HTTP boundary (HttpOut → /command → PHP HTTP_In);
		// `/_http/<worker>` = a worker; `..` walks up. Mirrors the cli's cd.
		if ( 'cd' === verb || 'chdir' === verb ) {
			this.path = this.cd( this.path, args[ 0 ] ?? '' );
			return null;
		}

		const message = newMessage();
		const to = args[ 0 ] ?? '';
		message[ FROM ] = this.replyFrom( names.OUTPUT );
		message[ TO ] = this.prefix( to );
		// LOCAL provenance taint — minted in this Shell. Stripped at the wire
		// (pack()), so it authorizes only the in-browser interpreter; the server verifies HMAC.
		message[ LOCAL ] = true;

		if ( 'ping' === verb ) {
			message[ TYPE ] = TM_PING;
			// Receiver bounces TO=FROM; VALUE is the send timestamp for RTT.
			message[ VALUE ] = Date.now() / 1000;
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
		if ( 'send' === verb || 'send_node' === verb ) {
			if ( ! to ) {
				return { kind: 'error', text: 'usage: send <path> <bytes>' };
			}
			message[ TYPE ] = TM_BYTESTREAM;
			// Line-terminate so line-oriented nodes don't merge sends.
			message[ VALUE ] = `${ join( 1 ) }\n`;
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
		if ( 'request' === verb || 'request_node' === verb ) {
			if ( ! to ) {
				return { kind: 'error', text: 'usage: request <path> <args>' };
			}
			message[ TYPE ] = TM_REQUEST;
			message[ VALUE ] = join( 1 );
			return this.stampNoreply( message );
		}
		if ( 'cmd' === verb || 'command' === verb || 'command_node' === verb ) {
			const name = args[ 1 ] ?? '';
			if ( ! to || ! name ) {
				return {
					kind: 'error',
					text: 'usage: cmd <path> <verb> [<args>]',
				};
			}
			message[ TYPE ] = TM_COMMAND;
			message[ VALUE ] = { name, arguments: join( 2 ) };
			return this.stampNoreply( message );
		}

		if ( 'pwd' === verb ) {
			// TO is the bare cwd (not prefixed); arguments echo the cwd.
			message[ TYPE ] = TM_COMMAND;
			message[ TO ] = this.path;
			message[ VALUE ] = {
				name: 'pwd',
				arguments: this.path,
			};
			return this.stampNoreply( message );
		}

		// Bare verb: TM_COMMAND at the cwd (path).
		message[ TYPE ] = TM_COMMAND;
		message[ TO ] = this.prefix( '' );
		message[ VALUE ] = { name: verb, arguments: join( 0 ) };
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
		let literal = null; // active single-quote or backtick span suppressing expansion.
		let i = 0;
		while ( i < line.length ) {
			const ch = line[ i ];
			if ( null !== literal ) {
				out += ch;
				if ( ch === literal ) {
					literal = null;
				}
				i += 1;
				continue;
			}
			if ( "'" === ch || '`' === ch ) {
				literal = ch;
				out += ch;
				i += 1;
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
			i += 1;
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

	// FROM = the bare reply node. When the cwd routes through `_sse:{pid}` that
	// session node wraps it into the private pivot `_http/_sse:{pid}/<reply-node>`;
	// otherwise (`_http/…`) it stays bare and replies broadcast.
	replyFrom( replyNode ) {
		return replyNode;
	}

	// Slash-join cwd with an extra path arg, dropping empty pieces (PHP prefix()).
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

	get name() {
		return this._name;
	}

	// The Shell is the unnamed REPL front-end — naming it would register a
	// command surface in the graph. Fatal so the rule can't be violated.
	set name( value ) {
		throw new Error( 'Shell must not be named' );
	}

	// Instance accessor for the quote-aware tokenizer (PHP Shell_Node::tokenize).
	tokenize( line ) {
		return tokenize( line );
	}

	/**
	 * Build a TM_COMMAND via this.command(...) (inherited from Node), stamp the
	 * Shell session's FROM/LOCAL provenance + the target TO (path), and fill
	 * it through this.sink. Mirrors Tachikoma::Nodes::Shell::send_command —
	 * callers issue commands as method calls instead of via parse().
	 *
	 * @param {string} path Routing target (TO). Empty = local interpreter.
	 * @param {string} name Command verb (e.g. 'connect_node').
	 * @param {string} args Positional argument string.
	 * @return {void}
	 */
	sendCommand( path, name, args = '' ) {
		const m = this.command( name, args );
		m[ FROM ] = this.replyFrom( names.OUTPUT );
		// `path` is RELATIVE to the cwd — prefix() joins them. This matches the
		// REPL's bare-verb dispatch (which uses prefix() too) and ensures
		// debug-overlay Inspector clicks honor the live cwd.
		m[ TO ] = this.prefix( path );
		m[ LOCAL ] = true;
		this.stampNoreply( m );
		this.dispatch( m );
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
