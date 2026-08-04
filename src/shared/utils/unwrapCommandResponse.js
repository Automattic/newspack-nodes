/**
 * Canonical shared module; sibling plugins consume it via the
 * `@newspack-nodes/shared` alias (esbuild + jest), not a copy.
 */

import { TYPE, VALUE, TM_ERROR } from '@newspack-nodes/runtime';

/**
 * Unwrap a raw reply Message array into the verb's payload. VALUE is already
 * the structured `{ name, payload }` object, so there is nothing to parse.
 *
 * @param {?Array} message Reply Message tuple; null when send() got no reply.
 * @return {*} The payload; null when the verb returned an empty payload.
 * @throws {Error} If TYPE has TM_ERROR set, or on malformed input.
 */
export default function unwrapCommandResponse( message ) {
	// send() resolves null when the POST failed or the batch had no reply.
	if ( null === message || undefined === message ) {
		throw new Error(
			'Command got no reply (the request failed or the worker did not respond)'
		);
	}
	if ( ! Array.isArray( message ) || message.length < 7 ) {
		throw new Error(
			'reply is malformed (expected a 7-field Message array)'
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
