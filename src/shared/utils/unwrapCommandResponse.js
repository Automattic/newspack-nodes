/* eslint-disable no-bitwise -- TYPE field uses bitmask flags (Tachikoma convention). */
/**
 * Unwrap the raw Message array returned by CommandClient.send() into the
 * verb's response payload.
 *
 * Wire format recap (from newspack-nodes substrate):
 *   Message = [ TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE ]
 *   VALUE   = { name: <verb>, payload: <verb-return> }
 *
 * The only JSON serialization happens at the wire boundary, on the WHOLE
 * message: CommandClient.send() reads `fetch().json()` (and the SSE path
 * `JSON.parse`s the whole frame), so by the time the Message reaches here
 * its VALUE field is already the structured `{ name, payload }` OBJECT —
 * NOT a JSON string. `payload` is the verb's structured return (object /
 * array / scalar), likewise carried as-is with no inner encoding. So there
 * is no parse step here: read `message[VALUE]` directly and hand back its
 * `payload`.
 *
 * This helper centralizes that read and the TM_ERROR detection so each
 * dashboard's fetch callback can be a one-liner. It is the canonical copy.
 * `sync-shared.sh` copies it into the sibling plugin at
 * `newspack-event-logger-nodes/src/shared/utils/unwrapCommandResponse.js`;
 * the in-repo topology-console consumer re-exports this module directly
 * (`src/topology-console/utils/unwrapCommandResponse.js`) rather than being
 * sync-copied, so sync does NOT cover that path.
 *
 * @param {Array} message Seven-field Message tuple as returned by
 *                        CommandClient.send().
 * @return {*} The payload (typically an object or array). Returns null when
 *             the verb returned an empty payload.
 * @throws {Error} If TYPE has TM_ERROR set, throws with the payload string as
 *                 the message. Also throws on malformed input.
 */

import { TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';

export default function unwrapCommandResponse( message ) {
	if ( ! Array.isArray( message ) || message.length < 7 ) {
		throw new Error(
			'CommandClient response is malformed (expected 7-field Message array)'
		);
	}
	const outer = message[ VALUE ];
	const payload = outer?.payload;
	if ( message[ TYPE ] & TM_ERROR ) {
		throw new Error(
			typeof payload === 'string' && payload.length > 0
				? payload
				: 'Command returned an error'
		);
	}
	if ( payload === '' || payload === undefined || payload === null ) {
		return null;
	}
	return payload;
}
