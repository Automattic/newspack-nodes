/**
 * Shell — the anonymous, React-driven REPL parser node. A typed line becomes a
 * single positional Message (the substrate's only format) and is filled into
 * the sink (`_command_interpreter`); local builtins (`clear`, `debug_level`)
 * return a `{ kind: 'local', … }` signal for TopologyConsole to act on instead.
 *
 * Mirrors the verb vocabulary of PHP `class-shell.php` + the prior utils/shell.js
 * (ping / tell / send / send_eof / request / cmd + a bare-verb default). The
 * reply pivot is FROM=`_http/<ssePid>/<reply-node>`; typed input replies route
 * to `_output` (the Dumper). TO=`prefix(path)` (path defaults to `_http/{reader}`).
 */

import { Node } from '../../runtime/node';
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
	TM_EOF,
	TM_REQUEST,
} from '../../runtime/message';
import names from '../../runtime/reserved-node-names.json';

/**
 * Quote-aware tokenizer ('/"/`): splits on unquoted whitespace, strips the
 * quote chars; an empty quoted string still counts as a token. Mirrors PHP
 * Shell::tokenize so verb/arg slicing matches byte-for-byte.
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
 * `;`). Mirrors PHP Shell::split_statements for a single line.
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

export class Shell extends Node {
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
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Anonymous, React-driven REPL parser.',
			arguments: [],
			commands: [],
		};
	}

	/**
	 * Single-tier interpolation: `<name>` → vars, `<config:foo>` → config, unknown → ''.
	 * Mirrors PHP Shell::interpolate (runs before tokenizing).
	 *
	 * @param {string} line Raw line.
	 * @return {string} Interpolated line.
	 */
	interpolate( line ) {
		return line.replace(
			/<([a-zA-Z_][a-zA-Z0-9_]*(?::[a-zA-Z_][a-zA-Z0-9_]*)?)>/g,
			( _match, key ) => {
				if ( key.startsWith( 'config:' ) ) {
					const cfgKey = key.slice( 7 );
					return String( this.config[ cfgKey ] ?? '' );
				}
				return String( this.vars[ key ] ?? '' );
			}
		);
	}

	// Instance accessor for the quote-aware tokenizer (PHP Shell::tokenize).
	tokenize( line ) {
		return tokenize( line );
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

	// FROM = the bare reply node. When the cwd routes through `_sse:{pid}` that
	// session node wraps it into the private pivot `_http/_sse:{pid}/<reply-node>`;
	// otherwise (`_http/…`) it stays bare and replies broadcast.
	replyFrom( replyNode ) {
		return replyNode;
	}

	/**
	 * Resolve a relative/absolute path against the cwd (mirrors PHP Shell::cd).
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

		// `var <name> = <value>`: reject `:` names (reserved for read-only namespaces).
		if ( 'var' === verb ) {
			const name = args[ 0 ] ?? '';
			const eq = args[ 1 ] ?? '';
			if ( '' === name || '=' !== eq ) {
				return null;
			}
			if ( name.includes( ':' ) ) {
				return {
					kind: 'error',
					text: `var: invalid name '${ name }' (':' is reserved for read-only namespaces like config:)`,
				};
			}
			this.vars[ name ] = join( 2 );
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

		const msg = newMessage();
		msg[ FROM ] = this.replyFrom( names.OUTPUT );
		// LOCAL provenance taint — minted in this Shell. Stripped at the wire
		// (pack()), so it authorizes only the in-browser CI; the server verifies HMAC.
		msg[ LOCAL ] = true;

		if ( 'ping' === verb ) {
			msg[ TYPE ] = TM_PING;
			msg[ TO ] = this.prefix( args[ 0 ] ?? '' );
			// Receiver bounces TO=FROM; VALUE is the send timestamp for RTT.
			msg[ VALUE ] = Date.now() / 1000;
			return msg;
		}
		if ( 'tell' === verb || 'tell_node' === verb ) {
			const to = args[ 0 ] ?? '';
			if ( ! to ) {
				return { kind: 'error', text: 'usage: tell <path> <bytes>' };
			}
			msg[ TYPE ] = TM_INFO;
			msg[ TO ] = this.prefix( to );
			msg[ VALUE ] = join( 1 );
			return msg;
		}
		if ( 'send' === verb || 'send_node' === verb ) {
			const to = args[ 0 ] ?? '';
			if ( ! to ) {
				return { kind: 'error', text: 'usage: send <path> <bytes>' };
			}
			msg[ TYPE ] = TM_BYTESTREAM;
			msg[ TO ] = this.prefix( to );
			// Line-terminate so line-oriented nodes don't merge sends.
			msg[ VALUE ] = `${ join( 1 ) }\n`;
			return msg;
		}
		if ( 'send_eof' === verb ) {
			const to = args[ 0 ] ?? '';
			if ( ! to ) {
				return { kind: 'error', text: 'usage: send_eof <path>' };
			}
			msg[ TYPE ] = TM_EOF;
			msg[ TO ] = this.prefix( to );
			return msg;
		}
		if ( 'request' === verb || 'request_node' === verb ) {
			const to = args[ 0 ] ?? '';
			if ( ! to ) {
				return { kind: 'error', text: 'usage: request <path> <args>' };
			}
			msg[ TYPE ] = TM_REQUEST;
			msg[ TO ] = this.prefix( to );
			msg[ VALUE ] = join( 1 );
			return msg;
		}
		if ( 'cmd' === verb || 'command' === verb || 'command_node' === verb ) {
			const to = args[ 0 ] ?? '';
			const name = args[ 1 ] ?? '';
			if ( ! to || ! name ) {
				return {
					kind: 'error',
					text: 'usage: cmd <path> <verb> [<args>]',
				};
			}
			msg[ TYPE ] = TM_COMMAND;
			msg[ TO ] = this.prefix( to );
			msg[ VALUE ] = { name, arguments: join( 2 ), payload: '' };
			return msg;
		}

		if ( 'pwd' === verb ) {
			// TO is the bare cwd (not prefixed); arguments echo the cwd.
			msg[ TYPE ] = TM_COMMAND;
			msg[ TO ] = this.path;
			msg[ VALUE ] = {
				name: 'pwd',
				arguments: this.path,
				payload: '',
			};
			return msg;
		}

		// Bare verb: TM_COMMAND at the cwd (path).
		msg[ TYPE ] = TM_COMMAND;
		msg[ TO ] = this.prefix( '' );
		msg[ VALUE ] = { name: verb, arguments: join( 0 ), payload: '' };
		return msg;
	}

	/**
	 * Build a TM_COMMAND via this.command(...) (inherited from Node), stamp the
	 * Shell session's FROM/LOCAL provenance + the target TO (path), and fill
	 * it through this.sink. Mirrors Tachikoma::Nodes::Shell::send_command —
	 * callers issue commands as method calls instead of via parse().
	 *
	 * @param {string} path Routing target (TO). Empty = local CI.
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
		this.sink?.fill( m );
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
			if ( this.sink ) {
				this.sink.fill( parsed );
			}
			return null;
		}
		// A local-builtin / error signal — hand it back to the host.
		return parsed;
	}
}
