import { markLocal, readyToMint } from './command-auth';
import { Core } from './core';
import {
	FROM,
	TO,
	TYPE,
	KEY,
	VALUE,
	TM_COMMAND,
	TM_ERROR,
	TM_INFO,
	TM_REQUEST,
	newMessage,
	typeLabels,
} from './message';
import names from './reserved-node-names.json';

/**
 * One positional argument a node declares in its `nodeSchema()`.
 *
 * @typedef {Object} ArgumentSpec
 * @property {string}  name       Node property the token is assigned to.
 * @property {string}  [type]     `int`, `float`, `bool`; anything else is a string.
 * @property {*}       [default]  Value used when a later position went unfilled.
 * @property {boolean} [required] Throw when no token reaches this position.
 */

/**
 * What a subclass's static `nodeSchema()` returns, as far as this file reads it.
 *
 * @typedef {Object} NodeSchemaRecord
 * @property {ArgumentSpec[]} [arguments]     Positional argument specs, in order.
 * @property {string[]}       [registrations] Events `register()` will accept.
 */

/**
 * The static hook a subclass may declare. It belongs to the subclass, never to
 * `Node`, so the base reads it off `this.constructor` optionally.
 *
 * @typedef {Object} SchemaHook
 * @property {function(): NodeSchemaRecord} [nodeSchema] The subclass's schema.
 */

/** @typedef {typeof Node & SchemaHook} NodeClass */

/**
 * The name a stub carries: a node standing in for a class this runtime cannot
 * construct declares the class it STANDS FOR.
 *
 * @typedef {Object} ShellNamed
 * @property {string} [shellName] Class name TSL uses in the ctor's place.
 */

/** Longest FROM path `stampMessage()` builds before it drops the message. */
export const MAX_FROM_SIZE = 1024;

// Types whose VALUE is included in the dropMessage audit line.
const DROP_PAYLOAD_TYPES = TM_INFO | TM_REQUEST | TM_ERROR | TM_COMMAND;

/**
 * A node's outgoing targets as a list, whichever shape `target` is in —
 * `Node.target` is `string|string[]`, so every reader needs this and only one
 * should own it.
 *
 * @param {Object} node Any node (or node-shaped record).
 * @return {string[]} Its targets; empty when unset.
 */
export function targetsOf( node ) {
	return [].concat( node?.target ?? [] ).filter( Boolean );
}

/** What a redacted credential renders as (PHP Node::REDACTED). */
export const REDACTED = '<redacted>';

/**
 * Mask credentials in a value, mirroring PHP `Node::redact_secrets()` by the
 * one rule `Core.isSecretProperty()` owns. Two shapes carry them: a
 * secret-named key, and a `--auth_password=…` argument token, which is how the
 * Vault admin UI sends them. The name survives; only the value goes.
 *
 * @param {*} value Any VALUE, at any depth.
 * @return {*} The same shape with credential values masked.
 */
function redactSecrets( value ) {
	if ( Array.isArray( value ) ) {
		return value.map( redactSecrets );
	}
	if ( null !== value && 'object' === typeof value ) {
		const out = {};
		for ( const [ key, item ] of Object.entries( value ) ) {
			out[ key ] = Core.isSecretProperty( key )
				? REDACTED
				: redactSecrets( item );
		}
		return out;
	}
	if ( 'string' === typeof value && value.startsWith( '--' ) ) {
		const eq = value.indexOf( '=' );
		if ( -1 !== eq && Core.isSecretProperty( value.slice( 2, eq ) ) ) {
			return value.slice( 0, eq + 1 ) + REDACTED;
		}
	}
	return value;
}

/**
 * The base contract every runtime node honors: `fill( message )`.
 *
 * A node connects two ways — `sink`, the node reference `fill()` forwards to,
 * and `target`, the path stamped into `message[ TO ]` when TO is empty. The
 * rest of this class is the machinery every subclass inherits: the
 * registration/notify table, FROM stamping, rate-limited logging, and the
 * `dump_config` / `dump_node` serialization.
 */
