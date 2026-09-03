import { markLocal, readyToMint } from './command-auth';
import { Core } from './core';
import { Node } from './node';
import {
	newMessage,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_ERROR,
	TM_RESPONSE,
} from './message';

/** Seconds an unanswered ask stands before the next trigger asks again. */
const RETRY_AFTER_S = 15;

/**
 * Seconds an ask may stand at all, however it is configured.
 *
 * A write is never re-asked — an unanswered one may already have applied — but
 * it must not sit here for ever either: a consumer reads the outbox to know
 * what it is still waiting for, and an ask nothing ever answers leaves a
 * spinner turning and a button disabled for the life of the page.
 */
const ASK_EXPIRY_S = 120;

/**
 * One ask: what a trigger puts on the wire, and what a reply settles.
 *
 * @typedef {Object} Ask
 * @property {?string[]} args    Argument tokens to send. Null marks the ask for
 *                               removal at the end of this trigger.
 * @property {?string}   path    The subject it is about, ridden on FROM; null
 *                               addresses the bare receiver.
 * @property {number}    askedAt Seconds when it went on the wire, 0 until then.
 * @property {boolean}   live    Minted from `command_args`, so a re-ask reads
 *                               the getter again instead of replaying it.
 */

/**
 * Fetcher — turn ANY trigger message into ONE configured command send. The
 * dashboard composition primitive: `Timer → Tee → Fetchers → _shell/_http/<ci>`,
 * where the Timer tick hitchhikes every fetcher's command into one HTTP POST.
 *
 * args = `<receiver> <command> [<command_args>...]` (Tachikoma positional style):
 *  - receiver — the local node the server's reply routes back TO (stamped as FROM).
 *  - command  — the verb to send.
 *  - command_args — the remaining tokens, passed through as the command arguments.
 *
 * `command_args` may also be assigned a FUNCTION (a fire-time getter): when it is,
 * the trigger CALLS it to get the current args token array. This lets a poll
 * dashboard emit live arguments that track React UI state (filter / sort / page)
 * without re-wiring the graph — the getter reads the current state at fire time.
 * A `null` return means there is nothing to send THIS tick. Any other non-array
 * return coerces to []. A static token array is sent as it stands.
 *
 * A trigger mints ONE ask, and mints nothing while any ask still stands — so a
 * one-second refresh on a four-second verb asks once and waits, instead of
 * queueing four identical commands the server is still working through. An ask
 * goes into the `outbox` when it is sent and leaves when its reply settles it
 * or it stands past `ASK_EXPIRY_S`; either way, leaving notifies `settled`.
 * `retry_after_s` is the fail-open valve: an answer that never came stops
 * holding the outbox open after that long. Zero disables it, which is what a
 * WRITE wants — an unanswered write may already have applied.
 *
 * `send()` is the other way in, for a caller with an answer to wait on: it parks
 * arguments the next trigger puts on the wire, so a mutation rides the same
 * batch as everything else instead of minting its own POST. It also parks the
 * SUBJECT the ask is about, which rides on FROM so the answer comes back
 * naming it — that is how ONE Fetcher serves many rows with nothing correlated
 * (ADR-7).
 *
 * `fill()` IGNORES a trigger's payload — every message that is not a REPLY is
 * just a trigger. The command is configured on the node, never read from the
 * message (a node that sends the command carried in its message is a Shell,
 * which is verboten). It emits ONE TM_COMMAND whose FROM = receiver, forwarded
 * through `sink` with TO stamped from `target` by the base `fill()`.
 */
export class FetcherNode extends Node {
	/**
	 * Predeclare the configured fields the `arguments` setter fills — where the
	 * server's reply routes back to, which verb to send, and that verb's
	 * arguments — plus the outbox those asks stand in and the retry window that
	 * re-asks an unanswered one.
	 */
	constructor() {
		super();
		/**
		 * The local node the reply routes back to. It is stamped as the emitted
		 * command's FROM, and the server answers TO=FROM.
		 */
		this.receiver = '';
		/**
		 * The verb to send. NOT named `command`: that would shadow the inherited
		 * `Node#command()` minting helper away on this class alone.
		 *
		 * @type {string}
		 */
		this.verb = '';
		/**
		 * The verb's argument tokens, or the fire-time getter described in the
		 * class docblock. `''` is the unconfigured state.
		 *
		 * @type {string|string[]|(() => ?string[])}
		 */
		this.command_args = '';
		/**
		 * The asks on the wire, or waiting for the next trigger. A reply naming
		 * an ask's `path` takes it out, and so does the expiry. Read it to know
		 * what is outstanding — a table reads the paths to see which row waits.
		 *
		 * @type {Ask[]}
		 */
		this.outbox = [];
		/**
		 * Seconds before an unanswered ask is asked again. 0 never re-asks.
		 *
		 * @type {number}
		 */
		this.retry_after_s = RETRY_AFTER_S;
	}

