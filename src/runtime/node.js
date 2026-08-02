import { markLocal, readyToMint } from './command-auth';
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
	TM_UNTYPED,
	newMessage,
} from './message';
import names from './reserved-node-names.json';

export const MAX_FROM_SIZE = 1024;

// Human-readable type labels for the dropMessage audit (PHP type_names).
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
	[ TM_UNTYPED, 'TM_UNTYPED' ],
];
// Types whose VALUE is included in the dropMessage audit line.
const DROP_PAYLOAD_TYPES = TM_INFO | TM_REQUEST | TM_ERROR | TM_COMMAND;

export class Node {
	constructor() {
		this._name = '';
		this.sink = null;
		this.target = '';
		this._counter = 0;
		this._bytesRead = 0;
		this._bytesWritten = 0;
		this._largestMsgSent = 0;
		this.registrations = {};
		this.setStateCache = {};
		this.patron = null;
		this.interpreter = null;
		this._arguments = [];
		this.seedRegistrations();
	}

	/**
	 * Get/set the node's argument token list — the trivial Tachikoma getter/setter.
	 * It stores the token array and does NOT parse it. A node that wants positional
	 * config calls parseSchemaArgs() from its own `set arguments` override (the
	 * Schema_Reflection mirror), so a bare `make_node Foo` assigns nothing.
	 *
	 * @return {string[]} Last-set argument tokens.
	 */
	get arguments() {
		return this._arguments ?? [];
	}

	set arguments( value ) {
		this._arguments = Array.isArray( value ) ? value : [];
	}

	fill( message ) {
		if ( ! this.sink ) {
			throw new Error( 'fill requires a wired sink' );
		}
		if (
			'' === message[ TO ] &&
			'string' === typeof this.target &&
			this.target
		) {
			message[ TO ] = this.target;
		}
		this.counter++;
		this.sink.fill( message );
	}

