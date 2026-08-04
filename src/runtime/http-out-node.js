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
import {
	newMessage,
	pack,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from './message';
import { byteLength } from './io-telemetry';
import { defaultTransport } from './command-transport';

/**
 * The TM_ERROR an undelivered command earns, addressed back to its minter.
 *
 * @param {Array}  sent   The command Message that failed to POST.
 * @param {string} reason Human-readable failure text.
 * @return {Array} A positional reply Message.
 */
function failureReply( sent, reason ) {
	const reply = newMessage();
	reply[ TYPE ] = TM_COMMAND | TM_ERROR;
	reply[ TO ] = sent[ FROM ];
	reply[ VALUE ] = {
		name: sent[ VALUE ]?.name,
		payload: `Command not delivered: ${ reason }`,
	};
	return reply;
}

/**
 * The `_http` node — POSTs whatever it is filled with, routes what comes back.
 * See the module docblock above for the lock/flush batching and intake rules.
 */
export class HttpOutNode extends Node {
	/**
	 * Tachikoma-parity: no-arg ctor. The `client` (a transport with
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

	/**
	 * Release the lock and POST everything buffered as ONE batch. A tick that
	 * buffered nothing costs no request.
	 */
	flush() {
		this.locked = false;
		if ( 0 === this.buffer.length ) {
			return;
		}
		const batch = this.buffer;
		this.buffer = [];
		this._post( batch );
	}

	/**
	 * POST the entries as one batch and route what comes back.
	 *
	 * A synchronous reply is fed into the sink, which routes it by TO. A POST
	 * that never landed answers each entry with a TM_ERROR to its minter,
	 * since silence is indistinguishable from a 202 routed onward.
	 *
	 * @param {Array<Array>} entries Positional command Messages, TO routed.
	 */
	_post( entries ) {
		// Palette drop with no client: default to the localized transport.
		if ( ! this.client ) {
			this.client = defaultTransport();
		}
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
				// A bare 202 resolves null: routed onward, nothing to route.
				for ( const message of messages ?? [] ) {
					// Read boundary: tally the wire size of each reply.
					this.bytesRead += byteLength( pack( message ) );
					this.counter++;
					if ( this.acceptInbound( message ) ) {
						this.sink?.fill( message );
					}
				}
			} )
			.catch( ( err ) => {
				// Surface /command failures, rate-limited to avoid flood.
				this.printLessOften(
					`ERROR: HttpOut POST failed: ${ err?.message ?? err }`
				);
				// @longform
				// And tell whoever minted each one. A POST that never landed
				// answers nothing, which reads exactly like a 202 routed
				// onward — so a node awaiting its reply would sit out its
				// whole deadline for a failure already known here.
				for ( const sent of entries ) {
					if ( ! sent[ FROM ] ) {
						continue;
					}
					this.sink?.fill(
						failureReply( sent, err?.message ?? String( err ) )
					);
				}
			} );
	}

	/**
	 * Wire-inbound discipline, following Tachikoma Socket.pm:852-862.
	 *
	 * A reply — TM_RESPONSE or TM_ERROR — self-routes by the TO the remote echoed
	 * off our own FROM breadcrumb. Anything else on the reply leg is the remote
	 * addressing OUR graph, and `target` decides what that means: unaddressed
	 * output (a `log` broadcast, say) belongs to the target, while an addressed
	 * non-reply arriving while a target is set is the remote picking its own
	 * destination inside us — refused. With no target neither arm engages.
	 *
	 * @param {Array} message A positional Message, mutated in place.
	 * @return {boolean} True if the message may be forwarded to the sink.
	 */
	acceptInbound( message ) {
		// An error is a reply too — but only when directed (see the docblock).
		if ( message[ TO ] && message[ TYPE ] & ( TM_RESPONSE | TM_ERROR ) ) {
			return true;
		}
		if ( ! this.target ) {
			return true;
		}
		if ( message[ TO ] ) {
			this.dropMessage(
				message,
				`message addressed while target is set to ${ this.target }`
			);
			return false;
		}
		message[ TO ] = this.target;
		return true;
	}

	/**
	 * Buffer every subsequent `fill()` until `flush()`, so one drain tick's
	 * emissions ride out in a single request.
	 */
	lock() {
		this.locked = true;
	}

	/**
	 * Console-palette entry. Programmatic-deps node: the client is assigned
	 * after construction, so there is no positional config to round-trip.
	 *
	 * @return {Object} The node schema.
	 */
	static nodeSchema() {
		return {
			category: 'I/O',
			description: 'Browser → /command HTTP boundary (the `_http` node).',
			// POSTs out, routes replies to FROM; no `target`, no out-port.
			has_target: true,
			arguments: [],
			commands: [],
		};
	}
}
