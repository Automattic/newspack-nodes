/**
 * localStorage, without the try/catch at every call site.
 *
 * @package
 */

/**
 * Read a key, or null when storage is unavailable, disabled, or the key is
 * unset. Every caller decodes its own value on top of this; what they all
 * repeated was the window guard and the swallow.
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
 * Write a key, best-effort. Storage being disabled or full is not an error a
 * caller can act on — the session simply does not persist.
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
		// Storage unavailable or full; persistence is best-effort, never fatal.
	}
}
