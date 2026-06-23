import { Core } from './core';
import {
	FROM,
	TO,
	TYPE,
	KEY,
	VALUE,
	TM_BYTESTREAM,
	TM_EOF,
	TM_PING,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_INFO,
	TM_STRUCT,
	TM_REQUEST,
	TM_NOREPLY,
	newMessage,
} from './message';
import names from './reserved-node-names.json';

export const MAX_FROM_SIZE = 1024;

// Human-readable message-type labels for the dropMessage audit line (Perl/PHP
// Node type_names).
const TYPE_NAMES = [
	[ TM_BYTESTREAM, 'TM_BYTESTREAM' ],
	[ TM_EOF, 'TM_EOF' ],
	[ TM_PING, 'TM_PING' ],
	[ TM_COMMAND, 'TM_COMMAND' ],
	[ TM_RESPONSE, 'TM_RESPONSE' ],
	[ TM_ERROR, 'TM_ERROR' ],
	[ TM_INFO, 'TM_INFO' ],
	[ TM_STRUCT, 'TM_STRUCT' ],
	[ TM_REQUEST, 'TM_REQUEST' ],
	[ TM_NOREPLY, 'TM_NOREPLY' ],
];
// Types whose VALUE is included in the dropMessage audit line.
const DROP_PAYLOAD_TYPES = TM_INFO | TM_REQUEST | TM_ERROR | TM_COMMAND;

export class Node {
	constructor() {
		this._name = '';
		this.sink = null;
		this.target = '';
		this.counter = 0;
		this.largestMsgSent = 0;
		this.registrations = {};
		this.setStateCache = {};
		this.patron = null;
		this.interpreter = null;
		this._arguments = '';
	}

	/**
	 * Get/set the node's raw argument string — the trivial Tachikoma getter/setter.
	 * It stores the raw string and does NOT parse it. A node that wants positional
	 * config calls parseSchemaArgs() from its own `set arguments` override (the
	 * Schema_Reflection mirror), so a bare `make_node Foo` assigns nothing.
	 *
	 * @return {string} Last-set raw arguments string.
	 */
	get arguments() {
		return this._arguments ?? '';
	}

	set arguments( value ) {
		this._arguments = String( value ?? '' );
	}

	fill( message ) {
		if ( ! this.sink ) {
			throw new Error( 'Node.fill requires a wired sink' );
		}
		if (
			'' === message[ TO ] &&
			'string' === typeof this.target &&
			this.target
		) {
			message[ TO ] = this.target;
		}
		this.counter += 1;
		this.sink.fill( message );
	}

	get name() {
		return this._name;
	}

	set name( name ) {
		if ( '' !== this._name ) {
			Core.unregisterNode( this._name );
		}
		if ( null !== Core.node( name ) ) {
			throw new Error(
				`node name collision: ${ name } already registered`
			);
		}
		this._name = name;
		Core.registerNode( name, this );
	}

	/**
	 * Register a listener for a pre-declared `event` (throws otherwise).
	 * `cb === null` selects node-name dispatch; a cached setState payload
	 * is delivered immediately.
	 *
	 * @param {string}        event    Pre-declared event name on this node.
	 * @param {string}        listener Listener id; node-name mode needs a registered node name.
	 * @param {Function|null} cb       Closure dispatch when truthy; node-name dispatch when null.
	 */
	register( event, listener, cb = null ) {
		if ( ! ( event in this.registrations ) ) {
			throw new Error( `no such event: ${ event }` );
		}
		this.registrations[ event ][ listener ] = cb;
		if ( event in this.setStateCache ) {
			this._notifyRegistered(
				event,
				listener,
				this.setStateCache[ event ]
			);
		}
	}

	unregister( event, listener ) {
		if ( this.registrations[ event ] ) {
			delete this.registrations[ event ][ listener ];
		}
	}

	setState( event, payload = null ) {
		this.setStateCache[ event ] = payload;
		this.notify( event, payload );
	}

	notify( event, payload = null ) {
		const listeners = this.registrations[ event ];
		if ( ! listeners ) {
			return;
		}
		for ( const listener of Object.keys( listeners ) ) {
			const keep = this._notifyRegistered( event, listener, payload );
			if ( false === keep ) {
				delete this.registrations[ event ][ listener ];
			}
		}
	}

