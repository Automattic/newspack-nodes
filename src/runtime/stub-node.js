/**
 * `StubNode` — the stand-in for a class this runtime cannot construct.
 *
 * The console edits SERVER topologies, which name `Partition`, `Topic`,
 * `Consumer` and `Job_Worker` — classes the PHP substrate implements and this
 * bundle does not. A stub carries what the topology DECLARED about such a node
 * and none of what it does: the class name, the constructor arguments, the
 * include provenance and whether the class fans out. The structural verbs
 * (`connect_node`, `move_node`, `remove_node`, `set_sink`) and `dump_config`
 * therefore work on it unchanged, which is what lets a draft be an interpreter
 * at its own cwd rather than a second implementation of one.
 *
 * It deliberately does NOT forward. A stub describes a node; a stub that routed
 * would be a broken node, and the failure would surface somewhere far away.
 */

import { Node } from './node';

/**
 * Stands in for a declared node whose class has no JS implementation.
 *
 * It holds what the topology said — class name, constructor arguments, include
 * provenance, fan-out semantics — so the structural verbs and `dump_config`
 * treat it like any other node while it runs none of the behaviour it
 * describes.
 */
export class StubNode extends Node {
	/**
	 * Start out standing for nothing in particular — class `Stub`, no origin,
	 * single-target semantics. A draft interpreter overwrites each field from
	 * the expanded topology record it seeds this stub from.
	 */
	constructor() {
		super();
		/** The class this stands for; `dump_config` emits it in our place. */
		this._shellName = 'Stub';
		/**
		 * Top-level includes that supplied this node. Empty means the file
		 * being edited declared it, which is the whole of `borrowed`.
		 *
		 * @type {string[]}
		 */
		this.origin = [];
		/**
		 * The include chain from the edited file down to the one that declares
		 * this node — the breadcrumb the inspector renders, never a route.
		 *
		 * @type {string[]}
		 */
		this.via = [];
		/** Whether the class this stands for takes Tee fan-out semantics. */
		this._fansOut = false;
	}

	/**
	 * Count and drop. Running the behaviour belongs to the class this stub
	 * stands for, so the message goes no further than the count.
	 *
	 * @param {Array} message The 7-field positional message, discarded here.
	 */
	fill( message ) {
		this.counter++;
		void message;
	}

	/**
	 * The class this stub stands for, which `dump_config` emits in place of
	 * `Stub` so a saved draft names the type the topology declared.
	 *
	 * @return {string} Declared class name.
	 */
	get shellName() {
		return this._shellName;
	}

	/**
	 * Name the class this stub stands for.
	 *
	 * @param {string} value Declared class name; anything falsy means `Stub`.
	 */
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

	/**
	 * Declare Tee semantics, normalising `target` to the list shape at once so
	 * a stub that already holds a single target keeps it.
	 *
	 * @param {boolean} value True when the class this stands for fans out.
	 */
	set fansOut( value ) {
		this._fansOut = !! value;
		if ( this._fansOut && ! Array.isArray( this.target ) ) {
			this.target = '' === this.target ? [] : [ this.target ];
		}
	}

	/**
	 * Whether an `include` supplied this node rather than the file being
	 * edited. A borrowed node belongs to the topology it came from, so a save
	 * must not re-declare it.
	 *
	 * @return {boolean} True when some topology owns this node upstream.
	 */
	get borrowed() {
		return this.origin.length > 0;
	}

	/**
	 * Point this stub at `target`, appending when it fans out and replacing
	 * otherwise, so `connect_node` means on a stub what it means on the class
	 * being described.
	 *
	 * @param {string} target Node name, optionally with a `/`-path suffix.
	 */
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

	/**
	 * Drop `target`, pruning the one entry when this stub fans out and
	 * clearing the single target otherwise.
	 *
	 * @param {string} target Entry to prune when this stub fans out; the base
	 *                        clears the one target whatever is passed.
	 */
	disconnectNode( target = '' ) {
		if ( ! this._fansOut ) {
			super.disconnectNode( target );
			return;
		}
		this.target = Array.isArray( this.target )
			? this.target.filter( ( t ) => t !== target )
			: [];
	}
}
