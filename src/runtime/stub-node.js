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
		// Topologies this node came in through; empty means the file's own.
		this.origin = [];
		this.via = [];
		this._fansOut = false;
	}

	get shellName() {
		return this._shellName;
	}

	set shellName( value ) {
		this._shellName = String( value || 'Stub' );
	}

	/**
	 * Whether the class this stands for fans out, i.e. takes Tee semantics.
	 *
	 * A stub cannot inherit them — the class it describes is the one that has
	 * them — so the catalog's `fans_out` is what decides, and setting it swaps
	 * `target` between the two shapes the runtime actually uses.
	 *
	 * @return {boolean} True when `connect_node` appends rather than replaces.
	 */
	get fansOut() {
		return this._fansOut;
	}

	set fansOut( value ) {
		this._fansOut = !! value;
		if ( this._fansOut && ! Array.isArray( this.target ) ) {
			this.target = '' === this.target ? [] : [ this.target ];
		}
	}

	// Borrowed: supplied by an `include`, so a save must not re-declare it.
	get borrowed() {
		return this.origin.length > 0;
	}

	connectNode( target ) {
		if ( ! this._fansOut ) {
			super.connectNode( target );
			return;
		}
		// `removeNode` resets `target` to '', so normalise it again.
		if ( ! Array.isArray( this.target ) ) {
			this.target = '' === this.target ? [] : [ this.target ];
		}
		if ( ! this.target.includes( target ) ) {
			this.target.push( target );
		}
	}

	disconnectNode( target = '' ) {
		if ( ! this._fansOut ) {
			super.disconnectNode( target );
			return;
		}
		this.target = Array.isArray( this.target )
			? this.target.filter( ( t ) => t !== target )
			: [];
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
