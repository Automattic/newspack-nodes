/**
 * The unnamed node every console send passes on its way to the `_shell` Tap
 * and the interpreter behind it: the Shell's statements, the invoke gesture's
 * mints and the Compose modal's messages alike. It carries the two
 * outbound-only concerns that belong to the message rather than to the React
 * caller: refusing a send addressed at a worker while no SSE session is up to
 * carry the reply back, and announcing each message it forwards, which is how
 * the Reset Graph chip sees every structural edit whoever minted it.
 *
 * Both are message-level, so they belong downstream of the mint rather than in
 * the caller — and both would be wrong on anything a message could be
 * ADDRESSED to. Namelessness is what enforces that: the gate never enters the
 * registry, so no TO path resolves to it and a host holding the reference is
 * the only way in (ADR-7).
 *
 * The hooks arrive as callbacks the host assigns, not as imports, because the
 * SSE predicate and the dirty tap belong to the console and reaching back for
 * them would be circular.
 */

import { __ } from '@wordpress/i18n';
import { Core } from '../../runtime/core';
import { Node } from '../../runtime/node';
import { TO, VALUE } from '../../runtime/message';

/**
 * Why a send at a worker was refused while no SSE session is up: the one text
 * the console's gate refusal and the Inspector's gestures both report.
 *
 * @return {string} The refusal, translated when called.
 */
export function sseRefusal() {
	return __( '[no SSE session yet] retry once CONNECTED', 'newspack-nodes' );
}

/**
 * A console's outgoing gate: unnamed, so only a host holding it can reach it,
 * and pass-through until the host assigns the hooks.
 */
export class OutgoingGateNode extends Node {
	/**
	 * Build an unconfigured gate: with all three hooks null it forwards every
	 * message to its sink untouched, which is where the debug overlay leaves
	 * the guard. A host assigns the hooks by reference after construction, and
	 * reassigns one whenever the state it closes over — the SSE pid — changes.
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
		 * Observe-only tap, told each forwarded message before the sink takes
		 * it. It must not mutate the message: the minter signed it.
		 *
		 * @type {?function(Array): void}
		 */
		this.onForward = null;
		/**
		 * Told when `sseGuard` refuses, so the host can say why in its own
		 * voice. The gate owns no transcript and writes no error of its own.
		 *
		 * @type {?function(): void}
		 */
		this.onRefused = null;
	}

	/**
	 * Send one message on: refuse it, or announce it and hand it to the sink.
	 * The order is the contract — the guard runs before `onForward`, so a
	 * refused message is never announced and the operator resends the same
	 * statement once the session is up. A message the guard passes is
	 * announced before the sink, because a sink that throws may still have run
	 * it — a Tap delivers its passthrough, then raises its copies' failures —
	 * and a missed edit hides the Reset Graph chip.
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
		this.onForward?.( message );
		this.sink.fill( message );
	}

	/**
	 * Whether the gate has a sink to send into: a composer refuses rather than
	 * fill a gate that would only name the dropped verb on stderr.
	 *
	 * @return {boolean} True once a sink is wired.
	 */
	get connected() {
		return !! this.sink;
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
