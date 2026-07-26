import { markLocal } from './command-auth';
import { Node } from './node';
import { newMessage, TYPE, FROM, VALUE, TM_COMMAND } from './message';

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
 * `fill()` CALLS it each tick to get the current args token array. This lets a poll
 * dashboard emit live arguments that track React UI state (filter / sort / page)
 * without re-wiring the graph — the getter reads the current state at fire time.
 * A non-array return coerces to []. A static token array stays byte-identical to the
 * pre-getter behavior (only callers that opt in pass a getter).
 *
 * `fill()` IGNORES the trigger payload — every message is just a trigger. The
 * command is configured on the node, never read from the message (a node that
 * sends the command carried in its message is a Shell, which is verboten). It
 * emits ONE TM_COMMAND whose FROM = receiver, forwarded through `sink` with TO
 * stamped from `target` by the base `fill()`.
 */
export class FetcherNode extends Node {
	constructor() {
		super();
		this.receiver = '';
		this.command = '';
		this.command_args = '';
	}

	get arguments() {
		return super.arguments;
	}

	set arguments( value ) {
		super.arguments = value;
		const tokens = Array.isArray( value ) ? value : [];
		if ( 0 === tokens.length ) {
			return;
		}
		const [ receiver, command, ...rest ] = tokens;
		this.receiver = receiver;
		this.command = command ?? '';
		this.command_args = rest;
	}

	fill( _message ) {
		// command_args: fire-time getter or static token array.
		const args =
			'function' === typeof this.command_args
				? this.command_args()
				: this.command_args;
		const m = newMessage();
		m[ TYPE ] = TM_COMMAND;
		m[ FROM ] = this.receiver;
		m[ VALUE ] = {
			name: this.command,
			arguments: Array.isArray( args ) ? args : [],
		};
		markLocal( m );
		super.fill( m );
	}

	static nodeSchema() {
		return {
			category: 'Control',
			description:
				'Turns any trigger into one configured command send (FROM=receiver, TO from target).',
			arguments: [
				{ name: 'receiver', type: 'string', required: true },
				{ name: 'command', type: 'string', required: true },
			],
			commands: [],
		};
	}
}
