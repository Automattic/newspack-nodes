import { Node } from './node';

/**
 * HookNode — a predicate gate in the browser graph: a message reaches the sink
 * only when the predicate accepts it, so a caller can splice a filter into a
 * wired chain without writing a node class.
 *
 * It never stamps `target` and never throws on a missing sink; a rejected
 * message, or one arriving before a sink is wired, is simply dropped.
 */
export class HookNode extends Node {
	/**
	 * @param {Function} predicate Called with each message; a truthy return forwards it.
	 */
	constructor( predicate ) {
		super();
		this._predicate = predicate;
	}

	/**
	 * Count the message, then forward it to the sink if the predicate accepts it.
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
