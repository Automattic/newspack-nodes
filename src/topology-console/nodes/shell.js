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

// First whitespace split: [head, trimmed-rest].
function splitFirst( s ) {
	const idx = s.search( /\s/ );
	if ( -1 === idx ) {
		return [ s, '' ];
	}
	return [ s.slice( 0, idx ), s.slice( idx + 1 ).trim() ];
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
		// Open messages-stream session pid; the reply pivot. Settable by the host.
		this.ssePid = null;
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

	// FROM=`_http/<ssePid>/<reply-node>` so the worker reply walks back here.
	replyFrom( replyNode ) {
		return `${ names.HTTP }/${ this.ssePid }/${ replyNode }`;
	}

	/**
	 * Parse one typed line. Returns a local-signal object for builtins/errors,
	 * a positional Message array for everything to send, or null for empty input.
	 *
	 * @param {string} line Raw REPL line.
	 * @return {Object|Array|null} `{ kind: 'local'|'error', … }`, a Message, or null.
	 */
	parse( line ) {
		const trimmed = ( line || '' ).trim();
		if ( ! trimmed ) {
			return null;
		}
		const parts = splitFirst( trimmed );
		const verb = parts[ 0 ];

		if ( 'clear' === verb ) {
			return { kind: 'local', name: 'clear' };
		}
		const rest = parts[ 1 ];
		if ( 'debug_level' === verb ) {
			const level = '' === rest ? null : parseInt( rest, 10 );
			if (
				null !== level &&
				( Number.isNaN( level ) || level < 0 || level > 2 )
			) {
				return { kind: 'error', text: 'usage: debug_level [0|1|2]' };
			}
			return { kind: 'local', name: 'debug_level', level };
		}

		const msg = newMessage();
		msg[ FROM ] = this.replyFrom( names.OUTPUT );
		// LOCAL provenance taint — minted in this Shell. Stripped at the wire
		// (pack()), so it authorizes only the in-browser CI; the server verifies HMAC.
		msg[ LOCAL ] = true;

		if ( 'ping' === verb ) {
			msg[ TYPE ] = TM_PING;
			msg[ TO ] = this.prefix( rest );
			// Receiver bounces TO=FROM; VALUE is the send timestamp for RTT.
			msg[ VALUE ] = Date.now() / 1000;
			return msg;
		}
		if ( 'tell' === verb || 'tell_node' === verb ) {
			const [ to, body ] = splitFirst( rest );
			if ( ! to ) {
				return { kind: 'error', text: 'usage: tell <path> <bytes>' };
			}
			msg[ TYPE ] = TM_INFO;
			msg[ TO ] = this.prefix( to );
			msg[ VALUE ] = body;
			return msg;
		}
		if ( 'send' === verb || 'send_node' === verb ) {
			const [ to, body ] = splitFirst( rest );
			if ( ! to ) {
				return { kind: 'error', text: 'usage: send <path> <bytes>' };
			}
			msg[ TYPE ] = TM_BYTESTREAM;
			msg[ TO ] = this.prefix( to );
			// Line-terminate so line-oriented nodes don't merge sends.
			msg[ VALUE ] = `${ body }\n`;
			return msg;
		}
		if ( 'send_eof' === verb ) {
			if ( ! rest ) {
				return { kind: 'error', text: 'usage: send_eof <path>' };
			}
			msg[ TYPE ] = TM_EOF;
			msg[ TO ] = this.prefix( rest );
			return msg;
		}
		if ( 'request' === verb || 'request_node' === verb ) {
			const [ to, body ] = splitFirst( rest );
			if ( ! to ) {
				return { kind: 'error', text: 'usage: request <path> <args>' };
			}
			msg[ TYPE ] = TM_REQUEST;
			msg[ TO ] = this.prefix( to );
			msg[ VALUE ] = body;
			return msg;
		}
		if ( 'cmd' === verb || 'command' === verb || 'command_node' === verb ) {
			const [ to, after ] = splitFirst( rest );
			const [ name, args ] = splitFirst( after );
			if ( ! to || ! name ) {
				return {
					kind: 'error',
					text: 'usage: cmd <path> <verb> [<args>]',
				};
			}
			msg[ TYPE ] = TM_COMMAND;
			msg[ TO ] = this.prefix( to );
			msg[ VALUE ] = { name, arguments: args, payload: '' };
			return msg;
		}

		// Bare verb: TM_COMMAND at the cwd (path).
		msg[ TYPE ] = TM_COMMAND;
		msg[ TO ] = this.prefix( '' );
		msg[ VALUE ] = { name: verb, arguments: rest, payload: '' };
		return msg;
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
