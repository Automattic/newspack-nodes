/**
 * The unnamed node a REPL's Shell sinks into, on the way to `_shell` / the
 * interpreter. It carries the outbound-only work that used to sit in React
 * between a parse and a dispatch: the Compose modal's reply-flag fields, and
 * the console's refusal to send at a worker before the SSE session exists.
 *
 * Both are message-level concerns, so they belong downstream of the parse
 * rather than in the caller — and both would be wrong on anything a message
 * could be ADDRESSED to. Namelessness is what enforces that: the only way in
 * is a reference, so only the Shell it was handed to can reach it (ADR-1).
 *
 * They arrive as callbacks, not imports, because the SSE predicate and the
 * Compose fields belong to the console and reaching back would be circular.
 */

import { Core } from '../../runtime/core';
import { Node } from '../../runtime/node';
import { TO, VALUE } from '../../runtime/message';

/**
 * The Shell's outgoing gate: unnamed, so only its Shell can reach it.
 */
export class OutgoingGateNode extends Node {
	/**
	 * Build an unconfigured gate: forwards everything to its sink. The console
	 * assigns the three hooks by reference after construction.
	 */
	constructor() {
		super();
		// Admits a TO, or the send is refused. Null = admit everything.
		this.sseGuard = null;
		// Last mutation before the sink; the Compose fields ride here.
		this.beforeSend = null;
		// Told when sseGuard refuses, so the host can say why.
		this.onRefused = null;
	}

	/**
	 * @param {Array} message Positional Message on its way out of the Shell.
	 */
	fill( message ) {
		if ( ! this.sink ) {
			const verb = message[ VALUE ]?.name || '?';
			Core.stderr(
				`no command interpreter — command dropped (${ verb })\n`
			);
			return;
		}
		// Refuse before beforeSend, so a dropped message is never mutated.
		if ( this.sseGuard && ! this.sseGuard( message[ TO ] ) ) {
			this.onRefused?.();
			return;
		}
		this.counter++;
		this.beforeSend?.( message );
		this.sink.fill( message );
	}

	/**
	 * @return {Object} Palette/introspection schema; hidden, and not buildable.
	 */
	static nodeSchema() {
		return {
			category: 'Hidden',
			description:
				"A REPL Shell's outgoing gate — unnamed and unaddressable by contract.",
			arguments: [],
			commands: [],
			has_target: false,
		};
	}
}
