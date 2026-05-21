/**
 * useClassCatalog — lazily fetch the class catalog (one `classes.list` call
 * on first truthy `enabled`, then cached for the session).
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

export function useClassCatalog( { enabled = false } = {} ) {
	const [ classes, setClasses ] = useState( [] );
	const [ formatters, setFormatters ] = useState( [] );
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
			.send( { to: 'classes', verb: 'list' } )
			.then( ( message ) => {
				const body = unwrapCommandResponse( message );
				setClasses( body?.classes || [] );
				setFormatters( body?.formatters || [] );
			} )
			.catch( ( e ) => setError( e ) )
			.finally( () => setLoading( false ) );
	}, [ enabled ] );

	return { classes, formatters, loading, error };
}
