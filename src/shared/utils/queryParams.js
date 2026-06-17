/**
 * Tiny URL query-param helpers for deep-linkable admin pages. Reads from
 * `window.location.search`; writes via `history.replaceState` so updates never
 * reload and never pile up in browser history (a tab switch is a state change,
 * not a navigation). Canonical in newspack-nodes; consumed via the
 * `@newspack-nodes/shared` alias.
 */

/**
 * Read a query param from the current URL.
 *
 * @param {string} name Param name.
 * @return {string|null} The value, or null when absent.
 */
export function getQueryParam( name ) {
	try {
		return new URLSearchParams( window.location.search ).get( name );
	} catch ( _e ) {
		return null;
	}
}

/**
 * Set (or remove) a query param on the current URL, preserving all others.
 * A null/'' value removes the param. Uses replaceState — no reload, no history
 * entry.
 *
 * @param {string}      name  Param name.
 * @param {string|null} value New value; null or '' removes the param.
 */
export function setQueryParam( name, value ) {
	const params = new URLSearchParams( window.location.search );
	if ( null === value || '' === value ) {
		params.delete( name );
	} else {
		params.set( name, value );
	}
	const query = params.toString();
	const url = `${ window.location.pathname }${ query ? `?${ query }` : '' }${
		window.location.hash
	}`;
	window.history.replaceState( window.history.state, '', url );
}
