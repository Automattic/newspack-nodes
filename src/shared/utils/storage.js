/**
 * localStorage, without the try/catch at every call site.
 *
 * Touching `window.localStorage` throws outright where a browser blocks site
 * data, `setItem` throws again once the origin's quota is full, and a bundle
 * evaluated outside a browser has no `window` to touch at all. What these
 * helpers hold is a remembered column set, a collapse flag, a refresh
 * interval — a preference worth no error path — so both absorb the failure
 * and leave the caller on its default.
 *
 * @package
 */

/**
 * Read a key, or null when storage is unavailable, refused, or the key is
 * unset.
 *
 * The three cases answer alike on purpose. A caller decodes and validates the
 * string itself, and already needs a fallback for a stored value it can no
 * longer use — `usePersistedChoice` takes one whenever the option list has
 * dropped the stored choice — so a distinct "storage refused" answer would
 * reach the same branch.
 *
 * @param {string} key Storage key.
 * @return {?string} The stored string, or null.
 */
export function readStorage( key ) {
	try {
		return 'undefined' === typeof window
			? null
			: window.localStorage.getItem( key );
	} catch ( e ) {
		return null;
	}
}

/**
 * Write a key, best-effort.
 *
 * Storage being blocked or full is not an error a caller can act on: the
 * preference does not persist, and the next visit starts from its default.
 * Nothing reports that, so read the key back when a value must be known to
 * have survived.
 *
 * @param {string} key   Storage key.
 * @param {string} value Value to store.
 */
export function writeStorage( key, value ) {
	try {
		if ( 'undefined' !== typeof window ) {
			window.localStorage.setItem( key, value );
		}
	} catch ( e ) {
		// Intentionally empty: a lost preference is not a bug.
	}
}