	/**
	 * Seed the runtime registration allow-list from the subclass nodeSchema()'s
	 * `registrations` — the single source of valid events (mirrors PHP
	 * seed_registrations()). A node just declares its events; register() then
	 * rejects anything not seeded here.
	 */
	seedRegistrations() {
		const events = this.constructor.nodeSchema?.().registrations ?? [];
		for ( const event of events ) {
			this.registrations[ event ] = {};
		}
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
		// Node-name mode: deliver TM_INFO directly to the resolved node, no TO.
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

	// Drop a message with a rate-limited audit line (PHP Node::drop_message).
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

	// Emit a stderr line tagged with this node's midfix, via Core's stderr.
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

	// Node-keyed rate-limited logging (per-node via log_midfix).
	printLessOften( text ) {
		Core.printLessOften( this.log_midfix( text ) );
	}

	// Per-node mid-line tag (Node::log_midfix): `{name}: ` on each line.
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

	/**
	 * Build a TM_COMMAND, mark it LOCAL and sign it. Mirrors
	 * Tachikoma::Node::command, which likewise signs at build — available on
	 * every Node so Shell.sendCommand and overlay callers issue commands without
	 * hand-building messages.
	 *
	 * Completing here (rather than leaving a separate mint step) is safe because
	 * LOCAL cannot leave the process: packed() slices to 7 fields and unpacked()
	 * rejects 8. The signature covers only the SEMANTICS — ts, name, arguments,
	 * nonce — so a caller may still rewrite TO/FROM afterwards, which
	 * Shell.sendCommand and RemoteIpc both do.
	 *
	 * Returns null when there is no session yet, and asks for one. Signing is
	 * synchronous and cannot wait for /auth, so the caller holds instead — a poll
	 * skips the tick and carries it on the next one, by which time the re-auth
	 * this triggered has landed. Emitting unsigned would only earn a refusal.
	 *
	 * @param {string}   name Command verb (e.g. 'connect_node').
	 * @param {string[]} args Positional argument tokens (the verb classifies them).
	 * @return {?Array} A signed, LOCAL-marked Message, or null if unauthenticated.
	 */
	command( name, args = [] ) {
		// Fail loud like buildMessage: a string here would drop the args to [].
		if ( ! Array.isArray( args ) ) {
			throw new Error(
				`command args must be a token array, got ${ typeof args } for verb "${ name }"`
			);
		}
		if ( ! readyToMint() ) {
			return null;
		}
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = this.name;
		m[ TO ] = this.target;
		m[ VALUE ] = { name, arguments: args };
		return markLocal( m );
	}

	// Byte/size stats; leaf I/O nodes bump these, composites aggregate.
	get counter() {
		return this._counter;
	}
	set counter( v ) {
		this._counter = v;
	}
	get bytesRead() {
		return this._bytesRead;
	}
	set bytesRead( v ) {
		this._bytesRead = v;
	}
	get bytesWritten() {
		return this._bytesWritten;
	}
	set bytesWritten( v ) {
		this._bytesWritten = v;
	}
	get largestMsgSent() {
		return this._largestMsgSent;
	}
	set largestMsgSent( v ) {
		this._largestMsgSent = v;
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

	unregister( event, listener ) {
		if ( this.registrations[ event ] ) {
			delete this.registrations[ event ][ listener ];
		}
	}

	// Node-name listeners keyed by event; closures excluded, empty omitted.
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

	// Set the single string target (PHP Node::connect_node); override point.
	connectNode( target ) {
		this.target = target;
	}

	// Clear target (PHP Node::disconnect_node); Tee overrides to prune one.
	disconnectNode( _target = '' ) {
		this.target = '';
	}

	// Emit round-trippable config: make_node + set_sink? + connect_node lines.
	dumpConfig() {
		// Subclasses carry a `Node` suffix; the shell name strips it.
		const shellName =
			this.constructor.name.replace( /Node$/, '' ) ||
			this.constructor.name;
		let out = `make_node ${ shellName } ${ this.name }`;
		if ( this.arguments.length ) {
			out += ` ${ serializeArgs( this.arguments ) }`;
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

	// Serializable state snapshot for `dump_node`; node refs render as '{...}'.
	dumpNode() {
		const snapshot = { class: this.constructor?.name ?? 'Node' };
		for ( const key of Object.keys( this ) ) {
			const val = this[ key ];
			if ( 'sink' === key ) {
				snapshot.sink = val && val.name ? val.name : '';
				continue;
			}
			// `_foo` field with a public `foo` accessor: snapshot the public.
			if ( '_' === key[ 0 ] && key.slice( 1 ) in this ) {
				snapshot[ key.slice( 1 ) ] = this[ key.slice( 1 ) ];
				continue;
			}
			// Any reference to another node (patron, interpreter, sub-nodes).
			if ( val instanceof Node ) {
				snapshot[ key ] = '{...}';
				continue;
			}
			// Internal structures — not nodes, not display state.
			if ( 'registrations' === key || 'setStateCache' === key ) {
				snapshot[ key ] = '{...}';
				continue;
			}
			if ( 'function' === typeof val ) {
				continue;
			}
			snapshot[ key ] = val;
		}
		return snapshot;
	}

	// Teardown. Order matters: own name LAST (in-flight lookups see null).
	removeNode() {
		this.registrations = {};
		this.setStateCache = {};
		this.sink = null;
		this.target = '';
		this.patron = null;
		// Cascade-unregister the sibling interpreter; avoids recycle collision.
		if ( this.interpreter && '' !== this.interpreter.name ) {
			Core.unregisterNode( this.interpreter.name );
		}
		this.interpreter = null;
		if ( '' !== this.name ) {
			Core.unregisterNode( this.name );
			this._name = '';
		}
	}
}

/**
 * Quote+escape one token so the escape-aware tokenizer recovers it exactly: a
 * bare quote char or backslash is a tokenizer metachar too, not just whitespace
 * — quote on any, then escape the backslash and the wrapping `'`. Inverse of
 * tokenize(); mirrors PHP Node::serialize_args.
 *
 * @param {string} token The token to serialize.
 * @return {string} The token, quoted+escaped when it carries a metachar.
 */
export function serializeArg( token ) {
	const s = String( token );
	// An empty token would vanish on tokenize, so quote it too.
	if ( '' !== s && ! /[\s'"`\\]/.test( s ) ) {
		return s;
	}
	return "'" + s.replace( /\\/g, '\\\\' ).replace( /'/g, "\\'" ) + "'";
}

/**
 * Serialization anchor for a node's argument tokens (mirror of PHP
 * Node::serialize_args): the ONE place tokens re-join into a line.
 *
 * @param {string[]} tokens Argument tokens.
 * @return {string} Space-joined line, each token quoted+escaped as needed.
 */
function serializeArgs( tokens ) {
	return tokens.map( serializeArg ).join( ' ' );
}

// Coerce a raw token to its declared schema type; unknown types pass through.
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
 * coerced to the declared type. Opt-in — the base setter does not call it. A node with no
 * declared arguments is a no-op; excess tokens are ignored, missing optional tokens use
 * their schema defaults only when input supplied an earlier token, and a missing required
 * token throws even when the input is empty. Empty optional input preserves ctor defaults.
 *
 * @param {Node}     node A node whose ctor exposes a static nodeSchema().
 * @param {string[]} args Positional argument tokens (pre-split, quote-resolved).
 */
export function parseSchemaArgs( node, args ) {
	const declared = node.constructor.nodeSchema?.().arguments || [];
	if ( declared.length === 0 ) {
		return;
	}
	const tokens = Array.isArray( args ) ? args : [];
	for ( let i = 0; i < declared.length; i++ ) {
		const spec = declared[ i ];
		if (
			null === spec ||
			'object' !== typeof spec ||
			Array.isArray( spec )
		) {
			continue;
		}
		const name =
			null === spec.name || undefined === spec.name
				? ''
				: String( spec.name );
		const type = spec.type ?? 'string';
		if ( '' === name ) {
			throw new Error(
				`Invalid argument specification: missing name at position ${ i }`
			);
		}
		if ( ! Object.prototype.hasOwnProperty.call( node, name ) ) {
			throw new Error( `Invalid argument specification: ${ name }` );
		}
		if ( i < tokens.length ) {
			node[ name ] = coerceArgument( String( tokens[ i ] ), type );
		} else if ( tokens.length > 0 && 'default' in spec ) {
			node[ name ] = spec.default;
		} else if ( spec.required ) {
			throw new Error( `Missing required argument: ${ name }` );
		}
	}
}
