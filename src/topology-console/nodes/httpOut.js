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
		// When locked, fill() buffers its entries instead of POSTing; flush()
		// drains the buffer as ONE postBatch so a Router TIMER tick's emissions
		// (dump_metadata every tick + uptime on the 5s tick) ride in one request.
		this.locked = false;
		this.buffer = [];
	}

	// Build the postBatch entries for a routed Message: a worker target gets a
	// leading connect_worker_input; an `_http`-level address (empty reader) is bare.
	_entriesFor( message ) {
		const to = message[ TO ] || '';
		const slash = to.indexOf( '/' );
		const reader = -1 === slash ? to : to.slice( 0, slash );
		// `_http`-level (empty reader): bare command for the request-scope CI.
		// Worker target: prepend connect_worker_input to mount its input Partition.
		return '' === reader
			? [ message ]
			: [
					this.client.buildMessage( {
						to: 'topologies',
						verb: 'connect_worker_input',
						args: reader,
					} ),
					message,
			  ];
	}

	lock() {
		this.locked = true;
	}

	// POST the entries; feed every synchronous reply back into `_sse`.
	_post( entries ) {
		Promise.resolve( this.client.postBatch( entries ) )
			.then( ( messages ) => {
				// JSONL body → zero or more reply Messages (verb response plus any
				// stderr/log lines the command emitted); route each via _sse. A
				// routed-onward command yields [] (bare 202) — its reply arrives
				// over the SSE stream.
				const sse = Core.node( names.SSE );
				for ( const message of messages ) {
					sse?.fill( message );
				}
			} )
			.catch( () => {} );
	}

	/**
	 * POST the routed Message (or buffer it while locked); feed any synchronous
	 * reply back into `_sse`.
	 *
	 * @param {Array} message Positional Message; TO={reader} or {reader}/{node}.
	 */
	fill( message ) {
		this.counter += 1;
		const entries = this._entriesFor( message );
		if ( this.locked ) {
			this.buffer.push( ...entries );
			return;
		}
		this._post( entries );
	}

	// Release the lock and POST everything buffered during the locked window as
	// ONE batch. An empty buffer posts nothing.
	flush() {
		this.locked = false;
		if ( 0 === this.buffer.length ) {
			return;
		}
		const batch = this.buffer;
		this.buffer = [];
		this._post( batch );
	}
}
