/**
 * useSaveTopology — POST /newspack-nodes/v1/topologies/{name}.
 *
 * Wraps apiFetch with the right query string (?_wpnonce=…) and body
 * type. Returns the server's response body verbatim:
 *   { name, path, shadows_stock, restarted_fleets }
 * 4xx errors throw with `e.data.code` / `e.data.message` populated by
 * apiFetch's standard rejection shape.
 *
 * Why save_nonce as a custom query param: WordPress's apiFetch nonce
 * middleware injects the wp_rest nonce in X-WP-Nonce on every request
 * and supersedes ours, so a per-action nonce passed via header is
 * silently overwritten. The standard `_wpnonce` query param IS
 * available — but WP's cookie auth layer reads it first and verifies
 * it against the `wp_rest` action, which our save-topology nonce
 * obviously fails. A non-standard param name (`save_nonce`) sidesteps
 * the cookie auth path; the controller reads it explicitly.
 */

import { useCallback } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';

export function useSaveTopology() {
	return useCallback( async ( { name, tsl } ) => {
		const nonce =
			( window.NewspackNodesData &&
				window.NewspackNodesData.saveTopologyNonce ) ||
			'';
		return apiFetch( {
			path: `/newspack-nodes/v1/topologies/${ encodeURIComponent(
				name
			) }?save_nonce=${ encodeURIComponent( nonce ) }`,
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: tsl,
			parse: true,
		} );
	}, [] );
}
