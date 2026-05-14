/**
 * useDeleteTopology — DELETE /newspack-nodes/v1/topologies/{name}.
 *
 * Removes the operator-saved copy of a topology from `{user_dir}/`.
 * Stock TSL files (shipped with plugins) are never touched — the
 * controller's `delete_topology` returns 404 if there's no user
 * copy. After a successful delete, the topology either reverts to
 * its stock copy (if one exists) or disappears from the list
 * entirely; callers should refetch the list to pick up either case.
 *
 * Same nonce dance as useSaveTopology: per-action `save_nonce` query
 * param, sidestepping apiFetch's wp_rest X-WP-Nonce injection.
 */

import { useCallback } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';

export function useDeleteTopology() {
	return useCallback( async ( { name } ) => {
		const nonce =
			( window.NewspackNodesData &&
				window.NewspackNodesData.saveTopologyNonce ) ||
			'';
		return apiFetch( {
			path: `/newspack-nodes/v1/topologies/${ encodeURIComponent(
				name
			) }?save_nonce=${ encodeURIComponent( nonce ) }`,
			method: 'DELETE',
			parse: true,
		} );
	}, [] );
}
