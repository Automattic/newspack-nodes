/* eslint-disable no-bitwise -- TYPE field uses bitmask flags (Tachikoma convention). */
/**
 * Unwrap the raw Message array returned by CommandClient.send() into the
 * verb's response payload.
 *
 * Wire format recap (from newspack-nodes substrate):
 *   Message = [ TYPE, TIMESTAMP, FROM, TO, ID, KEY, VALUE ]
 *   VALUE   = JSON.stringify( { name: <verb>, payload: <verb-return-string> } )
 *   payload = the verb's return string — for our verbs this is
 *             `wp_json_encode($result)`, i.e. a JSON-encoded object.
 *
 * The substrate's CommandInterpreter wraps every verb response this way (see
 * `CommandInterpreter::interpret()` in class-command-interpreter.php). So
 * every dashboard that calls a verb needs the same double-parse:
 *   - JSON.parse the outer VALUE → { name, payload }
 *   - JSON.parse the inner payload → the actual data
 *
 * This helper centralizes that logic and the TM_ERROR detection so each
 * dashboard's fetch callback can be a one-liner.
 *
 * @param {Array} message Seven-field Message tuple as returned by
 *                        CommandClient.send().
 * @return {*} The parsed payload (typically an object or array). Returns null
 *             when the verb returned an empty payload.
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
	const outer = JSON.parse( message[ VALUE ] );
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
	if ( typeof payload !== 'string' ) {
		return payload;
	}
	return JSON.parse( payload );
}
