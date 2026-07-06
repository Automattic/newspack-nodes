/**
 * useVaults — lazily fetch the vault catalog (one `vault.list` call on first
 * truthy `enabled`, then cached for the session), mapped to the {id,url}
 * option shape the vault_id dropdown consumes. Mirrors useClassCatalog.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

export function useVaults( { enabled = false } = {} ) {
	const [ vaults, setVaults ] = useState( [] );
	const [ loading, setLoading ] = useState( false );
	const [ error, setError ] = useState( null );
	const fetched = useRef( false );

	useEffect( () => {
		if ( ! enabled || fetched.current ) {
			return;
		}
		fetched.current = true;
		setLoading( true );
		getCommandClient()
			.send( { to: 'vault', verb: 'list' } )
			.then( ( message ) => {
				const body = unwrapCommandResponse( message ) || {};
				setVaults(
					Object.values( body ).map( ( v ) => ( {
						id: v.id,
						url: v.url ?? '',
					} ) )
				);
			} )
			.catch( ( e ) => setError( e ) )
			.finally( () => setLoading( false ) );
	}, [ enabled ] );

	return { vaults, loading, error };
}