	_notifyRegistered( event, listener, payload ) {
		const cb = this.registrations[ event ]?.[ listener ];
		if ( 'function' === typeof cb ) {
			return cb( payload );
		}
		// Node-name mode: deliver TM_INFO directly to the resolved node. No TO —
		// stamping it re-routes through _router (across an SSE pivot it lands where
		// neither listener nor emitter exist, logging a spurious NOT_AVAILABLE).
		const target = Core.node( listener );
		if ( ! target ) {
			// Stale listener could fire on every notify — rate-limit.
			Core.printLessOften(
				`WARNING: ${ listener } forgot to unregister from ${ event } on ${ this.name }`
			);
			return false;
		}
		const msg = newMessage();
		msg[ TYPE ] = TM_INFO;
		msg[ FROM ] = this.name;
		msg[ KEY ] = event;
		msg[ VALUE ] = payload;
		target.fill( msg );
		return true;
	}

	// Node-name listeners (null-callback registrations) keyed by event; closures excluded, empty events omitted. Mirrors PHP registered_listeners() for dump_metadata.
	registeredListeners() {
		const out = {};
		for ( const [ event, listeners ] of Object.entries(
			this.registrations
		) ) {
			const listenerNames = [];
			for ( const [ listener, cb ] of Object.entries( listeners ) ) {
				if ( null === cb ) {
					listenerNames.push( listener );
				}
			}
			if ( listenerNames.length ) {
				out[ event ] = listenerNames;
			}
		}
		return out;
	}

	// Set the single string target (matches PHP Node::connect_node). The override
	// point for connection: Tee overrides to append to a fan-out array, RemoteLink
	// to point its composed SseIn — so `connect_node` can call this uniformly
	// instead of branching on the node type.
	connectNode( target ) {
		this.target = target;
	}

	// Clear target (matches PHP Node::disconnect_node). Tee overrides to prune
	// one entry from its fan-out array (hence the parity param the base ignores).
	disconnectNode( _target = '' ) {
		this.target = '';
	}

	// Emit the round-trippable config for this node — `make_node <Type> <name>
	// [<arguments>]`, a `set_sink` line when the sink isn't the default interpreter, and a
	// `connect_node` per target. Mirrors PHP Node::dump_config (the JS runtime
	// doesn't track invoked verbs, so there's no `cmd` replay line).
	dumpConfig() {
		// Subclasses carry a `Node` suffix; the shell name strips it.
		const shellName =
			this.constructor.name.replace( /Node$/, '' ) ||
			this.constructor.name;
		let out = `make_node ${ shellName } ${ this.name }`;
		if ( this.arguments ) {
			out += ` ${ this.arguments }`;
		}
		out += '\n';

		const sinkName = this.sink && this.sink.name ? this.sink.name : '';
		if ( '' !== sinkName && names.COMMAND_INTERPRETER !== sinkName ) {
			out += `set_sink ${ this.name } ${ sinkName }\n`;
		}

		if ( Array.isArray( this.target ) ) {
			for ( const owner of this.target ) {
				if ( owner ) {
					out += `connect_node ${ this.name } ${ owner }\n`;
				}
			}
		} else if ( 'string' === typeof this.target && '' !== this.target ) {
			out += `connect_node ${ this.name } ${ this.target }\n`;
		}

		return out;
	}

	// Teardown. Order matters: own name LAST, so in-flight Core.node() lookups
	// see null not a half-torn-down self. Mirrors PHP Node::remove_node.
	removeNode() {
		this.registrations = {};
		this.setStateCache = {};
		this.sink = null;
		this.target = '';
		this.patron = null;
		// Cascade-unregister the sibling interpreter so a name-recycle doesn't collide
		// with an orphan.
		if ( this.interpreter && '' !== this.interpreter.name ) {
			Core.unregisterNode( this.interpreter.name );
		}
		this.interpreter = null;
		if ( '' !== this.name ) {
			Core.unregisterNode( this.name );
			this._name = '';
		}
	}

	/**
	 * Build a TM_COMMAND message envelope. Mirrors Tachikoma::Node::command —
	 * available on every Node so Shell.sendCommand and overlay callers can
	 * issue commands without hand-building messages.
	 *
	 * @param {string} name Command verb (e.g. 'connect_node').
	 * @param {string} args Positional argument string (the verb parses it).
	 * @return {Array} A TM_COMMAND Message (the 7-field positional array).
	 */
	command( name, args = '' ) {
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = this.name;
		m[ VALUE ] = { name, arguments: args };
		return m;
	}

	stampMessage( message, name ) {
		if ( '' === name ) {
			// Programming error — unlikely to spam, won't recover.
			this.stderr(
				`ERROR: ${ this.constructor.name } stampMessage() called with empty name`
			);
			return false;
		}
		const from = message[ FROM ];
		const next = '' === from ? name : `${ name }/${ from }`;
		if ( next.length > MAX_FROM_SIZE ) {
			// Rate-limit: a routing cycle could trigger this per-message.
			this.printLessOften(
				`ERROR: path exceeded ${ MAX_FROM_SIZE } bytes; dropping from: ${ next }`
			);
			return false;
		}
		message[ FROM ] = next;
		return true;
	}