	/**
	 * Declared because the setter below would otherwise shadow the inherited
	 * getter away, leaving `arguments` unreadable on this class alone.
	 *
	 * @return {string[]} The `<receiver> <command> [<command_args>...]` tokens.
	 */
	get arguments() {
		return super.arguments;
	}

	/**
	 * Split the token list into the three configured fields. An empty list
	 * assigns nothing, leaving whatever the node already holds.
	 *
	 * @param {string[]} value `<receiver> <command> [<command_args>...]` tokens.
	 */
	set arguments( value ) {
		super.arguments = value;
		const tokens = Array.isArray( value ) ? value : [];
		if ( 0 === tokens.length ) {
			return;
		}
		const [ receiver, verb, ...rest ] = tokens;
		this.receiver = receiver;
		this.verb = verb ?? '';
		this.command_args = rest;
	}

	/**
	 * Settle a reply, or send what the trigger is due to send.
	 *
	 * A trigger's type, VALUE and addressing are ignored: it sends every ask
	 * that is due, retires the ones that have stood too long, and mints one
	 * more only when the outbox is empty. It sends nothing at all while the
	 * browser holds no signing session, and nothing new while the fire-time
	 * getter reports nothing to send.
	 *
	 * @param {Array} message A command REPLY, or any message at all as a trigger.
	 */
	fill( message ) {
		const type = message[ TYPE ];
		if ( type & ( TM_RESPONSE | TM_ERROR ) ) {
			this._settle( message );
			return;
		}
		// @longform
		// BEFORE the getter: a one-shot's getter TAKES its arguments as it
		// reads them, so asking first would eat the command on a tick that
		// cannot send it — and nothing would ever send it again.
		if ( ! readyToMint() ) {
			return; // unauthenticated; re-auth is under way, next poll carries it
		}
		const now = Core.now();
		for ( const ask of this.outbox ) {
			if ( ! this._isDue( ask, now ) ) {
				continue;
			}
			// @longform A LIVE ask re-reads the getter rather than replaying:
			// its args were the state at mint time, and the reason it is being
			// asked again is that time has passed. Replaying asks yesterday's
			// question, and the stale answer renders into a view already
			// showing the new one as loading.
			if ( ask.live && ! this._refresh( ask ) ) {
				continue;
			}
			this._ask( ask, now );
		}
		// @longform A live ask whose getter went quiet has nothing left to ask
		// about, and one nothing ever answered stops being worth waiting for.
		for ( const ask of this.outbox ) {
			if ( 0 < ask.askedAt && now - ask.askedAt >= ASK_EXPIRY_S ) {
				ask.args = null;
			}
		}
		this.outbox = this.outbox.filter( ( ask ) => {
			if ( null !== ask.args ) {
				return true;
			}
			this.setState( 'settled', ask );
			return false;
		} );
		// An ask already stands: asking the same question again says nothing.
		if ( this.outbox.length ) {
			return;
		}
		// command_args: fire-time getter or static token array.
		const args =
			'function' === typeof this.command_args
				? this.command_args()
				: this.command_args;
		if ( null === args || undefined === args ) {
			return; // nothing pending; a one-shot between its sends
		}
		const ask = this.send( args );
		// Minted from the getter, so a re-ask reads it again.
		ask.live = true;
		this._ask( ask, now );
	}

	/**
	 * Re-read a live ask's arguments before asking again.
	 *
	 * @param {Ask} ask The outbox entry, mutated with the current args.
	 * @return {boolean} False when the getter has nothing to ask about now, in
	 *                   which case the ask is marked for removal.
	 */
	_refresh( ask ) {
		const args =
			'function' === typeof this.command_args
				? this.command_args()
				: this.command_args;
		if ( null === args || undefined === args ) {
			ask.args = null;
			return false;
		}
		ask.args = Array.isArray( args ) ? args : [];
		return true;
	}

