/**
 * useClassCatalog — lazily fetch the class catalog once, either when enabled or
 * when a caller needs to await the exact catalog used to fold a topology.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import { getCommandClient } from '../utils/commandClient';
import unwrapCommandResponse from '../utils/unwrapCommandResponse';

export function useClassCatalog( { enabled = false } = {} ) {
	const [ classes, setClasses ] = useState( [] );
	const [ formatters, setFormatters ] = useState( [] );
	const [ loading, setLoading ] = useState( false );
	const [ error, setError ] = useState( null );
	const request = useRef( null );

	const load = useCallback( () => {
		if ( request.current ) {
			return request.current;
		}

		setLoading( true );
		setError( null );
		request.current = Promise.resolve()
			.then( () =>
				getCommandClient().send( { to: 'classes', verb: 'list' } )
			)
			.then( ( message ) => {
				const body = unwrapCommandResponse( message );
				if (
					! Array.isArray( body?.classes ) ||
					! Array.isArray( body?.formatters )
				) {
					throw new Error( 'Invalid classes.list response.' );
				}
				const loaded = {
					classes: body.classes,
					formatters: body.formatters,
				};
				setClasses( loaded.classes );
				setFormatters( loaded.formatters );
				return loaded;
			} )
			.catch( ( e ) => {
				setError( e );
				throw e;
			} )
			.finally( () => setLoading( false ) );
		return request.current;
	}, [] );

	useEffect( () => {
		if ( ! enabled ) {
			return;
		}
		// Consume the rejection; this lifecycle call has no promise chain.
		load().catch( () => {} );
	}, [ enabled, load ] );

	return { classes, formatters, loading, error, load };
}
