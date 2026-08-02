/**
 * The readable text behind a TM_ERROR payload.
 *
 * A verb's failure arrives as a bare string, as a `{ message }` object, or as
 * something a caller cannot render at all; every surface that shows one wants
 * the same coercion, so it lives here rather than in each of them.
 */

/**
 * Coerce a TM_ERROR payload (string / { message } / anything else) to a
 * human-readable string.
 *
 * @param {*} payload The reply's VALUE.payload.
 * @return {string} The readable message; 'Operation failed' as a last resort.
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
