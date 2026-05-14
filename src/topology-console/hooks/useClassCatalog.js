/**
 * useClassCatalog — fetch the substrate class catalog for the palette.
 *
 * Lazy: nothing happens until `enabled` is true (so view-mode never
 * pays the cost). First-truthy `enabled` triggers a single
 * `GET /newspack-nodes/v1/classes` round-trip; result is cached in
 * component state for the rest of the session — toggling enabled
 * off → on doesn't re-fetch.
 *
 * Smoke-tested via the topology console's edit-mode entry; covered
 * end-to-end in A5's Task 11 browser smoke.
 */

import { useEffect, useRef, useState } from '@wordpress/element';
import apiFetch from '@wordpress/api-fetch';

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
		apiFetch( { path: '/newspack-nodes/v1/classes' } )
			.then( ( body ) => {
				setClasses( body?.classes || [] );
				setFormatters( body?.formatters || [] );
			} )
			.catch( ( e ) => setError( e ) )
			.finally( () => setLoading( false ) );
	}, [ enabled ] );

	return { classes, formatters, loading, error };
}
