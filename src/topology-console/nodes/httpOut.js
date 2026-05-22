/**
 * HttpOut — the `_http` console node (the HTTP boundary on the browser side;
 * WIRING-PLAN §1 names it `HttpOut ← was CommandOut`). `_router` peels `_http`
 * and delivers ONE positional Message with TO={reader} (or {reader}/{node});
 * `fill()` POSTs it to /command behind a leading `connect_worker_input` that
 * mounts the worker's input Partition (the prepend is kept; de-bake deferred —
 * WIRING-PLAN §8). FROM is left untouched: the Shell / silent-poll builder has
 * already stamped the reply pivot `_http/<ssePid>/<reply-node>`.
 */

import { Node } from '../../runtime/node';
import { TO } from '../../runtime/message';

export class HttpOut extends Node {
	/**
	 * @param {Object} params
	 * @param {Object} params.client CommandClient — `buildMessage` / `postBatch`.
	 */
	constructor( { client } ) {
		super();
		this.client = client;
	}

	/**
	 * POST one routed Message behind a connect_worker_input for its reader.
	 *
	 * @param {Array} message Positional Message; TO={reader} or {reader}/{node}.
	 * @return {Promise|undefined} The postBatch promise, or undefined if unrouted.
	 */
	fill( message ) {
		this.counter += 1;
		const to = message[ TO ] || '';
		if ( '' === to ) {
			// No reader to mount/route to — drop (matches Router's empty-TO guard).
			return undefined;
		}
		const slash = to.indexOf( '/' );
		const reader = -1 === slash ? to : to.slice( 0, slash );
		// connect_worker_input returns '' and never replies, so its FROM is moot.
		const connect = this.client.buildMessage( {
			to: 'topologies',
			verb: 'connect_worker_input',
			args: reader,
		} );
		return this.client.postBatch( [ connect, message ] );
	}
}
