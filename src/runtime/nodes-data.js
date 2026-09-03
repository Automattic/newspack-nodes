/**
 * The one reader of `window.NewspackNodesData`, the payload PHP localizes onto
 * every page that enqueues a substrate bundle: the REST base the boundary nodes
 * build their URLs from, and the `wp_rest` nonce they authenticate with.
 *
 * That nonce is request-scoped, which is why it arrives on a per-page global
 * instead of in a node's `make_node` arguments — one baked into a `.tsl` would
 * be stale before the graph came up. Renewal writes back into the same global,
 * so SseIn, the command transport and the `/auth` client share one credential
 * and one renewal serves all three.
 */

import apiFetch from '@wordpress/api-fetch';

/**
 * The renewal in flight, shared by every concurrent caller so a burst of
 * expired-nonce failures across the boundaries buys one request rather than one
 * each. Cleared when the request settles, so a rejection cannot latch and the
 * next failure retries.
 *
 * @type {?Promise<string>}
 */
let nonceRefreshPromise = null;

/**
 * The subset of the PHP-localized payload this module reads and writes. Admin
 * localizes many more per-screen keys onto the same global; both of these are
 * absent on a page that enqueued a bundle without them.
 *
 * @typedef {Object} NodesLocalizedData
 * @property {string} [restUrl] REST base the boundary nodes build URLs from.
 * @property {string} [nonce]   Request-scoped `wp_rest` nonce, replaced in
 *                              place by `refreshNodesNonce()`.
 */

/**
 * `window` carrying the localize payload PHP writes before any bundle runs.
 *
 * @typedef {Window & {
 *     NewspackNodesData?: NodesLocalizedData,
 * }} NodesDataWindow
 */

/**
 * Read the localized REST base and nonce, defaulting each field on its own. The
 * defaults keep a bundle running on a page that localized neither: requests go
 * to the default REST root carrying no nonce, so they are refused at the server
 * rather than throwing inside the graph.
 *
 * @return {{ restUrl: string, nonce: string }} The localized data, defaulted.
 */
export function nodesData() {
	/** @type {NodesLocalizedData} */
	const data =
		( typeof window !== 'undefined' &&
			/** @type {NodesDataWindow} */ ( window ).NewspackNodesData ) ||
		{};
	return {
		restUrl: data.restUrl || '/wp-json/',
		nonce: data.nonce || '',
	};
}

/**
 * Renew the page's REST nonce through `apiFetch.nonceEndpoint`, the refresh URL
 * WordPress localizes for `wp-api-fetch`. The fresh value lands in both the
 * localized global and `apiFetch.nonceMiddleware`, so the node graph and every
 * `apiFetch` call on the page carry on with the same credential.
 *
 * Every failure rejects instead of resolving something unusable: no endpoint to
 * ask, no global to write back into, a non-OK response, or a body that is empty
 * or `-1`, which is what admin-ajax answers once the session is gone. Resolving
 * `-1` would hand every later request a nonce the server refuses while the
 * renewal path reported success.
 *
 * @return {Promise<string>} The fresh REST nonce.
 */
export function refreshNodesNonce() {
	if ( nonceRefreshPromise ) {
		return nonceRefreshPromise;
	}
	if ( ! apiFetch.nonceEndpoint ) {
		return Promise.reject(
			new Error( 'WordPress REST nonce endpoint is unavailable' )
		);
	}
	if (
		'undefined' === typeof window ||
		! ( /** @type {NodesDataWindow} */ ( window ).NewspackNodesData )
	) {
		return Promise.reject(
			new Error( 'NewspackNodesData is unavailable for nonce renewal' )
		);
	}

	nonceRefreshPromise = window
		.fetch( apiFetch.nonceEndpoint, { credentials: 'include' } )
		.then( async ( response ) => {
			if ( ! response.ok ) {
				throw new Error(
					`WordPress REST nonce renewal failed with HTTP ${ response.status }`
				);
			}
			const nonce = ( await response.text() ).trim();
			if ( '' === nonce || '-1' === nonce ) {
				throw new Error(
					'WordPress REST nonce renewal returned no nonce'
				);
			}
			/** @type {NodesDataWindow} */ ( window ).NewspackNodesData.nonce =
				nonce;
			if ( apiFetch.nonceMiddleware ) {
				apiFetch.nonceMiddleware.nonce = nonce;
			}
			return nonce;
		} )
		.finally( () => {
			nonceRefreshPromise = null;
		} );
	return nonceRefreshPromise;
}
