/**
 * useVaults — the vault catalog behind the vault_id dropdown, held as reconciled
 * state and mapped to the {id,url} option shape.
 *
 * The `fetched` latch used to be set BEFORE the request, so a single failure
 * blocked the list for the life of the page. The loop now owns whether another
 * attempt is due, and an auth invalidation re-establishes it.
 */

import { useCallback, useState } from '@wordpress/element';
import useReconcile from '@newspack-nodes/shared/hooks/useReconcile';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';

export function useVaults( { enabled = false } = {} ) {
	const [ vaults, setVaults ] = useState( [] );
	const request = useRequestNode( 'vault:list', 'vault' );

	const load = useCallback( async () => {
		const body = ( await request( 'list' ) ) || {};
		setVaults(
			Object.values( body ).map( ( v ) => ( {
				id: v.id,
				url: v.url ?? '',
			} ) )
		);
	}, [ request ] );

	const { settled, error } = useReconcile( { load, enabled } );

	return { vaults, loading: enabled && ! settled && ! error, error };
}
