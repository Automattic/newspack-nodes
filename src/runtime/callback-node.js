import { Node } from './node';

/**
 * CallbackNode — an inline closure wearing the node contract, so any function
 * can sit in the graph where a node is expected (mirror of PHP `Callback_Node`).
 *
 * It is terminal by design: `fill()` hands the message to the closure and stops
 * there, never forwarding to `sink` or stamping `target`. Whatever the closure
 * does with the message is the whole behaviour; one that means to transform and
 * pass the message on fills its own sink from inside.
 *
 * The required constructor argument keeps it off the text path. `makeNode`
 * instantiates with `new NodeClass()` (ADR-11) and the class is absent from
 * `includeNodes`, so no TSL line and no palette entry can name it. Callers
 * construct it directly: TriageView mounts one per dead-letter verb as the node
 * that verb's reply is addressed back to (ADR-7).
 */
export class CallbackNode extends Node {
	/**
	 * @param {(message: Array) => void} fn Invoked with each message reaching `fill()`.
	 */
	constructor( fn ) {
		super();
		/** The closure every message is handed to. */
		this._fn = fn;
	}

	/**
	 * Count the message and hand it to the closure.
	 *
	 * The array goes by reference, so a closure writing into it edits the
	 * caller's message — the opposite of the PHP mirror, whose by-value
	 * parameter confines those edits to the node's own copy.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		this._fn( message );
	}
}
