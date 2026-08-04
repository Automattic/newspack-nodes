import { Node } from './node';

/**
 * CallbackNode — an inline closure wearing the node contract, so any function
 * can sit in the graph where a node is expected (mirror of PHP `Callback_Node`).
 *
 * It is terminal by design: `fill()` hands the message to the closure and stops
 * there, never forwarding to `sink` or stamping `target`. Whatever the closure
 * does with the message is the whole behaviour.
 */
export class CallbackNode extends Node {
	/**
	 * @param {Function} fn Closure invoked with each message reaching `fill()`.
	 */
	constructor( fn ) {
		super();
		this._fn = fn;
	}

	/**
	 * Count the message and hand it to the closure.
	 *
	 * @param {Array} message The 7-field positional message.
	 */
	fill( message ) {
		this.counter++;
		this._fn( message );
	}
}
