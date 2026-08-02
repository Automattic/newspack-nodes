/**
 * useClassCatalog — the substrate class catalog behind the palette, held as
 * reconciled state rather than fetched once.
 *
 * It used to memoise the in-flight promise forever, so a catalog that failed
 * once stayed failed: every later load() handed back the same rejected promise
 * and the palette was empty until a reload. The overnight tab hit exactly that
 * — the catalog loaded fine at mount, the session expired an hour later, and
 * nothing ever asked again.
 */

import { useCallback, useEffect, useRef, useState } from '@wordpress/element';
import useReconcile from '@newspack-nodes/shared/hooks/useReconcile';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';

export function useClassCatalog( { enabled = false } = {} ) {
	const [ classes, setClasses ] = useState( [] );
	const [ formatters, setFormatters ] = useState( [] );
	const [ loading, setLoading ] = useState( false );
	const [ error, setError ] = useState( null );

	// Resolved catalog; a caller awaiting load() mid-flow reuses it.
	const cached = useRef( null );
	// In-flight request, so concurrent callers share ONE round trip.
	const inflight = useRef( null );

	const request = useRequestNode( 'classes:list', 'classes' );

	const load = useCallback( () => {
		if ( cached.current ) {
			return Promise.resolve( cached.current );
		}
		if ( inflight.current ) {
			return inflight.current;
		}

		setLoading( true );
		setError( null );
		inflight.current = request( 'list' )
			.then( ( body ) => {
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
				cached.current = loaded;
				setClasses( loaded.classes );
				setFormatters( loaded.formatters );
				return loaded;
			} )
			.catch( ( e ) => {
				setError( e );
				throw e;
			} )
			.finally( () => {
				// Cleared either way: a failure must not be cached as one.
				inflight.current = null;
				setLoading( false );
			} );
		return inflight.current;
	}, [ request ] );

	const { settled } = useReconcile( { load, enabled } );

	// Unsettled means the cache is no longer trustworthy — drop it.
	useEffect( () => {
		if ( ! settled ) {
			cached.current = null;
		}
	}, [ settled ] );

	return { classes, formatters, loading, error, load };
}
