/**
 * The `?param=` deep-link surface the admin dashboards read and write.
 *
 * Two helpers rather than a `URLSearchParams` at each call site, because a
 * write has to preserve every OTHER param: a tab host clearing `?log=` and a
 * picker setting `?source=` run in the same page, and either one rebuilding
 * the query from what it alone knows drops the other's state.
 *
 * Canonical in newspack-nodes, consumed through the `@newspack-nodes/shared`
 * alias.
 */

/**
 * Read a query param from the current URL.
 *
 * A context with no `window` yields null instead of throwing, so no call site
 * carries its own guard.
 *
 * @param {string} name Param name.
 * @return {string|null} The value, or null when absent or unreadable.
 */
export function getQueryParam( name ) {
	try {
		return new URLSearchParams( window.location.search ).get( name );
	} catch ( _e ) {
		return null;
	}
}

/**
 * Set or remove a query param, leaving every other param and the fragment
 * untouched.
 *
 * The write goes through `history.replaceState`: picking a tab or a log is a
 * state change, not a navigation, so it must neither reload the page nor
 * leave a Back-button entry behind every click. An empty value removes the
 * param instead of writing `?log=`, which keeps a bare link meaning "whatever
 * this dashboard opens on".
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
