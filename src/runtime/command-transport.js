/**
 * The `/command` transport — POST a batch of packed Messages, route what comes
 * back. HttpOut's own wire, factored out of it only so the file stays readable:
 * there is no client CLASS any more, because there was never a second
 * implementation and the one seam anybody used was a test double.
 *
 * A refusal answers each command the way the server would (`TM_ERROR`,
 * `TO = FROM`) rather than resolving empty, which a caller cannot tell from the
 * 202 that means "routed onward, reply rides the stream".
 */

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
import { invalidateAuth, renewSession } from './command-auth';
import { Core } from './core';
import { IoTelemetry, byteLength } from './io-telemetry';
import { nodesData, refreshNodesNonce } from './nodes-data';

// JSONL body, so NOT application/json (WP would reject the newlines).
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

/**
 * A transport bound to one REST base + nonce.
 *
 * @param {Object}    o
 * @param {string}    o.baseUrl      REST root, e.g. `/wp-json/`.
 * @param {string}    o.nonce        WP REST nonce.
 * @param {?Function} [o.renewNonce] Async nonce refresh, for a stale-nonce retry.
 * @return {{ postBatch: Function }} The transport HttpOut drives.
 */
export function commandTransport( { baseUrl, nonce, renewNonce = null } ) {
	let currentNonce = nonce;
	// Why a batch came back empty; postBatch answers the minters with it.
	let lastRefusal = null;

	const post = async ( body, outCount, mayRenewNonce = true ) => {
		// Outbound boundary accounting: request bytes + message count.
		IoTelemetry.recordOut( byteLength( body ), outCount );

		const r = await fetch( `${ baseUrl }newspack-nodes/v1/command`, {
			method: 'POST',
			headers: {
				'Content-Type': COMMAND_CONTENT_TYPE,
				'X-WP-Nonce': currentNonce,
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
			lastRefusal = { status: r.status, code };
			if (
				mayRenewNonce &&
				renewNonce &&
				'rest_cookie_invalid_nonce' === code
			) {
				currentNonce = await renewNonce();
				// A renewed nonce invalidates what the old one derived.
				invalidateAuth();
				return post( body, outCount, false );
			}
			Core.printLessOften(
				`ERROR: /command failed - HTTP ${ r.status } ${ code }`
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
					'ERROR: dropped an unparseable /command response line'
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
	};

	return {
		/**
		 * POST a batch as JSONL (one packed Message per line, routed in order).
		 *
		 * @param {Array<Array>}  messages Positional Messages, in dispatch order.
		 * @param {Array<string>} [packed] Pre-packed lines (same order) — HttpOut
		 *                                 packs each to size its write, so it passes
		 *                                 them rather than serializing twice.
		 * @return {Promise<Array<Array>>} Every reply in the JSONL body; empty when
		 *   the command was routed onward (202).
		 */
		async postBatch( messages, packed ) {
			const lines = packed ?? messages.map( ( m ) => pack( m ) );
			lastRefusal = null;
			const replies = await post( lines.join( '\n' ), messages.length );
			if ( replies.length || ! lastRefusal ) {
				return replies;
			}
			// @longform
			// Refused, not routed onward. An empty batch reads the same as a
			// 202, so a node waiting on its reply would wait out its whole
			// deadline for a failure the transport already knows about. Answer
			// each command the way the server would have.
			const { status, code } = lastRefusal;
			return messages.map( ( sent ) =>
				refusalReply( sent, status, code )
			);
		},
	};
}

/**
 * The transport bound to the PHP-localized `window.NewspackNodesData`. HttpOut
 * defaults to this, so a palette-drop never needs the nonce threaded in.
 *
 * @return {{ postBatch: Function }} A transport on the localized base + nonce.
 */
export function defaultTransport() {
	const { restUrl, nonce } = nodesData();
	return commandTransport( {
		baseUrl: restUrl,
		nonce,
		renewNonce: refreshNodesNonce,
	} );
}
