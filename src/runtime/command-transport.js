/**
 * The `/command` egress: POST a batch of packed Messages, hand back the replies
 * for HttpOut to route. It is HttpOut's wire, kept in its own file so that node
 * stays readable, and a plain object carrying one method, so a substitute is an
 * object literal rather than a subclass.
 *
 * It signs nothing. The node that MINTS a command signs it (ADR-15); a
 * transport signing on the way out would confer authority on whatever reached
 * the egress. Replies need no correlation either: the server answers TO = FROM,
 * so each one is already addressed to the node that asked (ADR-7).
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

/**
 * Content type of the batch POST.
 *
 * JSONL is not one JSON document, so the body must never be declared
 * `application/json`: WordPress parses that content type itself and answers
 * `rest_invalid_json` before `Http_In` is ever reached.
 */
const COMMAND_CONTENT_TYPE = 'text/plain; charset=UTF-8';

/**
 * What a boundary node's `client` must provide: POST a batch as JSONL and
 * resolve the replies it earns.
 *
 * @typedef {Object} CommandTransport
 * @property {(messages: Array<Array>, packed?: Array<string>) => Promise<Array<Array>>} postBatch The batch POST.
 */

/**
 * The `code` a WP REST error body carries, such as `rest_no_route`.
 *
 * @param {string} text The raw response body.
 * @return {string} The code, or '' when the body is not a readable REST error.
 */
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
 * A transport bound to one REST base and nonce.
 *
 * @param {Object}                 o              The binding.
 * @param {string}                 o.baseUrl      REST root, e.g. `/wp-json/`.
 * @param {string}                 o.nonce        WP REST nonce.
 * @param {?() => Promise<string>} [o.renewNonce] Async nonce refresh, for a
 *                                                stale-nonce retry. Absent
 *                                                means one attempt only.
 * @return {CommandTransport} The transport HttpOut drives.
 */
export function commandTransport( { baseUrl, nonce, renewNonce = null } ) {
	let currentNonce = nonce;

	/**
	 * POST one body, returning the replies AND why it was refused, if it was.
	 *
	 * The refusal travels with the result of the attempt that earned it. Held
	 * in a closure it would outlive a nonce-renewal retry, so a recovered 403
	 * would answer the retry's 202 — whose body is empty, exactly like a
	 * refusal — with a fabricated TM_ERROR per command.
	 *
	 * @param {string}  body            JSONL, one packed Message per line.
	 * @param {number}  outCount        Message count, for boundary accounting.
	 * @param {boolean} [mayRenewNonce] False on the retry, so it renews once.
	 * @return {Promise<{messages: Array<Array>, refusal: ?{status: number, code: string}}>}
	 *   Replies, and the refusal when the substrate turned the batch away.
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
		// Inbound bytes and counts; the error TALLY is HttpOut's.
		IoTelemetry.recordIn( byteLength( text ), messages.length );
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
		 * @return {Promise<Array<Array>>} Every reply the JSONL body carries, one
		 *   fabricated refusal per command when the batch was turned away, and empty
		 *   when the server routed the batch onward (202).
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
 * @return {CommandTransport} A transport on the localized base and nonce.
 */
export function defaultTransport() {
	const { restUrl, nonce } = nodesData();
	return commandTransport( {
		baseUrl: restUrl,
		nonce,
		renewNonce: refreshNodesNonce,
	} );
}
