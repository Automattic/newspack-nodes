import {
	newMessage,
	pack,
	unpack,
	TYPE,
	FROM,
	TO,
	VALUE,
	TM_COMMAND,
	TM_ERROR,
	TM_UNTYPED,
} from './message';
import { invalidateAuth, markLocal, renewSession } from './command-auth';
import { Core } from './core';
import { IoTelemetry, byteLength } from './io-telemetry';
import { nodesData, refreshNodesNonce } from './nodes-data';

// JSONL body, so NOT application/json (see #post for why).
const COMMAND_CONTENT_TYPE = 'text/plain; charset=UTF-8';

// The `code` off a WP REST error body ('rest_no_route'), or '' if unreadable.
function restErrorCode( text ) {
	try {
		return JSON.parse( text )?.code ?? '';
	} catch ( e ) {
		return '';
	}
}

/**
 * The TM_ERROR a refused command earns, addressed back to whoever minted it.
 *
 * @param {Array}  sent   The posted command Message.
 * @param {number} status HTTP status the substrate answered with.
 * @param {string} code   REST error code, if the body carried one.
 * @return {Array} A positional reply Message.
 */
function refusalReply( sent, status, code ) {
	const reply = newMessage();
	reply[ TYPE ] = TM_COMMAND | TM_ERROR;
	reply[ TO ] = sent[ FROM ];
	reply[ VALUE ] = {
		name: sent[ VALUE ]?.name,
		payload: `Command refused (HTTP ${ status }${
			code ? ` ${ code }` : ''
		})`,
	};
	return reply;
}

export class CommandClient {
	constructor( { baseUrl, nonce, renewNonce = null } ) {
		this.baseUrl = baseUrl;
		this.nonce = nonce;
		this._renewNonce = renewNonce;
	}

	async #post( body, outCount, mayRenewNonce = true ) {
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
		// A non-2xx body is a REST error OBJECT, not JSONL. Say so.
		if ( false === r.ok ) {
			// A 401 refused our session; we return before the body is parsed.
			if ( 401 === r.status ) {
				renewSession();
			}
			const code = restErrorCode( text );
			// Why the batch came back empty; postBatch answers the minters.
			this.lastRefusal = { status: r.status, code };
			if (
				mayRenewNonce &&
				this._renewNonce &&
				'rest_cookie_invalid_nonce' === code
			) {
				this.nonce = await this._renewNonce();
				// A renewed nonce invalidates what the old one derived.
				invalidateAuth();
				return this.#post( body, outCount, false );
			}
			Core.printLessOften(
				`ERROR: CommandClient: /command failed - HTTP ${ r.status } ${ code }`
			);
			return [];
		}
		const unpacked = text
			? text
					.split( '\n' )
					.filter( ( line ) => '' !== line.trim() )
					.map( ( line ) => unpack( line ) )
			: [];
		// A line unpack() cannot read mints a blank — never route that.
		const messages = unpacked.filter( ( m ) => {
			if ( m[ TYPE ] & TM_UNTYPED ) {
				Core.printLessOften(
					'ERROR: CommandClient: dropped an unparseable /command response line'
				);
				return false;
			}
			return true;
		} );
		// Inbound boundary accounting: response bytes, replies, error tally.
		IoTelemetry.recordIn( byteLength( text ), messages.length );
		for ( const message of messages ) {
			if ( message[ TYPE ] & TM_ERROR ) {
				IoTelemetry.recordError();
			}
		}
		return messages;
	}

	/**
	 * Build a TM_COMMAND as a 7-element positional Message array. FROM is left
	 * empty: the server's HTTP_In stamps the `_http` boundary onto every incoming
	 * message, and the per-session reply path is applied by the `_sse` node — the
	 * client never hardcodes the `_http` prefix.
	 *
	 * @param {Object}   params
	 * @param {string}   params.to     Target node path.
	 * @param {string}   params.verb   Command verb to dispatch.
	 * @param {string[]} [params.args] Argument tokens (the verb classifies them), default [].
	 * @return {Array} A 7-element positional Message.
	 */
	buildMessage( { to, verb, args = [] } ) {
		// Fail loud: a non-array args would coerce to [] (empty verb name).
		if ( ! Array.isArray( args ) ) {
			throw new Error(
				`command args must be a token array, got ${ typeof args } for verb "${ verb }"`
			);
		}
		const msg = newMessage();
		msg[ TYPE ] = TM_COMMAND;
		msg[ TO ] = to;
		msg[ VALUE ] = {
			name: verb,
			arguments: args,
		};
		markLocal( msg );
		return msg;
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
		this.lastRefusal = null;
		const replies = await this.#post( lines.join( '\n' ), messages.length );
		if ( replies.length || ! this.lastRefusal ) {
			return replies;
		}
		// @longform
		// Refused, not routed onward. An empty batch reads the same as a 202,
		// so a node waiting on its reply would wait out its whole deadline for
		// a failure the transport already knows about. Answer each command the
		// way the server would have — TM_ERROR, addressed back to its minter.
		const { status, code } = this.lastRefusal;
		return messages.map( ( sent ) => refusalReply( sent, status, code ) );
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
		return new CommandClient( {
			baseUrl: restUrl,
			nonce,
			renewNonce: refreshNodesNonce,
		} );
	}
}
