/**
 * HttpOut — the outbound `/command` POST boundary on the browser side. Whoever
 * owns it (a RemoteLink/RemoteIpc, or the console spine via `_router`) delivers a
 * single positional Message with TO already routed; `fill()` POSTs it verbatim
 * (or buffers it while locked, so a Router TIMER tick's emissions ride in ONE
 * request). The worker-attach `connect_worker_input` bundling lives in RemoteIpc
 * (which owns its own HttpOut) — HttpOut is dumb: POST what it's given.
 *
 * Intake: a synchronous reply comes back as a packed Message in the POST body
 * (request-scope-interpreted commands). It's fed back into `this.sink`, which
 * routes by TO (there is no `_sse` convergence node anymore). A routed-onward
 * command gets a bare 202 (null response); nothing to intake — its reply arrives
 * over the SSE stream.
 */

import { Node } from './node';
import { pack } from './message';
import { byteLength } from './io-telemetry';

export class HttpOutNode extends Node {
	/**
	 * Tachikoma-parity: no-arg ctor. The `client` (CommandClient with
	 * `buildMessage` / `postBatch`) is a programmatic dependency — callers
	 * assign it as a public property after construction:
	 * `const h = new HttpOutNode(); h.client = client;`
	 */
	constructor() {
		super();
		// Safe default — callers MUST assign before fill(); else fill() throws.
		this.client = null;
		// When locked, fill() buffers; flush() drains it as ONE postBatch.
		this.locked = false;
		this.buffer = [];
	}

	/**
	 * POST the routed Message (or buffer it while locked); feed any synchronous
	 * reply back into the sink.
	 *
	 * @param {Array} message Positional Message; TO already routed.
	 */
	fill( message ) {
		this.counter++;
		if ( this.locked ) {
			this.buffer.push( message );
			return;
		}
		this._post( [ message ] );
	}

	// Release the lock and POST everything buffered as ONE batch.
	flush() {
		this.locked = false;
		if ( 0 === this.buffer.length ) {
			return;
		}
		const batch = this.buffer;
		this.buffer = [];
		this._post( batch );
	}

	// POST the entries; feed each sync reply into the sink (routes by TO).
	_post( entries ) {
		// Pack ONCE: byte tally AND the POST body; postBatch reuses them.
		const packed = entries.map( ( m ) => pack( m ) );
		// Write boundary: tally the packed wire size of what we POST.
		for ( const line of packed ) {
			const size = byteLength( line );
			this.bytesWritten += size;
			this.largestMsgSent = Math.max( this.largestMsgSent, size );
		}
		Promise.resolve( this.client.postBatch( entries, packed ) )
			.then( ( messages ) => {
				for ( const message of messages ) {
					// Read boundary: tally the wire size of each reply.
					this.bytesRead += byteLength( pack( message ) );
					this.counter++;
					this.sink?.fill( message );
				}
			} )
			.catch( ( err ) => {
				// Surface /command failures, rate-limited to avoid flood.
				this.printLessOften(
					`ERROR: HttpOut POST failed: ${ err?.message ?? err }`
				);
			} );
	}

	lock() {
		this.locked = true;
	}

	// Programmatic-deps node: no positional config to round-trip.
	static nodeSchema() {
		return {
			category: 'Remote',
			description: 'Browser → /command HTTP boundary (the `_http` node).',
			// POSTs out, routes replies to FROM; no `target`, no out-port.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
