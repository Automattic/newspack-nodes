/**
 * HttpOut — the `_http` console node (the HTTP boundary on the browser side;
 * WIRING-PLAN §1 names it `HttpOut ← was CommandOut`). `_router` peels `_http`
 * and delivers ONE positional Message with TO={reader} (or {reader}/{node});
 * `fill()` POSTs it to /command. A worker target prepends a `connect_worker_input`
 * (de-bake deferred — WIRING-PLAN §8); an `_http`-level address (empty reader)
 * POSTs the bare command for the request-scope CI.
 *
 * Intake: a synchronous reply comes back as a packed Message in the POST body
 * (request-scope-interpreted commands). It's fed back into `_sse` — the receive
 * convergence point — which strips its own `_sse:{pid}` head and routes it. A
 * routed-onward command gets a bare 202 (null response); nothing to intake — its
 * reply arrives over the SSE stream.
 */

import { Node } from '../../runtime/node';
import { Core } from '../../runtime/core';
import { TO } from '../../runtime/message';
import names from '../../runtime/reserved-node-names.json';

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
	 * POST the routed Message; feed any synchronous reply back into `_sse`.
	 *
	 * @param {Array} message Positional Message; TO={reader} or {reader}/{node}.
	 * @return {Promise} The postBatch promise.
	 */
	fill( message ) {
		this.counter += 1;
		const to = message[ TO ] || '';
		const slash = to.indexOf( '/' );
		const reader = -1 === slash ? to : to.slice( 0, slash );
		// `_http`-level (empty reader): bare command for the request-scope CI.
		// Worker target: prepend connect_worker_input to mount its input Partition.
		const batch =
			'' === reader
				? [ message ]
				: [
						this.client.buildMessage( {
							to: 'topologies',
							verb: 'connect_worker_input',
							args: reader,
						} ),
						message,
				  ];
		const result = this.client.postBatch( batch );
		Promise.resolve( result )
			.then( ( response ) => {
				// A synchronous reply is a packed Message; route it via _sse. A
				// routed-onward command resolves to null (bare 202) — nothing to do;
				// its reply arrives over the SSE stream.
				if ( response ) {
					Core.node( names.SSE )?.fill( response );
				}
			} )
			.catch( () => {} );
		return result;
	}
}
