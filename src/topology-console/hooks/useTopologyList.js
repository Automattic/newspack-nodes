/**
 * useTopologyList — the catalog of saved topologies, held as reconciled state.
 * `reload()` refetches after a save; a refused fetch re-establishes itself
 * rather than leaving the OPEN dialog permanently empty.
 */

import { useCallback, useState } from '@wordpress/element';
import useReconcile from '@newspack-nodes/shared/hooks/useReconcile';
import { formatCommandArgs } from '../../runtime/command-args';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

export function useTopologyList( { enabled = false } = {} ) {
	const [ topologies, setTopologies ] = useState( [] );
	const [ userDir, setUserDir ] = useState( '' );
	const [ reloadKey, setReloadKey ] = useState( 0 );

	const load = useCallback( async () => {
		const message = await getCommandClient().send( {
			to: 'topologies',
			verb: 'list',
		} );
		const body = unwrapCommandResponse( message );
		setTopologies( body?.topologies || [] );
		setUserDir( body?.user_dir || '' );
	}, [] );

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
 */
export function useTopology() {
	return useCallback( async ( name ) => {
		const message = await getCommandClient().send( {
			to: 'topologies',
			verb: 'get',
			args: formatCommandArgs( [ name ] ),
		} );
		return unwrapCommandResponse( message );
	}, [] );
}
