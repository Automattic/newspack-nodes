/**
 * The readable text behind a TM_ERROR reply.
 *
 * Every failure surface coerces the same payload shapes and has to agree on
 * the wording when there is nothing to render, so both live here rather than
 * in each of them.
 */

/**
 * Coerce a TM_ERROR payload to text a person can read.
 *
 * The argument is whatever `payloadOf( message[ VALUE ] )` handed back: the
 * VALUE itself when a bare TM_ERROR carries a string, the `payload` field when
 * a TM_COMMAND|TM_ERROR wraps a verb's refusal, or an object carrying
 * `message` beside the structured detail a caller renders separately.
 *
 * An empty string takes the fallback rather than passing through, because an
 * error box with nothing in it reads as success.
 *
 * Passing `null` asks for the fallback alone, which is how a caller-side
 * failure with no reply behind it gets the same wording as one off the wire.
 *
 * @param {*} payload The reply's payload, in any shape.
 * @return {string} The readable message, or 'Operation failed'.
 */
export function errorMessage( payload ) {
	if ( 'string' === typeof payload && payload.length > 0 ) {
		return payload;
	}
	if (
		payload &&
		'object' === typeof payload &&
		'string' === typeof payload.message &&
		payload.message.length > 0
	) {
		return payload.message;
	}
	return 'Operation failed';
}
