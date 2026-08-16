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
import names from './reserved-node-names.json';

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
 * Split a response body into the routable replies it carries.
 *
 * `unpack()` mints a TM_UNTYPED message for anything that is not a 7-field
 * array, which is what tells JSONL from a REST error object — so this runs on
 * EVERY body, whatever the status.
 *
 * @param {string} text The raw response body.
 * @return {{messages: Array<Array>, dropped: number}} Replies, and the count of
 *   lines that were not messages.
 */
function unpackLines( text ) {
	const messages = [];
	let dropped = 0;
	for ( const line of String( text ).split( '\n' ) ) {
		if ( '' === line.trim() ) {
			continue;
		}
		const message = unpack( line );
		if ( message[ TYPE ] & TM_UNTYPED ) {
			dropped++;
			continue;
		}
		messages.push( message );
	}
	return { messages, dropped };
}

/**
 * The TM_ERROR a refused command earns, addressed back to whoever minted it.
 *
 * `undelivered` is what tells a retried read this is not the server's answer:
 * the batch never reached the verb, so asking again is the recovery rather
 * than a second ask for a question already answered.
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
		// A refusal is a reply, and a reply says which ask it answers.
		arguments: sent[ VALUE ]?.arguments ?? [],
		payload: `Command refused (HTTP ${ status }${
			code ? ` ${ code }` : ''
		})`,
		undelivered: true,
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

	/**
	 * POST one body, returning the replies AND why it was refused, if it was.
	 *
	 * The refusal travels with the result of the attempt that earned it. Held
	 * in a closure instead, it outlived a nonce-renewal retry: a recovered 403
	 * then answered a successful 202 — whose body is empty, exactly like a
	 * refusal — with a fabricated TM_ERROR per command.
	 *
	 * @param {string}  body            JSONL, one packed Message per line.
	 * @param {number}  outCount        Message count, for boundary accounting.
	 * @param {boolean} [mayRenewNonce] False on the retry, so it renews once.
	 * @return {Promise<{messages: Array<Array>, refusal: ?Object}>} Replies,
	 *   and the refusal when the substrate turned the batch away.
	 */
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
		const text = await r.text();
		// @longform
		// Unpack FIRST, whatever the status: Http_In sets the response status
		// from the refusal latch on the FIRST reply it writes, so a batch with
		// one refused command answers non-2xx with a JSONL body carrying the
		// server's real replies — the refusal's diagnosis, and every reply that
		// succeeded beside it. Only a body that unpacks to nothing is the REST
		// error object the fabricated refusal below stands in for.
		const { messages, dropped } = unpackLines( text );
		const restErrorBody = false === r.ok && 0 === messages.length;
		// That error object is ONE unreadable line by design; say nothing.
		if ( 0 < dropped && ! restErrorBody ) {
			Core.printLessOften(
				'ERROR: dropped an unparseable /command response line'
			);
		}
		// Inbound boundary accounting: response bytes, replies, error tally.
		IoTelemetry.recordIn( byteLength( text ), messages.length );
		for ( const message of messages ) {
			// @longform The heartbeat judges its own replies and logs the ones
			// that matter, so those reach the tile through stderr like any
			// other logged line. Counting them here as well put the expected
			// `slot_released` race — one per reconnect, forever — on the
			// ERRORS tile, and textlessly, since a record with no text adds no
			// message row: a climbing count with nothing to read beside it.
			if (
				message[ TYPE ] & TM_ERROR &&
				names.HEARTBEAT !== message[ TO ]
			) {
				const cause = message[ VALUE ];
				IoTelemetry.recordError(
					1,
					`ERROR: ${ message[ TO ] || '/command' }: ${
						'string' === typeof cause
							? cause
							: JSON.stringify( cause )
					}`
				);
			}
		}
		if ( false === r.ok ) {
			// A 401 refused our session.
			if ( 401 === r.status ) {
				renewSession();
			}
			const code = restErrorCode( text );
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
			return { messages, refusal: { status: r.status, code } };
		}
		return { messages, refusal: null };
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
			const { messages: replies, refusal } = await post(
				lines.join( '\n' ),
				messages.length
			);
			if ( replies.length || ! refusal ) {
				return replies;
			}
			// @longform
			// Refused, not routed onward. An empty batch reads the same as a
			// 202, so a node waiting on its reply would wait out its whole
			// deadline for a failure the transport already knows about. Answer
			// each command the way the server would have.
			return messages.map( ( sent ) =>
				refusalReply( sent, refusal.status, refusal.code )
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
