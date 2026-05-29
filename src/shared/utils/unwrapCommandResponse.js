/**
 * Unwrap the raw Message array from CommandClient.send() into the verb's
 * payload. VALUE is already the structured `{ name, payload }` object (no parse).
 * Canonical copy; synced to the sibling plugin via sync-shared.sh.
 *
 * @param {Array} message Seven-field Message tuple from CommandClient.send().
 * @return {*} The payload; null when the verb returned an empty payload.
 * @throws {Error} If TYPE has TM_ERROR set, or on malformed input.
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
