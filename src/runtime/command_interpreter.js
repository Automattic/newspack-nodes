import { Node } from './node';
import { Core } from './core';
import {
	TYPE,
	TIMESTAMP,
	FROM,
	TO,
	ID,
	KEY,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
	TM_PING,
	TM_EOF,
	newMessage,
} from './message';

/**
 * Verb dispatch over TM_COMMAND messages with empty TO.
 *
 * Mirrors the PHP `CommandInterpreter`: messages whose TYPE has TM_COMMAND
 * (and NOT TM_RESPONSE) AND whose TO is empty get dispatched to a verb
 * looked up by name in the instance's verb table. Everything else passes
 * through the sink unchanged — including in-transit commands addressed to
 * downstream peers (non-empty TO). Verb handlers may throw; `_interpret`
 * wraps a throw as TM_COMMAND|TM_ERROR with the exception message as
 * payload. Successful returns ride back as TM_COMMAND|TM_RESPONSE.
 */
export class CommandInterpreter extends Node {
	constructor() {
		super();
		this._commands = {};
	}

	/**
	 * Getter/setter for the verb table. Passing a table extends the
	 * existing one (Object.assign) so callers can layer verbs without
	 * losing earlier installations.
	 *
	 * @param {Object<string,Function>|null} table Verb table to merge, or null to read.
	 * @return {Object<string,Function>} The current verb table.
	 */
	commands( table = null ) {
		if ( table !== null ) {
			this._commands = { ...this._commands, ...table };
		}
		return this._commands;
	}

	fill( message ) {
		this.counter += 1;
		const type = message[ TYPE ];

		// TM_PING / TM_EOF with empty TO bounce back along FROM so the
		// producer can measure RTT (PING) or detect drain completion (EOF).
		// Mirrors PHP CommandInterpreter::fill — same predicate, same effect.
		// eslint-disable-next-line no-bitwise
		if ( type & ( TM_PING | TM_EOF ) && message[ TO ] === '' ) {
			message[ TO ] = message[ FROM ];
			if ( this.sink ) {
				this.sink.fill( message );
			}
			return;
		}

		// eslint-disable-next-line no-bitwise
		const isCommand = type & TM_COMMAND && ! ( type & TM_RESPONSE );
		if ( ! isCommand || message[ TO ] !== '' ) {
			if ( this.sink ) {
				this.sink.fill( message );
			}
			return;
		}
		this._interpret( message );
	}

	_interpret( message ) {
		// VALUE carries the structured command object directly
		// ({ name, arguments, payload }) — the only JSON layer is the
		// whole-message envelope, so there is nothing to parse here.
		const cmd = message[ VALUE ];
		if ( ! cmd || typeof cmd !== 'object' || ! cmd.name ) {
			Core.stderr( `invalid command struct on ${ this.name }` );
			return;
		}
		const verb = this._commands[ cmd.name ];
		if ( typeof verb !== 'function' ) {
			this._respond(
				message,
				cmd.name,
				`no such verb: ${ cmd.name }`,
				TM_ERROR
			);
			return;
		}
		try {
			const result = verb( this, cmd.arguments ?? '', message );
			this._respond( message, cmd.name, result, TM_RESPONSE );
		} catch ( e ) {
			this._respond( message, cmd.name, e.message, TM_ERROR );
		}
	}

	_respond( message, name, payload, kind ) {
		if ( payload === '' || payload === undefined ) {
			return;
		}
		const resp = newMessage();
		// eslint-disable-next-line no-bitwise
		resp[ TYPE ] = TM_COMMAND | kind;
		resp[ TIMESTAMP ] = Core.now();
		resp[ FROM ] = this.name;
		resp[ TO ] = message[ FROM ];
		resp[ ID ] = message[ ID ];
		resp[ KEY ] = message[ KEY ];
		// Response VALUE rides as the { name, payload } object directly; the
		// whole-message envelope is the only place JSON serialization happens.
		resp[ VALUE ] = { name, payload };
		if ( this.sink ) {
			this.sink.fill( resp );
		}
	}
}
