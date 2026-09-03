import { Node } from './node';

/**
 * HookNode — a predicate gate in the browser graph: a message reaches the sink
 * only when the predicate accepts it, so a caller splices a filter into a wired
 * chain without writing a node class.
 *
 * It shares only its name with PHP `Hook_Node`, which fires `do_action` or
 * `apply_filters` on each VALUE. The browser has no WordPress hooks, so this
 * gate takes a closure instead.
 *
 * It forwards without stamping: `target` never reaches TO, and FROM stays as
 * the source left it, which is the pass-through contract every internal
 * forwarder honors.
 *
 * The required constructor argument keeps it off the text path. `makeNode`
 * instantiates with `new NodeClass()` (ADR-11) and the class is absent from
 * `includeNodes`, so no TSL line and no palette entry can name it; a caller
 * imports it from the runtime package and constructs it directly.
 */
export class HookNode extends Node {
	/**
	 * @param {(message: Array) => boolean} predicate Tested against each
	 *                                                message; true forwards it.
	 */
	constructor( predicate ) {
		super();
		/** The closure each message is tested against. */
		this._predicate = predicate;
	}

	/**
	 * Count the message, then forward it to the sink when the predicate
	 * accepts it.
	 *
	 * The count covers every message the gate sees, rejected ones included, so
	 * the counter reads as what was offered rather than what passed. The sink
	 * check rides in the same condition: unlike the base `fill()`, an unwired
	 * sink drops the message instead of throwing, so a gate may be spliced in
	 * ahead of the sink it will forward to.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		if ( this._predicate( message ) && this.sink ) {
			this.sink.fill( message );
		}
	}
}
