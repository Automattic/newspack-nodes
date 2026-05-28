/**
 * HttpOut — the `_http` console node (the HTTP boundary on the browser side;
 * WIRING-PLAN §1 names it `HttpOut ← was CommandOut`). `_router` peels `_http`
 * and delivers ONE positional Message with TO={reader} (or {reader}/{node});
 * `fill()` POSTs it to /command. A worker target ({topology}.p{N}) prepends a
 * `connect_worker_input` (de-bake deferred — WIRING-PLAN §8); an `_http`-level
 * address (empty reader) or a server-CI target (`workers`, …) POSTs the bare
 * command for the request-scope CI.
 *
 * Intake: a synchronous reply comes back as a packed Message in the POST body
 * (request-scope-interpreted commands). It's fed back into `_sse` — the receive
 * convergence point — which strips its own `_sse:{pid}` head and routes it. A
 * routed-onward command gets a bare 202 (null response); nothing to intake — its
 * reply arrives over the SSE stream.
 */

import { Node } from './node';
import { TO } from './message';

export class HttpOut extends Node {
	/**
	 * Tachikoma-parity: no-arg ctor. The `client` (CommandClient with
	 * `buildMessage` / `postBatch`) is a programmatic dependency — callers
	 * assign it as a public property after construction:
	 * `const h = new HttpOut(); h.client = client;`
	 */
	constructor() {
		super();
		// Safe default — callers MUST assign before fill(); a no-client fill()
		// throws when buildMessage is invoked, surfacing the wiring bug loudly.
		this.client = null;
		// When locked, fill() buffers its entries instead of POSTing; flush()
		// drains the buffer as ONE postBatch so a Router TIMER tick's emissions
		// (dump_metadata every tick + uptime on the 5s tick) ride in one request.
		this.locked = false;
		this.buffer = [];
		// Worker readers already given a connect_worker_input in the current
		// locked batch — register_worker_partition is idempotent, so a second
		// connect for the same worker is pure wire/parse waste. Cleared by flush().
		this.connectedReaders = new Set();
	}

	// Programmatic-deps node: no positional config to round-trip via arguments=.
	static nodeSchema() {
		return {
			category: 'Hidden',
			description: 'Browser → /command HTTP boundary (the `_http` node).',
			arguments: [],
			commands: [],
		};
	}

	// The worker reader (`{topology}.p{N}`) a routed Message targets, or null for
	// an `_http`-level address (empty reader) or a server-CI target (`workers`,
	// `topologies`, …) — only a worker reader needs its input Partition mounted.
	_workerReaderOf( message ) {
		const to = message[ TO ] || '';
		const slash = to.indexOf( '/' );
		const reader = -1 === slash ? to : to.slice( 0, slash );
		return /\.p\d+$/.test( reader ) ? reader : null;
	}

	// Build the connect_worker_input that mounts {reader}'s input Partition.
	_connectFor( reader ) {
		return this.client.buildMessage( {
			to: 'topologies',
			verb: 'connect_worker_input',
			args: reader,
		} );
	}

	// Build the postBatch entries for a routed Message: a worker reader gets a
	// leading connect_worker_input, everything else rides bare.
	_entriesFor( message ) {
		const reader = this._workerReaderOf( message );
		return null === reader
			? [ message ]
			: [ this._connectFor( reader ), message ];
	}

	lock() {
		this.locked = true;
	}

	// POST the entries; feed every synchronous reply back into `sink` (the CI),
	// which routes via _router by TO. JSONL body → zero or more reply Messages
	// (verb response plus any stderr/log lines the command emitted); a routed-
	// onward command yields [] (bare 202) — its reply arrives over the SSE stream.
	_post( entries ) {
		Promise.resolve( this.client.postBatch( entries ) )
			.then( ( messages ) => {
				for ( const message of messages ) {
					this.sink?.fill( message );
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
		if ( this.locked ) {
			const reader = this._workerReaderOf( message );
			if ( null !== reader && this.connectedReaders.has( reader ) ) {
				// Worker already connected this batch — append the command alone.
				this.buffer.push( message );
				return;
			}
			if ( null !== reader ) {
				this.connectedReaders.add( reader );
			}
			this.buffer.push( ...this._entriesFor( message ) );
			return;
		}
		this._post( this._entriesFor( message ) );
	}

	// Release the lock and POST everything buffered during the locked window as
	// ONE batch. An empty buffer posts nothing.
	flush() {
		this.locked = false;
		this.connectedReaders.clear();
		if ( 0 === this.buffer.length ) {
			return;
		}
		const batch = this.buffer;
		this.buffer = [];
		this._post( batch );
	}
}
