/**
 * useTopologyList — the catalog of saved topologies, held as reconciled state.
 * `reload()` refetches after a save; a refused fetch re-establishes itself
 * rather than leaving the OPEN dialog permanently empty.
 */

import { useCallback, useState } from '@wordpress/element';
import useReconcile from '@newspack-nodes/shared/hooks/useReconcile';
import { formatCommandArgs } from '../../runtime/command-args';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';

/**
 * Fetch the saved-topology catalog and hold it as reconciled state.
 *
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] False parks the loop, so a closed dialog fetches nothing.
 * @return {{topologies: Object[], userDir: string, loading: boolean, error: Error|null, reload: Function}}
 *   `topologies` are the catalog entries (`name`, `source`, `active`,
 *   `num_partitions`, `frontmatter`); `userDir` is the writable topology
 *   directory, empty when none is configured; `reload()` refetches, which a
 *   save or delete owes the catalog.
 */
export function useTopologyList( { enabled = false } = {} ) {
	const [ topologies, setTopologies ] = useState( [] );
	const [ userDir, setUserDir ] = useState( '' );
	const [ reloadKey, setReloadKey ] = useState( 0 );
	const request = useRequestNode( 'topologies:list', 'topologies' );

	const load = useCallback( async () => {
		const body = await request( 'list' );
		setTopologies( body?.topologies || [] );
		setUserDir( body?.user_dir || '' );
	}, [ request ] );

	const { settled, error } = useReconcile( {
		load,
		enabled,
		deps: [ reloadKey ],
	} );

	const reload = useCallback( () => setReloadKey( ( k ) => k + 1 ), [] );

	return {
		topologies,
		userDir,
		loading: enabled && ! settled && ! error,
		error,
		reload,
	};
}

/**
 * useTopology — fetch a single topology's TSL body by name. Returns
 * an `open(name)` callback that resolves to { name, source, tsl }.
 *
 * @param {Object}  [o]         Options.
 * @param {boolean} [o.enabled] False leaves the Request node unmounted.
 * @return {Function} `( name ) => Promise<{name, source, tsl}>`.
 */
export function useTopology( { enabled = true } = {} ) {
	const request = useRequestNode( 'topologies:get', 'topologies', enabled );
	return useCallback(
		( name ) => request( 'get', formatCommandArgs( [ name ] ) ),
		[ request ]
	);
}
