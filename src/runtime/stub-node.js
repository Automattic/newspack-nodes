/**
 * StubNode — stands for a class this runtime cannot construct.
 *
 * The console edits SERVER topologies, which name `Partition`, `Topic`,
 * `Consumer`, `Job_Worker` — classes with no JS implementation. Editing one has
 * never been able to run it, which is why the draft was an inert data structure
 * instead of a graph.
 *
 * A stub closes that gap without pretending: it carries the declared class name
 * and arguments and nothing else, so the structural verbs (`connect_node`,
 * `move_node`, `remove_node`, `set_sink`) and `dump_config` all work on it
 * unchanged, and a draft can be an interpreter at its own cwd rather than a
 * second implementation of one.
 *
 * It deliberately does NOT forward. A stub describes a node; a stub that routed
 * would be a broken node, and the failure would surface somewhere far away.
 */

import { Node } from './node';

export class StubNode extends Node {
	// Not an operator's palette drop — only a draft interpreter mints these.
	static isSystemNode = true;

	constructor() {
		super();
		// The class this stands for; dump_config emits it in our place.
		this._shellName = 'Stub';
	}

	get shellName() {
		return this._shellName;
	}

	set shellName( value ) {
		this._shellName = String( value || 'Stub' );
	}

	/**
	 * Count and drop. A stub has no behaviour to run.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		void message;
	}
}
