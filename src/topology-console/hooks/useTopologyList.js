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
 *
 * Dispatches via the M4 CommandClient pipe: `topologies.list` / `.get`.
 */

import { useCallback, useEffect, useState } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

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
		getCommandClient()
			.send( { to: 'topologies', verb: 'list' } )
			.then( ( message ) => {
				const body = unwrapCommandResponse( message );
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
		const message = await getCommandClient().send( {
			to: 'topologies',
			verb: 'get',
			args: { name },
		} );
		return unwrapCommandResponse( message );
	}, [] );
}
