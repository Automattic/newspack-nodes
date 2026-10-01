/**
 * The `?param=` deep-link surface the admin dashboards read and write.
 *
 * Helpers rather than a `URLSearchParams` at each call site, because a
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
 * untouched. `setQueryParams` with one entry; see it for the write rules.
 *
 * @param {string}      name  Param name.
 * @param {string|null} value New value; null or '' removes the param.
 */
export function setQueryParam( name, value ) {
	setQueryParams( { [ name ]: value } );
}

/**
 * Set or remove several query params in one history write, leaving every other
 * param and the fragment untouched.
 *
 * The write goes through `history.replaceState` by default: picking a tab or
 * a filter is a state change, not a navigation, so it must neither reload the
 * page nor leave a Back-button entry behind every click. `push` makes it a
 * navigation instead, for a view Back should return to. An empty value removes
 * the param instead of writing `?log=`, which keeps a bare link meaning
 * "whatever this dashboard opens on". A write that would leave the URL as it
 * is makes no history call at all, so a repeated write never stacks entries.
 *
 * @param {Object<string, ?string>} params         Param names to new values;
 *                                                 null or '' removes one.
 * @param {Object}                  [options]      Options.
 * @param {boolean}                 [options.push] Push a history entry rather
 *                                                 than replace the current one.
 */
export function setQueryParams( params, { push = false } = {} ) {
	const { pathname, search, hash } = window.location;
	const query = new URLSearchParams( search );
	for ( const [ name, value ] of Object.entries( params ) ) {
		if ( null === value || '' === value ) {
			query.delete( name );
		} else {
			query.set( name, value );
		}
	}
	const next = query.toString();
	const url = `${ pathname }${ next ? `?${ next }` : '' }${ hash }`;
	if ( url === `${ pathname }${ search }${ hash }` ) {
		return;
	}
	if ( push ) {
		window.history.pushState( null, '', url );
	} else {
		window.history.replaceState( window.history.state, '', url );
	}
}