export class Node {
	/**
	 * Builds the empty node: no sink, no target, zeroed stats, and the
	 * registration allow-list seeded from the subclass `nodeSchema()`.
	 */
	constructor() {
		this._name = '';
		this.sink = null;
		/**
		 * Where this node routes: one path, or many on a fan-out node. The
		 * base itself reads both shapes — `dumpConfig` branches on
		 * `Array.isArray`, `fill` guards with `typeof` — so a subclass
		 * assigning an array is honouring the contract, not breaking it.
		 *
		 * @type {string|string[]}
		 */
		this.target = '';
		this._counter = 0;
		this._bytesRead = 0;
		this._bytesWritten = 0;
		this._largestMsgSent = 0;
		this.registrations = {};
		this.setStateCache = {};
		this.debugState = 0;
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

	/**
	 * Store the token list verbatim. Anything but an array clears it, so a
	 * caller that hands over a raw line gets no arguments rather than one
	 * argument that is the whole line.
	 *
	 * @param {string[]} value Argument tokens as the shell tokenized them.
	 */
	set arguments( value ) {
		this._arguments = Array.isArray( value ) ? value : [];
	}

	/**
	 * Forward a message to the wired sink, addressing it to this node's
	 * `target` when the message carries no TO of its own.
	 *
	 * @param {Array} message The 7-field positional message, mutated in place.
	 */
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
		const ctor = /** @type {NodeClass} */ ( this.constructor );
		const events = ctor.nodeSchema?.().registrations ?? [];
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

	/**
	 * Notify `event` and cache the payload, so a listener registering later
	 * receives the current state instead of waiting for the next change.
	 *
	 * A scalar payload is a lifecycle state — the only shape PHP's
	 * `set_state( string, string )` can hold — and `debug_state` traces it. A
	 * structured payload is this runtime's React bridge instead, and stays
	 * untraced: `_output` publishes its transcript that way, so a trace line
	 * would land in the transcript and publish itself again.
	 *
	 * @param {string} event   Pre-declared event name on this node.
	 * @param {*}      payload Current state; rides as the TM_INFO VALUE.
	 */
	setState( event, payload = null ) {
		this.setStateCache[ event ] = payload;
		const scalar = null === payload || 'object' !== typeof payload;
		if ( scalar && ( this.debugState ?? 0 ) > 0 ) {
			const detail = null === payload ? '' : String( payload );
			this.stderr(
				`DEBUG: ${ event }${ '' !== detail ? ` ${ detail }` : '' }`
			);
		}
		this.notify( event, payload );
	}

	/**
	 * Deliver `payload` to every listener on `event`. A listener that answers
	 * false is dropped — that is how a stale registration retires itself.
	 *
	 * @param {string} event   Event name; an unseeded event notifies nobody.
	 * @param {*}      payload Closure argument, or the TM_INFO VALUE.
	 */
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

	/**
	 * Deliver one notification: to the registered closure, or — in node-name
	 * mode — as a TM_INFO message straight to the named node.
	 *
	 * @param {string} event    Event name.
	 * @param {string} listener Listener id; a node name in node-name mode.
	 * @param {*}      payload  Closure argument, or the TM_INFO VALUE.
	 * @return {*} False when the listener should be dropped: the named node is
	 *             gone, or the closure said so.
	 */
	_notifyRegistered( event, listener, payload ) {
		const cb = this.registrations[ event ]?.[ listener ];
		if ( 'function' === typeof cb ) {
			return cb( payload );
		}
		const target = this.registry.node( listener );
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

	/**
	 * Prepend `name` to the message's FROM path — the breadcrumb trail a
	 * TO=FROM reply walks back.
	 *
	 * @param {Array}  message The 7-field positional message, mutated on success.
	 * @param {string} name    Name to prepend; empty is a programming error.
	 * @return {boolean} False when the message was dropped instead of stamped.
	 */
	stampMessage( message, name ) {
		if ( '' === name ) {
			this.stderr(
				`ERROR: ${ this.constructor.name } stampMessage() called with empty name`
			);
			return false;
		}
		const from = message[ FROM ];
		const next = '' === from ? name : `${ name }/${ from }`;
		if ( next.length > MAX_FROM_SIZE ) {
			this.printLessOften(
				`ERROR: path exceeded ${ MAX_FROM_SIZE } bytes; dropping from: `,
				next
			);
			return false;
		}
		message[ FROM ] = next;
		return true;
	}

	/**
	 * Drop a message with a rate-limited audit line (PHP Node::drop_message).
	 *
	 * @param {Array}  message The 7-field positional message being discarded.
	 * @param {string} error   Reason; `NOT_AVAILABLE` prints without a WARNING.
	 */
	dropMessage( message, error ) {
		const type = message[ TYPE ];
		const labels = typeLabels( type );
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
			const redacted = redactSecrets( value );
			const valueStr =
				null !== redacted && 'object' === typeof redacted
					? JSON.stringify( redacted )
					: String( redacted );
			parts.push( `payload: ${ valueStr }` );
		}

		// Key on parts[0] (stable category); the tail prints once, unkeyed.
		const head = parts.shift();
		const tail = parts.length ? ' ' + parts.join( ' ' ) : '';
		this.printLessOften( head, tail );
	}

	/**
	 * Emit a stderr line tagged with this node's midfix, via Core's stderr.
	 *
	 * @param {?string} text Line to emit; nothing at all when empty or nullish.
	 */
	stderr( text ) {
		if ( '' === text || null === text || undefined === text ) {
			return;
		}
		Core.stderr( this.log_midfix( text ) );
	}

	/**
	 * Node-keyed rate-limited logging (per-node via log_midfix). Only `text`
	 * keys the throttle — see `Core.printLessOften`.
	 *
	 * @param {string}    text  Line to log; Core collapses the repeats.
	 * @param {...string} extra Variable tail printed beside it, never keyed.
	 */
	printLessOften( text, ...extra ) {
		Core.printLessOften( this.log_midfix( text ), ...extra );
	}

	/**
	 * Per-node mid-line tag (Node::log_midfix): `{name}: ` on each line.
	 *
	 * The tag is dropped when the process is already named after this node,
	 * which would otherwise say the name twice on every line.
	 *
	 * @param {?string} msg Message to tag; nullish returns the bare midfix.
	 * @return {string} Every line of `msg` tagged, or the midfix alone.
	 */
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
	 * Emit round-trippable config: make_node + set_sink? + connect_node lines.
	 *
	 * @return {string} TSL that rebuilds this node, each line newline-terminated.
	 */
	dumpConfig() {
		let out = commandLine(
			'make_node',
			this.shellClassName(),
			this.name,
			...this.arguments
		);

		const sinkName = this.sink && this.sink.name ? this.sink.name : '';
		const implicit = names.COMMAND_INTERPRETER === sinkName;
		if ( '' !== sinkName && ! implicit ) {
			out += commandLine( 'set_sink', this.name, sinkName );
		}

		if ( Array.isArray( this.target ) ) {
			for ( const owner of this.target ) {
				if ( owner ) {
					out += commandLine( 'connect_node', this.name, owner );
				}
			}
		} else if ( 'string' === typeof this.target && '' !== this.target ) {
			out += commandLine( 'connect_node', this.name, this.target );
		}

		return out;
	}

	/**
	 * The class name TSL calls this node — what `make_node` would name.
	 *
	 * `Node` suffix stripped; a stub declares the class it STANDS FOR, which is
	 * why this cannot just read the constructor.
	 *
	 * @return {string} The shell-facing class name.
	 */
	shellClassName() {
		const node = /** @type {Node & ShellNamed} */ ( this );
		return (
			node.shellName ||
			this.constructor.name.replace( /Node$/, '' ) ||
			this.constructor.name
		);
	}

	/**
	 * Build a TM_COMMAND, mark it LOCAL and sign it. Mirrors
	 * Tachikoma::Node::command, which likewise signs at build — available on
	 * every Node so the Shell and overlay callers issue commands without
	 * hand-building messages.
	 *
	 * Completing here (rather than leaving a separate mint step) is safe because
	 * LOCAL cannot leave the process: packed() slices to 7 fields and unpacked()
	 * rejects 8. The signature covers only the SEMANTICS — ts, name, arguments,
	 * nonce — so a caller may still rewrite TO/FROM afterwards, which the
	 * Shell and RemoteIpc both do.
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

	/**
	 * Messages this node has passed on. Leaf I/O nodes bump the byte/size
	 * stats; composites aggregate their children's.
	 *
	 * @return {number} Messages forwarded since construction.
	 */
	get counter() {
		return this._counter;
	}

	/**
	 * @param {number} v Messages forwarded.
	 */
	set counter( v ) {
		this._counter = v;
	}

	/**
	 * @return {number} Bytes this node has read off its source.
	 */
	get bytesRead() {
		return this._bytesRead;
	}

	/**
	 * @param {number} v Bytes read.
	 */
	set bytesRead( v ) {
		this._bytesRead = v;
	}

	/**
	 * @return {number} Bytes this node has written to its destination.
	 */
	get bytesWritten() {
		return this._bytesWritten;
	}

	/**
	 * @param {number} v Bytes written.
	 */
	set bytesWritten( v ) {
		this._bytesWritten = v;
	}

	/**
	 * @return {number} Size of the largest single message this node has sent.
	 */
	get largestMsgSent() {
		return this._largestMsgSent;
	}

	/**
	 * @param {number} v Size of the largest message sent.
	 */
	set largestMsgSent( v ) {
		this._largestMsgSent = v;
	}

	/**
	 * @return {string} The name this node is registered under; empty until one
	 *                  is assigned.
	 */
	get name() {
		return this._name;
	}

	/**
	 * The name table this node lives in; Core's unless told otherwise.
	 *
	 * An interpreter that owns a registry hands it to the nodes it makes, and
	 * those become invisible to every other registry — which is how an edit
	 * buffer and a live graph both hold a node called `firehose`.
	 *
	 * @return {Object} The registry.
	 */
	get registry() {
		return this._registry ?? Core.registry;
	}

	/**
	 * Put this node in another name table, before it has a name.
	 *
	 * @param {Object} registry The registry to join; setting it after the name
	 *                          would leave the node registered elsewhere.
	 */
	set registry( registry ) {
		if ( '' !== this._name ) {
			throw new Error( 'registry must be set before name' );
		}
		this._registry = registry;
	}

	/**
	 * Register this node under `name`, or rename it if it already has one.
	 *
	 * @param {string} name The new name; it must be free in this registry.
	 */
	set name( name ) {
		const registry = this.registry;
		const previous = this._name;
		if ( name !== previous && null !== registry.node( name ) ) {
			throw new Error(
				`node name collision: ${ name } already registered`
			);
		}
		this._name = name;
		if ( registry.node( previous ) === this ) {
			registry.renameNode( previous, name );
			return;
		}
		registry.registerNode( name, this );
	}

	/**
	 * Drop one listener from one event; an unknown pair is a no-op.
	 *
	 * @param {string} event    Event name.
	 * @param {string} listener Listener id given to `register()`.
	 */
	unregister( event, listener ) {
		if ( this.registrations[ event ] ) {
			delete this.registrations[ event ][ listener ];
		}
	}

	/**
	 * Node-name listeners keyed by event; closures excluded, empty omitted.
	 *
	 * @return {Object<string, string[]>} Listener node names, per event.
	 */
	registeredListeners() {
		/** @type {Object<string, string[]>} */
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

	/**
	 * Set the single string target (PHP Node::connect_node); override point.
	 *
	 * @param {string} target Path stamped into TO when a message carries none.
	 */
	connectNode( target ) {
		this.target = target;
	}

	/**
	 * Clear target (PHP Node::disconnect_node); Tee overrides to prune one.
	 *
	 * @param {string} _target Ignored here — the one target Tee would prune.
	 */
	disconnectNode( _target = '' ) {
		this.target = '';
	}

	/**
	 * Serializable state snapshot for `dump_node`; node refs render as '{...}'.
	 *
	 * @return {Object} Field names to their displayable values.
	 */
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

	/**
	 * Teardown. Order matters: own name LAST (in-flight lookups see null).
	 */
	removeNode() {
		this.registrations = {};
		this.setStateCache = {};
		this.sink = null;
		this.target = '';
		this.patron = null;
		// Cascade-unregister the sibling interpreter; avoids recycle collision.
		if ( this.interpreter && '' !== this.interpreter.name ) {
			this.interpreter.registry.unregisterNode( this.interpreter.name );
		}
		this.interpreter = null;
		if ( '' !== this.name ) {
			this.registry.unregisterNode( this.name );
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
	// Empty vanishes on tokenize; `#`/`;` change the LINE, `<` interpolates.
	if ( '' !== s && ! /[\s'"`\\#;<]/.test( s ) ) {
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

/**
 * One replayable TSL line from its tokens. A command line IS an argv — the verb,
 * the type, the name and the arguments are all just tokens, so every one of them
 * goes through the same quoting. `make_node Echo echo foo bar` reads as if `echo`
 * were the name and `foo bar` the arguments; the command's actual arguments are
 * all four. Mirror of PHP Node::command_line (public there: subclass
 * dump_config overrides call it; no JS node emits verb lines).
 *
 * @param {...string} tokens Tokens of the line, verb first.
 * @return {string} The quoted line, newline-terminated.
 */
function commandLine( ...tokens ) {
	return serializeArgs( tokens ) + '\n';
}

/**
 * THE bool parse for schema args and toggle verbs — the mirror of PHP
 * `Schema_Reflection::truthy()`. Exported because the PHP side names it as the
 * JS counterpart, and because a local re-spelling of this list is what let
 * `set_is_hub` accept `true`/`1` while rejecting `yes`/`on`.
 *
 * @param {string} token A raw argument token.
 * @return {boolean} Whether the token reads as true.
 */
export function truthy( token ) {
	return [ '1', 'true', 'yes', 'on' ].includes(
		String( token ).toLowerCase()
	);
}

// Coerce a raw token to its declared schema type; unknown types pass through.
function coerceArgument( token, type ) {
	switch ( type ) {
		case 'int':
			return parseInt( token, 10 );
		case 'float':
			return parseFloat( token );
		case 'bool':
			return truthy( token );
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
	const ctor = /** @type {NodeClass} */ ( node.constructor );
	const declared = ctor.nodeSchema?.().arguments || [];
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
