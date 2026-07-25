/**
 * Unwrap the raw Message array from CommandClient.send() into the verb's
 * payload. VALUE is already the structured `{ name, payload }` object (no parse).
 * Canonical shared module; sibling plugins consume it via the
 * `@newspack-nodes/shared` alias (esbuild + jest), not a copy.
 *
 * @param {Array} message Seven-field Message tuple from CommandClient.send().
 * @return {*} The payload; null when the verb returned an empty payload.
 * @throws {Error} If TYPE has TM_ERROR set, or on malformed input.
 */

import { TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';

export default function unwrapCommandResponse( message ) {
	// send() resolves null when the POST failed or the batch had no reply.
	if ( null === message || undefined === message ) {
		throw new Error(
			'Command got no reply (the request failed or the worker did not respond)'
		);
	}
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
