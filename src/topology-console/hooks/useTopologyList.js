/**
 * useTopologyList — fetch the substrate's catalog of saved topologies.
 *
 * Lazy: nothing happens until `enabled` flips true (only matters when
 * the OpenModal is being shown). Returned shape:
 *   {
 *     topologies: [
 *       { name, source: 'stock'|'user'|'both', active, frontmatter },
 *       ...
 *     ],
 *     userDir: string,
 *     loading, error, reload,
 *   }
 *
 * `reload()` triggers a refetch — used after a save so the picker
 * reflects newly-written user topologies without a page reload.
 */

import { useCallback, useEffect, useState } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';

export function useTopologyList( { enabled = false } = {} ) {
	const [ topologies, setTopologies ] = useState( [] );
	const [ userDir, setUserDir ] = useState( '' );
	const [ loading, setLoading ] = useState( false );
	const [ error, setError ] = useState( null );
	const [ reloadKey, setReloadKey ] = useState( 0 );

	useEffect( () => {
		if ( ! enabled ) {
			return;
		}
		setLoading( true );
		apiFetch( { path: '/newspack-nodes/v1/topologies' } )
			.then( ( body ) => {
				setTopologies( body?.topologies || [] );
				setUserDir( body?.user_dir || '' );
			} )
			.catch( ( e ) => setError( e ) )
			.finally( () => setLoading( false ) );
	}, [ enabled, reloadKey ] );

	const reload = useCallback( () => setReloadKey( ( k ) => k + 1 ), [] );

	return { topologies, userDir, loading, error, reload };
}

/**
 * useTopology — fetch a single topology's TSL body by name. Returns
 * an `open(name)` callback that resolves to { name, source, tsl }.
 */
export function useTopology() {
	return useCallback( async ( name ) => {
		return apiFetch( {
			path: `/newspack-nodes/v1/topologies/${ encodeURIComponent(
				name
			) }`,
		} );
	}, [] );
}
