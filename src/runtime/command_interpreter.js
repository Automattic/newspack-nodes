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
 * Verb dispatch over TM_COMMAND messages with empty TO (mirrors PHP
 * CommandInterpreter). Throws wrap as TM_ERROR, returns as TM_RESPONSE;
 * everything else passes through the sink unchanged.
 */
export class CommandInterpreter extends Node {
	constructor() {
		super();
		this._commands = {};
	}

	/**
	 * Getter/setter for the verb table; passing a table merges (extends) it.
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

		// TM_PING / TM_EOF with empty TO bounce back along FROM (RTT / drain).
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
		// VALUE is the structured command object directly (no parse needed).
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
		// Response VALUE rides as the { name, payload } object directly.
		resp[ VALUE ] = { name, payload };
		if ( this.sink ) {
			this.sink.fill( resp );
		}
	}
}
