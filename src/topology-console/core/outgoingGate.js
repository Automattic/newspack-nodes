/**
 * The unnamed node a REPL's Shell sinks into, on its way to the `_shell` Tap
 * and the interpreter behind it. It carries the two outbound-only concerns
 * that belong to the message rather than to the React caller: stamping the
 * Compose modal's fields onto the statement in flight, and refusing a send
 * addressed at a worker while no SSE session is up to carry the reply back.
 *
 * Both are message-level, so they belong downstream of the parse rather than
 * in the caller — and both would be wrong on anything a message could be
 * ADDRESSED to. Namelessness is what enforces that: the gate never enters the
 * registry, so no TO path resolves to it and the Shell holding the reference
 * is the only way in (ADR-7).
 *
 * The hooks arrive as callbacks the host assigns, not as imports, because the
 * SSE predicate and the Compose fields belong to the console and reaching back
 * for them would be circular.
 */

import { Core } from '../../runtime/core';
import { Node } from '../../runtime/node';
import { TO, VALUE } from '../../runtime/message';

/**
 * The Shell's outgoing gate: unnamed, so only its Shell can reach it, and
 * pass-through until a host assigns the hooks.
 */
export class OutgoingGateNode extends Node {
	/**
	 * Build an unconfigured gate: with all three hooks null it forwards every
	 * message to its sink untouched, which is where the debug overlay leaves
	 * the guard. The console assigns the hooks by reference after
	 * construction, and reassigns them whenever the state they close over —
	 * the SSE pid, the Compose fields — changes.
	 */
	constructor() {
		super();
		/**
		 * Admits a TO, or the send is refused. Null admits everything.
		 *
		 * @type {?function(string): boolean}
		 */
		this.sseGuard = null;
		/**
		 * Last mutation before the sink; the Compose fields ride here.
		 *
		 * @type {?function(Array): void}
		 */
		this.beforeSend = null;
		/**
		 * Told when `sseGuard` refuses, so the host can say why in its own
		 * voice. The gate owns no transcript and writes no error of its own.
		 *
		 * @type {?function(): void}
		 */
		this.onRefused = null;
	}

	/**
	 * Send one message on: refuse it, stamp it, or hand it to the sink. The
	 * order is the contract — the guard runs before `beforeSend`, so a refused
	 * message is never mutated and the operator resends the same statement
	 * once the session is up.
	 *
	 * A missing sink names the dropped verb on stderr rather than throwing as
	 * the base `fill()` does. The gate runs under a REPL keystroke, and
	 * `Core.stderr` puts the line in the transcript, where an uncaught error
	 * out of the dispatch would leave the operator nothing.
	 *
	 * The counter advances only on a forwarded message, so it counts sends
	 * rather than attempts.
	 *
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
		if ( this.sseGuard && ! this.sseGuard( message[ TO ] ) ) {
			this.onRefused?.();
			return;
		}
		this.counter++;
		this.beforeSend?.( message );
		this.sink.fill( message );
	}

	/**
	 * Declare the gate's shape for anything reflecting on the class: no
	 * positional arguments, no verbs, and no output port, because it forwards
	 * to its `sink` and stamps no target. `Hidden` states the exclusion the
	 * palette already gets from the class's absence from `includeNodes` — a
	 * node nothing can address is a node no TSL line should be able to name.
	 *
	 * @return {Object} The node schema.
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