	/**
	 * Park an ask for the next trigger to send.
	 *
	 * @param {*}       args        The verb's argument tokens; a non-array sends none.
	 * @param {?string} [path]      The subject this ask is about, as ONE address
	 *                              segment: it rides on FROM, so the reply arrives
	 *                              naming it. Null addresses the bare receiver.
	 * @param {boolean} [supersede] Replace what is waiting instead of queueing
	 *                              behind it — nobody wants the older answer once
	 *                              a newer question has been asked.
	 * @return {Ask} The ask just parked, so a caller sending it in the same
	 *               breath need not go looking for what it pushed.
	 */
	send( args, path = null, supersede = false ) {
		const ask = {
			args: Array.isArray( args ) ? args : [],
			path: path || null,
			askedAt: 0,
			// Set by the mint path: a live ask re-reads `command_args`.
			live: false,
		};
		this.outbox = supersede ? [ ask ] : [ ...this.outbox, ask ];
		return ask;
	}

	/**
	 * Whether an ask about `path` is still waiting for its answer. A consumer
	 * that acts once per answer asks this before acting: a reply naming a
	 * subject nothing is asking about is a second answer to a settled question.
	 *
	 * @param {?string} path The subject, as `send()` was given it.
	 * @return {boolean} True while that ask stands.
	 */
	isAsking( path ) {
		return 0 <= this._indexOf( path || null );
	}

	/**
	 * Whether this ask goes on the wire now: never sent, or unanswered for
	 * longer than the window.
	 *
	 * @param {Ask}    ask One outbox entry.
	 * @param {number} now Seconds, read once for the whole trigger.
	 * @return {boolean} True when the trigger should send it.
	 */
	_isDue( ask, now ) {
		if ( 0 === ask.askedAt ) {
			return true;
		}
		return (
			0 < this.retry_after_s && now - ask.askedAt >= this.retry_after_s
		);
	}

	/**
	 * Put one ask on the wire, addressed so its reply comes back naming it, and
	 * stamp when it went — the stamp is part of the send, so no caller can put
	 * an ask on the wire without starting its window. `markLocal()` taints the
	 * message LOCAL and signs it here, because the node that MINTS a command is
	 * what signs it (ADR-15).
	 *
	 * @param {Ask}    ask The outbox entry to send.
	 * @param {number} now Seconds, read once for the whole trigger.
	 */
	_ask( ask, now ) {
		ask.askedAt = now;
		// @longform The reply routes back along FROM, and the Router peels it
		// one segment at a time — so a subject appended here arrives at the
		// receiver AS the remaining TO. That is how ONE node answers about
		// many subjects with no table: `vault:test:in/tw0` lands on
		// `vault:test:in` reading TO `tw0`, and the Tee onward to the view
		// carries the rest of the path with it.
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = ask.path
			? `${ this.receiver }/${ ask.path }`
			: this.receiver;
		m[ VALUE ] = { name: this.verb, arguments: ask.args };
		markLocal( m );
		super.fill( m );
	}

	/**
	 * Take the answered ask out of the outbox and notify `settled`.
	 *
	 * A transport refusal is not an answer: the batch never reached the verb,
	 * so an ask that may be asked again is re-armed for the next trigger rather
	 * than left to wait out its window. One that may not — a write — settles,
	 * because the caller waiting on it needs the refusal.
	 *
	 * @param {Array} message The reply; its remaining TO names what it answers.
	 */
	_settle( message ) {
		// Terminal for this message (no sink): count the answer here.
		this.counter++;
		const at = this._indexOf( message[ TO ] || null );
		if ( 0 > at ) {
			return;
		}
		if (
			true === message[ VALUE ]?.undelivered &&
			0 < this.retry_after_s
		) {
			this.outbox[ at ].askedAt = 0;
			return;
		}
		const [ ask ] = this.outbox.splice( at, 1 );
		// setState so a late subscriber still hears it.
		this.setState( 'settled', ask );
	}

	/**
	 * @param {?string} path The subject an ask is about.
	 * @return {number} Its outbox position, or -1.
	 */
	_indexOf( path ) {
		return this.outbox.findIndex( ( ask ) => ask.path === path );
	}

	/**
	 * Console-palette entry. Only the two required positionals are declared;
	 * the trailing `command_args` are variadic and may instead be assigned
	 * programmatically as a fire-time getter.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'Control',
			description:
				'Turns any trigger into one configured command send (FROM=receiver, TO from target).',
			registrations: [ 'settled' ],
			arguments: [
				{ name: 'receiver', type: 'string', required: true },
				{ name: 'command', type: 'string', required: true },
			],
			commands: [],
		};
	}
}
