/**
 * HttpOut — the outbound `/command` POST boundary on the browser side. Whoever
 * owns it (a RemoteLink/RemoteIpc, or the console spine via `_router`) delivers a
 * single positional Message with TO already routed; `fill()` POSTs it verbatim
 * (or buffers it while locked, so a Router TIMER tick's emissions ride in ONE
 * request). The worker-attach `connect_worker_input` bundling lives in RemoteIpc
 * — this is dumb: POST what it's given. It never inspects or drops a message;
 * the sender decides what to send, and `onceInBatch()` is what it asks.
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
	payloadOf,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_RESPONSE,
	TM_ERROR,
} from './message';
import { byteLength, IoTelemetry } from './io-telemetry';
import { defaultTransport } from './command-transport';
import names from './reserved-node-names.json';

/**
 * The TM_ERROR an undelivered command earns, addressed back to its minter.
 *
 * `undelivered` marks it as the transport's word, not the server's: a retried
 * read asks again rather than treating it as the answer.
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
		// A refusal is a reply, and a reply says which ask it answers.
		arguments: sent[ VALUE ]?.arguments ?? [],
		payload: `Command not delivered: ${ reason }`,
		undelivered: true,
	};
	return reply;
}

/**
 * The `_http` node — POSTs whatever it is filled with, routes what comes back.
 * See the module docblock above for the lock/flush batching and intake rules.
 */
/**
 * One log line for a TM_ERROR reply: `<who failed>: <what was asked>: <why>`.
 *
 * The node named is the FROM, stamped — the TO is whoever ASKED, which is our
 * own `_output` on every one of these. The command rides along because these
 * land in a shared list where a bare diagnosis has no question above it, and
 * the diagnosis is quoted as the remote wrote it: an `ERROR:` of ours in front
 * would announce someone else's error as our own, and the row carries a level.
 *
 * A reply is remote wire data, so both reads of the envelope are defensive. A
 * VALUE that only LOOKS enveloped falls back to the whole object rather than
 * losing the diagnosis, and a non-list `arguments` is skipped rather than
 * spread — a throw in this loop would reject the POST promise, and the catch
 * answers a SUCCESSFUL batch with "not delivered" while dropping real replies.
 *
 * @param {Array} message Positional Message of the failing reply.
 * @return {string} A single line, no trailing newline.
 */
function errorEntry( message ) {
	const value = message[ VALUE ];
	const cause = payloadOf( value, value );
	const args = value?.arguments;
	const asked =
		Array.isArray( value ) || 'object' !== typeof value
			? ''
			: [ value?.name, ...( Array.isArray( args ) ? args : [] ) ]
					.filter( ( part ) => part )
					.join( ' ' );
	return [
		message[ FROM ] || '/command',
		asked,
		'string' === typeof cause ? cause : JSON.stringify( cause ),
	]
		.filter( ( part ) => part )
		.join( ': ' )
		.replace( /\s+$/, '' );
}

/**
 *
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
		// Keys claimed in the open batch. Owned here: it dies with the batch.
		this.claimed = new Set();
	}

	/**
	 * POST the routed Message (or buffer it while locked); feed any synchronous
	 * reply back into the sink.
	 *
	 * A Router BOUNCE is never POSTed. The far side answers an error it cannot
	 * route with an error of its own, addressed back down the FROM trail, and
	 * neither end stops — the two POST at each other until the tab closes. The
	 * Router refuses to bounce an error it cannot route for exactly this
	 * reason; this is that rule at the wire, where the loop crosses a network
	 * instead of a call stack.
	 *
	 * Keyed on the Router as the SENDER, not on TM_ERROR alone: an operator
	 * composing a message may set the error flag deliberately, and that is a
	 * command like any other. A dropped bounce still reaches the operator as an
	 * audit line, and inbound errors are untouched.
	 *
	 * @param {Array} message Positional Message; TO already routed.
	 */
	fill( message ) {
		this.counter++;
		// A Router bounce must not cross the wire OUTWARD; see the docblock.
		if ( message[ TYPE ] & TM_ERROR && names.ROUTER === message[ FROM ] ) {
			this.dropMessage( message, 'NOT_AVAILABLE' );
			return;
		}
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
		// The batch is over, so what it carried is over with it.
		this.claimed.clear();
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
				// Torn down mid-flight: nothing left to route to.
				if ( '' === this.name ) {
					return;
				}
				// A bare 202 resolves null: routed onward, nothing to route.
				for ( const message of messages ?? [] ) {
					// Read boundary: tally the wire size of each reply.
					this.bytesRead += byteLength( pack( message ) );
					this.counter++;
					if ( ! this.acceptInbound( message ) ) {
						continue;
					}
					this.tallyError( message );
					this.sink?.fill( message );
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
	 * Put one failing reply on the ERRORS tile, with a line to read beside it.
	 *
	 * Here rather than in the transport for two reasons the transport cannot
	 * supply: the FROM has been stamped by the time this runs, and a refusal
	 * the transport FABRICATED is marked `undelivered` — that one is the POST
	 * failing, which `post()` already reports once, rate-limited, instead of
	 * once per command in the batch.
	 *
	 * The heartbeat judges its own replies and logs the ones that matter, so
	 * those reach the tile through stderr like any other logged line. Counting
	 * them here as well put the expected `slot_released` race — one per
	 * reconnect, forever — on the tile, and textlessly.
	 *
	 * @param {Array} message An accepted, stamped reply.
	 */
	tallyError( message ) {
		if (
			! ( message[ TYPE ] & TM_ERROR ) ||
			names.HEARTBEAT === message[ TO ] ||
			true === message[ VALUE ]?.undelivered
		) {
			return;
		}
		IoTelemetry.recordError( 1, errorEntry( message ) );
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
	 * Everything arriving takes our name on its FROM first, so what comes in
	 * carries a path back out through us. Inbound only — a command going out
	 * has not been anywhere yet, and stamping it would tell the server our name
	 * is part of its own address. Through `stampMessage`, like every transport
	 * that stamps: RemoteLink is the sibling, and its two guards are the point.
	 *
	 * @param {Array} message A positional Message, mutated in place.
	 * @return {boolean} True if the message may be forwarded to the sink.
	 */
	acceptInbound( message ) {
		// Socket.pm:853, through the guarded method; see the docblock.
		if ( ! this.stampMessage( message, this.name ) ) {
			return false;
		}
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
	 * Whether `key` still needs sending in the batch being built.
	 *
	 * A sender with a message that serves the WHOLE POST rather than its own
	 * send — a worker mount, say — asks this instead of sending it every time.
	 * The claim lives here because the batch does: `flush()` clears it, so it
	 * cannot outlive, or disagree with, the POST it describes.
	 *
	 * Test and claim are separate on purpose. Minting can fail between them,
	 * and a claim taken for a message that never reached the buffer would let
	 * the next sender skip a mount that never went out.
	 *
	 * @param {string} key Sender's name for the thing being claimed.
	 * @return {boolean} True when nobody has sent it in this batch yet.
	 */
	onceInBatch( key ) {
		return ! this.claimed.has( key );
	}

	/**
	 * Record that `key` is now IN the batch — call it after the `fill()`.
	 *
	 * @param {string} key The key `onceInBatch()` was asked about.
	 */
	claimInBatch( key ) {
		this.claimed.add( key );
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
