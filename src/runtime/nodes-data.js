import apiFetch from '@wordpress/api-fetch';

let nonceRefreshPromise = null;

/**
 * nodesData — read the PHP-localized `window.NewspackNodesData` (the REST base +
 * command nonce the SSE/HTTP boundary nodes need) with safe defaults. The nonce
 * is request-scoped, so it lives in this per-page global — NOT in a node's
 * make_node arguments; a nonce baked into a `.tsl` would be stale on load.
 *
 * @return {{ restUrl: string, nonce: string }} The localized data, defaulted.
 */
export function nodesData() {
	const data =
		( typeof window !== 'undefined' && window.NewspackNodesData ) || {};
	return {
		restUrl: data.restUrl || '/wp-json/',
		nonce: data.nonce || '',
	};
}

/**
 * Renew the page's REST nonce through WordPress's canonical refresh endpoint.
 * Concurrent SSE/HTTP failures share one request and every boundary reads the
 * same updated localized value afterward.
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
	if ( 'undefined' === typeof window || ! window.NewspackNodesData ) {
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
			window.NewspackNodesData.nonce = nonce;
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
