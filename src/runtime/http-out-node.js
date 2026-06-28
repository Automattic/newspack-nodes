/**
 * HttpOut — the outbound `/command` POST boundary on the browser side. Whoever
 * owns it (a RemoteLink/RemoteIpc, or the console spine via `_router`) delivers a
 * single positional Message with TO already routed; `fill()` POSTs it verbatim
 * (or buffers it while locked, so a Router TIMER tick's emissions ride in ONE
 * request). The worker-pivot `connect_worker_input` bundling lives in RemoteIpc
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
		// Safe default — callers MUST assign before fill(); a no-client fill()
		// throws when buildMessage is invoked, surfacing the wiring bug loudly.
		this.client = null;
		// When locked, fill() buffers its message instead of POSTing; flush()
		// drains the buffer as ONE postBatch so a Router TIMER tick's emissions
		// (dump_metadata every tick + uptime on the 5s tick) ride in one request.
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
		this.counter += 1;
		if ( this.locked ) {
			this.buffer.push( message );
			return;
		}
		this._post( [ message ] );
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

	// POST the entries; feed every synchronous reply back into the sink — replies
	// route by TO. JSONL body → zero or more reply Messages (verb response plus any
	// stderr/log lines); a routed-onward command yields [] (bare 202) — its reply
	// arrives over the SSE stream.
	_post( entries ) {
		// Write boundary: tally the packed wire size of what we POST (mirrors PHP's
		// file-writer bytes_written + Partition largest_msg_sent).
		for ( const m of entries ) {
			const size = byteLength( pack( m ) );
			this.bytesWritten += size;
			this.largestMsgSent = Math.max( this.largestMsgSent, size );
		}
		Promise.resolve( this.client.postBatch( entries ) )
			.then( ( messages ) => {
				for ( const message of messages ) {
					this.counter += 1;
					this.sink?.fill( message );
				}
			} )
			.catch( ( err ) => {
				// Surface so the user gets feedback when /command fails
				// (network drop, 5xx, HMAC mismatch). Rate-limited so a
				// degraded server doesn't flood the console.
				this.printLessOften(
					`ERROR: HttpOut POST failed: ${ err?.message ?? err }`
				);
			} );
	}

	lock() {
		this.locked = true;
	}

	// Programmatic-deps node: no positional config to round-trip via arguments=.
	static nodeSchema() {
		return {
			category: 'I/O',
			description: 'Browser → /command HTTP boundary (the `_http` node).',
			// POSTs commands out and routes replies back to their FROM node; it
			// never sets a graph `target`, so it has no out-port on the canvas.
			has_target: false,
			arguments: [],
			commands: [],
		};
	}
}
