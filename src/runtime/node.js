import { Core } from './core';
import {
	FROM,
	TO,
	TYPE,
	KEY,
	VALUE,
	TM_INFO,
	newMessage,
	valueSize,
} from './message';
import names from './reserved-node-names.json';

export const MAX_FROM_SIZE = 1024;

export class Node {
	constructor() {
		this.name = '';
		this.sink = null;
		this.target = '';
		this.counter = 0;
		this.largestMsgSent = 0;
		this.registrations = {};
		this.setStateCache = {};
		this.patron = null;
		this.interpreter = null;
	}

	setName( name ) {
		if ( '' !== this.name ) {
			Core.unregisterNode( this.name );
		}
		if ( Core.node( name ) !== null ) {
			throw new Error(
				`node name collision: ${ name } already registered`
			);
		}
		this.name = name;
		Core.registerNode( name, this );
	}

	fill( message ) {
		if (
			'' === message[ TO ] &&
			'string' === typeof this.target &&
			this.target
		) {
			message[ TO ] = this.target;
		}
		this.counter += 1;
		const size = valueSize( message );
		if ( size > this.largestMsgSent ) {
			this.largestMsgSent = size;
		}
		if ( this.sink ) {
			this.sink.fill( message );
		}
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
			this.print_less_often(
				`ERROR: path exceeded ${ MAX_FROM_SIZE } bytes; dropping from: ${ next }`
			);
			return false;
		}
		message[ FROM ] = next;
		return true;
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
	print_less_often( text ) {
		Core.printLessOften( this.log_midfix( text ) );
	}

	print_least_often( text ) {
		Core.printLeastOften( this.log_midfix( text ) );
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
			this._dispatchListener(
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

	notify( event, payload = null ) {
		const listeners = this.registrations[ event ];
		if ( ! listeners ) {
			return;
		}
		for ( const listener of Object.keys( listeners ) ) {
			const keep = this._dispatchListener( event, listener, payload );
			if ( false === keep ) {
				delete this.registrations[ event ][ listener ];
			}
		}
	}

	setState( event, payload = null ) {
		this.setStateCache[ event ] = payload;
		this.notify( event, payload );
	}

	// Clear target (matches PHP Node::disconnect_node). Tee overrides to prune
	// one entry from its fan-out array.
	// eslint-disable-next-line no-unused-vars
	disconnectNode( target = '' ) {
		this.target = '';
	}

	// Emit the round-trippable config for this node — `make_node <Type> <name>
	// [<arguments>]`, a `set_sink` line when the sink isn't the default CI, and a
	// `connect_node` per target. Mirrors PHP Node::dump_config (the JS runtime
	// doesn't track invoked verbs, so there's no `cmd` replay line).
	dumpConfig() {
		let out = `make_node ${ this.constructor.name } ${ this.name }`;
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
		// Cascade-unregister the sibling CI so a name-recycle doesn't collide
		// with an orphan.
		if ( this.interpreter && '' !== this.interpreter.name ) {
			Core.unregisterNode( this.interpreter.name );
		}
		this.interpreter = null;
		if ( '' !== this.name ) {
			Core.unregisterNode( this.name );
			this.name = '';
		}
	}

	_dispatchListener( event, listener, payload ) {
		const cb = this.registrations[ event ]?.[ listener ];
		if ( 'function' === typeof cb ) {
			return cb( payload );
		}
		// Node-name mode: forward TM_INFO to named node.
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
		msg[ TO ] = listener;
		msg[ KEY ] = event;
		msg[ VALUE ] = payload;
		target.fill( msg );
		return true;
	}
}
