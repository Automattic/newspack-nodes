/**
 * `NullNode` — the black hole, mirroring PHP's `Null_Node` and Tachikoma's
 * `Nodes::Null`, whose `fill()` counts and returns.
 *
 * It earns its place as a DESTINATION. A node that must name a target needs
 * one that swallows what lands on it: the browser spine points `_http` here
 * until a console mounts `_output`, so a server reply that arrives unaddressed
 * has somewhere to go instead of bouncing NOT_AVAILABLE at a node that is not
 * there.
 *
 * Tachikoma's Null is also a load generator, a timer firing cached TM_PERSIST
 * payloads at `max_unanswered`. That half is absent here, because this
 * substrate carries no TM_PERSIST (ADR-3) and so no acknowledgement window to
 * pace against.
 */

import { Node } from './node';

/** Discards every message, keeping the count. */
export class NullNode extends Node {
	/**
	 * Swallow the message. Counted rather than merely dropped, so `ls -c` and
	 * `stats` report what a Null absorbed — a silent black hole is
	 * indistinguishable from a broken route.
	 *
	 * It does not chain to `super.fill()`, which forwards and demands a wired
	 * sink. A Null terminates, and has to work with nothing downstream of it.
	 *
	 * @param {Array} message The 7-field positional message array.
	 */
	fill( message ) {
		void message;
		this.counter++;
	}

	/**
	 * Console-palette entry: a terminal taking no positional arguments. Nothing
	 * leaves, so the canvas draws no out-port.
	 *
	 * @return {Object} The schema.
	 */
	static nodeSchema() {
		return {
			category: 'Control',
			description:
				'Discards everything sent to it. A destination for traffic that must go somewhere and do nothing.',
			arguments: [],
			has_target: false,
		};
	}
}