	// Drop a message with a rate-limited audit line (Perl/PHP Node::drop_message):
	// "WARNING: <error> - <types> [from: …] [to: …] [payload: …]". A NOT_AVAILABLE
	// drop uses printLessOften. NOT_AVAILABLE keeps no "WARNING:" prefix (matches
	// Perl). VALUE is included only for payload-bearing types; an object VALUE is
	// JSON-rendered (the substrate's structured-VALUE analogue of Perl's string PAYLOAD).
	dropMessage( message, error ) {
		const type = message[ TYPE ];
		const labels = [];
		for ( const [ bit, label ] of TYPE_NAMES ) {
			if ( type & bit ) {
				labels.push( label );
			}
		}
		const typeStr = labels.length ? labels.join( '|' ) : 'TYPE_UNKNOWN';

		const prefix =
			'NOT_AVAILABLE' === error
				? `${ error } - `
				: `WARNING: ${ error } - `;
		const parts = [ `${ prefix }${ typeStr }` ];
		if ( '' !== message[ FROM ] ) {
			parts.push( `from: ${ message[ FROM ] }` );
		}
		if ( '' !== message[ TO ] ) {
			parts.push( `to: ${ message[ TO ] }` );
		}
		const value = message[ VALUE ];
		if ( type & DROP_PAYLOAD_TYPES && '' !== value ) {
			const valueStr =
				null !== value && 'object' === typeof value
					? JSON.stringify( value )
					: String( value );
			parts.push( `payload: ${ valueStr }` );
		}
		const line = parts.join( ' ' );

		this.printLessOften( line );
	}

	// Emit a stderr line tagged with this node's midfix, via Core's stderr sink.
	// An already-dated line passes through Core verbatim (no double prefix).
	stderr( text ) {
		if ( '' === text || null === text || undefined === text ) {
			return;
		}
		if ( /^\d{4}-\d\d-\d\d/.test( text ) ) {
			Core.stderr( text );
			return;
		}
		Core.stderr( Core.log_prefix( this.log_midfix( text ) ) );
	}

	// Node-keyed rate-limited logging (per-node via log_midfix), routed through
	// Core's limiters so the dedup key + emitted line both carry this node's tag.
	printLessOften( text ) {
		Core.printLessOften( this.log_midfix( text ) );
	}

	// Per-node mid-line tag (Tachikoma Node::log_midfix): `{name}: ` on each line,
	// unless argv0 already starts with this node's name. null → the bare tag; a
	// message → tagged, chomped, + one trailing newline.
	log_midfix( msg = null ) {
		let midfix = '';
		if (
			'' !== this.name &&
			! new RegExp(
				'^' + this.name.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) + '\\b'
			).test( Core.argv0() )
		) {
			midfix = `${ this.name }: `;
		}
		if ( null === msg || undefined === msg ) {
			return midfix;
		}
		const chomped = msg.replace( /\n+$/, '' );
		return midfix + chomped.split( '\n' ).join( '\n' + midfix ) + '\n';
	}
}

// Coerce a raw string token to its declared schema type; unknown types pass through.
function coerceArgument( token, type ) {
	switch ( type ) {
		case 'int':
			return parseInt( token, 10 );
		case 'float':
			return parseFloat( token );
		case 'bool':
			return [ '1', 'true', 'yes', 'on' ].includes( token.toLowerCase() );
		default:
			return token;
	}
}

/**
 * The Schema_Reflection positional walk (PHP trait `parse_schema_args`): assign each
 * token of `args` to its matching declared `nodeSchema().arguments` property on `node`,
 * coerced to the declared type. Opt-in — the base setter does not call it. No-ops on an
 * empty string or a node with no declared arguments; excess tokens are ignored; missing
 * optional tokens fall to their schema default.
 *
 * @param {Node}   node A node whose ctor exposes a static nodeSchema().
 * @param {string} args Raw positional argument string.
 */
export function parseSchemaArgs( node, args ) {
	const raw = String( args ?? '' );
	if ( '' === raw ) {
		return;
	}
	const declared = node.constructor.nodeSchema?.().arguments || [];
	const tokens = raw.trim().split( /\s+/ );
	for ( let i = 0; i < declared.length; i++ ) {
		const spec = declared[ i ];
		const { name, type = 'string' } = spec;
		if ( ! ( name in node ) ) {
			continue;
		}
		if ( i < tokens.length ) {
			node[ name ] = coerceArgument( tokens[ i ], type );
		} else if ( 'default' in spec ) {
			node[ name ] = spec.default;
		}
	}
}
