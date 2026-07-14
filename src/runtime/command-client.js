import {
	newMessage,
	pack,
	unpack,
	TYPE,
	TO,
	KEY,
	VALUE,
	TM_COMMAND,
	TM_ERROR,
} from './message';
import { IoTelemetry, byteLength } from './io-telemetry';
import { nodesData } from './nodes-data';

// JSONL body, so NOT application/json (see #post for why).
const COMMAND_CONTENT_TYPE = 'text/plain; charset=UTF-8';

export class CommandClient {
	constructor( { baseUrl, nonce } ) {
		this.baseUrl = baseUrl;
		this.nonce = nonce;
	}

	/**
	 * Send a single TM_COMMAND (local sync reply; 202 ack when attached).
	 *
	 * @param {Object} params See buildMessage().
	 * @return {Promise<Array>} Parsed response.
	 */
	async send( params ) {
		// JSONL body; verb response comes last, so return that message.
		const msgs = await this.#post( pack( this.buildMessage( params ) ), 1 );
		return msgs.length ? msgs[ msgs.length - 1 ] : null;
	}

	/**
	 * Build a TM_COMMAND as a 7-element positional Message array. FROM is left
	 * empty: the server's HTTP_In stamps the `_http` boundary onto every incoming
	 * message, and the per-session reply path is applied by the `_sse` node — the
	 * client never hardcodes the `_http` prefix.
	 *
	 * @param {Object} params
	 * @param {string} params.to     Target node path.
	 * @param {string} params.verb   Command verb to dispatch.
	 * @param {string} [params.args] Literal-string argument tail (the verb parses it), default ''.
	 * @param {string} [params.key]  Optional Message KEY field.
	 * @return {Array} A 7-element positional Message.
	 */
	buildMessage( { to, verb, args = '', key = '' } ) {
		const msg = newMessage();
		msg[ TYPE ] = TM_COMMAND;
		msg[ TO ] = to;
		msg[ KEY ] = key;
		msg[ VALUE ] = {
			name: verb,
			arguments: args,
		};
		return msg;
	}

	/**
	 * Build a CommandClient from the PHP-localized `window.NewspackNodesData`.
	 * The push-side boundary nodes lazily default their client to this so a
	 * fresh palette-drop never needs the nonce threaded through construction.
	 *
	 * @return {CommandClient} A client bound to the localized REST base + nonce.
	 */
	static fromGlobal() {
		const { restUrl, nonce } = nodesData();
		return new CommandClient( { baseUrl: restUrl, nonce } );
	}

	/**
	 * POST a batch as JSONL (one packed Message per line, routed in order).
	 *
	 * @param {Array<Array>}  messages Positional Messages, in dispatch order.
	 * @param {Array<string>} [packed] Pre-packed lines for `messages` (same order)
	 *                                 — HttpOut already packs each to size its write, so it passes them to avoid a
	 *                                 second serialization. Omitted callers fall back to packing here.
	 * @return {Promise<Array<Array>>} Every reply Message in the JSONL body (each
	 *   routed onward by the caller); empty when the command was routed onward (202).
	 */
	async postBatch( messages, packed ) {
		const lines = packed ?? messages.map( ( m ) => pack( m ) );
		return this.#post( lines.join( '\n' ), messages.length );
	}

	async #post( body, outCount ) {
		// Outbound boundary accounting: request bytes + message count.
		IoTelemetry.recordOut( byteLength( body ), outCount );

		const r = await fetch( `${ this.baseUrl }newspack-nodes/v1/command`, {
			method: 'POST',
			headers: {
				// Non-JSON type so WP doesn't reject the JSONL newlines.
				'Content-Type': COMMAND_CONTENT_TYPE,
				'X-WP-Nonce': this.nonce,
			},
			body,
		} );
		// JSONL: unpack each line — NEVER JSON.parse the multi-message body.
		const text = await r.text();
		const messages = text
			? text
					.split( '\n' )
					.filter( ( line ) => '' !== line.trim() )
					.map( ( line ) => unpack( line ) )
			: [];
		// Inbound boundary accounting: response bytes, replies, error tally.
		IoTelemetry.recordIn( byteLength( text ), messages.length );
		for ( const message of messages ) {
			if ( message[ TYPE ] & TM_ERROR ) {
				IoTelemetry.recordError();
			}
		}
		return messages;
	}
}
