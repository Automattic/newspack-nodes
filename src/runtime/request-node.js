/**
 * RequestNode — a node that mints ONE command and awaits its reply.
 *
 * The reply is addressed, not correlated: `command()` stamps `FROM = this.name`,
 * the server replies `TO = FROM`, and the reply lands here. Because this node
 * carries exactly one in-flight command, the message that arrives IS the answer
 * to it — there is nothing to tell apart, so no op-id, no KEY, and no Map keyed
 * by either. The single continuation below is a node being busy with its one
 * job, not a correlation table: give a second concern its own node.
 *
 * Asked for a second command while busy, it QUEUES rather than correlates —
 * the queued one is not minted until the outstanding reply lands, so there is
 * still exactly one command in flight and still nothing to tell apart.
 *
 * Emits through `_http` (via its sink), so a request minted during the Router's
 * TIMER notify rides the same lock/flush bracket as everything else that tick —
 * batching stays free.
 *
 *   const n = interpreter.makeNode( 'Request', 'topologies:save' );
 *   n.target = `${ names.HTTP }/topologies`;
 *   await n.request( 'save', [ name, tsl ] );
 */

import { Node } from './node';
import { ensureSession } from './command-auth';
import { TYPE, VALUE, TM_ERROR } from './message';

// A request that never draws a reply must not wedge its caller forever.
const TIMEOUT_MS = 30000;

/**
 * The TM_ERROR payload as a readable string.
 *
 * @param {*} payload The reply's VALUE.payload.
 * @return {string} A human-readable message.
 */
function errorText( payload ) {
	if ( 'string' === typeof payload && payload.length > 0 ) {
		return payload.trim();
	}
	if ( payload && 'string' === typeof payload.message ) {
		return payload.message;
	}
	return 'Operation failed';
}

export class RequestNode extends Node {
	// Hook-mounted infrastructure, not an operator's canvas drop.
	static isSystemNode = true;

	constructor() {
		super();
		// The ONE outstanding continuation; null when idle.
		this._pending = null;
		this._timer = null;
		// Commands asked for while busy; minted one at a time, in order.
		this._queue = [];
	}

	/**
	 * Mint the command and wait for the reply addressed back here.
	 *
	 * @param {string}   verb Verb name.
	 * @param {string[]} args Token array.
	 * @return {Promise<*>} The reply payload; rejects on TM_ERROR or timeout.
	 */
	request( verb, args = [] ) {
		return new Promise( ( resolve, reject ) => {
			this._queue.push( { verb, args, resolve, reject } );
			this._next();
		} );
	}

	/**
	 * Mint the head of the queue, if the node is idle.
	 *
	 * A view node that cannot mint yet just skips the tick and tries the next
	 * one; a caller holding a Promise has no next tick, so this waits out the
	 * session instead — the same wait the old `CommandClient.send()` did. The
	 * ready case stays synchronous so the mint lands inside the drain tick's
	 * lock/flush bracket and still batches.
	 */
	_next() {
		if ( this._pending || 0 === this._queue.length ) {
			return;
		}
		const head = this._queue.shift();
		this._pending = head;
		const m = this.command( head.verb, head.args );
		if ( null === m ) {
			this._pending = null;
			this._queue.unshift( head );
			ensureSession().then( () => this._mintAfterSession( head ) );
			return;
		}
		this._send( m, head );
	}

	/**
	 * Mint `head` once the session has landed, unless it went in the meantime.
	 *
	 * @param {Object} head The queued continuation this wait belongs to.
	 */
	_mintAfterSession( head ) {
		if ( this._queue[ 0 ] !== head ) {
			return; // settled or dropped while we waited
		}
		this._queue.shift();
		this._pending = head;
		const m = this.command( head.verb, head.args );
		if ( null === m ) {
			this._settle( ( p ) =>
				p.reject( new Error( 'not authenticated' ) )
			);
			return;
		}
		this._send( m, head );
	}

	/**
	 * Arm the reply deadline and put the command on the wire.
	 *
	 * @param {Array}  m    The minted command Message.
	 * @param {Object} head The continuation it answers.
	 */
	_send( m, head ) {
		this._timer = setTimeout( () => {
			this._settle( ( p ) =>
				p.reject( new Error( `${ head.verb } timed out` ) )
			);
		}, TIMEOUT_MS );
		this.counter++;
		this.sink.fill( m );
	}

	// The reply to our one command; whatever arrives here is that answer.
	fill( message ) {
		this.counter++;
		if ( ! this._pending ) {
			return; // a late reply after a timeout; nothing is waiting
		}
		const payload = message[ VALUE ]?.payload ?? message[ VALUE ];
		if ( message[ TYPE ] & TM_ERROR ) {
			this._settle( ( p ) =>
				p.reject( new Error( errorText( payload ) ) )
			);
			return;
		}
		this._settle( ( p ) => p.resolve( payload ) );
	}

	removeNode() {
		const gone = new Error( `${ this.name } was removed` );
		const queued = this._queue.splice( 0 );
		this._settle( ( p ) => p.reject( gone ) );
		queued.forEach( ( p ) => p.reject( gone ) );
		super.removeNode();
	}

	/**
	 * Clear the continuation, then hand it to `run` — cleared first so a
	 * handler that requests again from its own `.then` is not refused.
	 *
	 * @param {Function} run Receives the settled `{ resolve, reject }`.
	 */
	_settle( run ) {
		const pending = this._pending;
		this._pending = null;
		if ( this._timer ) {
			clearTimeout( this._timer );
			this._timer = null;
		}
		if ( pending ) {
			run( pending );
		}
		this._next();
	}

	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				'Mints one command and resolves when its reply routes back (TO=FROM).',
			accepts_fill: true,
			has_target: true,
			arguments: [],
			commands: [],
			registrations: [],
		};
	}
}
