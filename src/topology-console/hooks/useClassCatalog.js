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

import { useCallback, useRef, useState } from '@wordpress/element';
import { authGeneration } from '@newspack-nodes/runtime';
import useReconcile from '@newspack-nodes/shared/hooks/useReconcile';
import useRequestNode from '@newspack-nodes/shared/hooks/useRequestNode';

/**
 * @param {Object}  [options]         Hook options.
 * @param {boolean} [options.enabled] Gate — false parks the reconcile loop, so
 *                                    the catalog is never requested.
 * @return {{classes: Object[], formatters: string[], loading: boolean, error: Error|null, load: () => Promise<{classes: Object[], formatters: string[]}>}}
 *   Catalog state. `classes` are the palette entries from `classes list` (one
 *   per concrete Node class, schema inlined), `formatters` their registered
 *   formatter names. `load()` resolves with both; concurrent callers share one
 *   round trip, and a failure is never cached.
 */
export function useClassCatalog( { enabled = false } = {} ) {
	const [ classes, setClasses ] = useState( [] );
	const [ formatters, setFormatters ] = useState( [] );

	// @longform
	// Resolved catalog, stamped with the auth generation it was fetched
	// under. The stamp IS the invalidation check, because it is read HERE —
	// on the same synchronous tick the reconcile loop invalidates on. An
	// effect that cleared the cache would run a render too late for this
	// read, which is how a successfully-loaded catalog outlived its session
	// and was never re-fetched.
	const cached = useRef( null );
	// In-flight request, so concurrent callers share ONE round trip.
	const inflight = useRef( null );

	const request = useRequestNode( 'classes:list', 'classes' );

	const load = useCallback( () => {
		if (
			cached.current &&
			cached.current.generation === authGeneration()
		) {
			return Promise.resolve( cached.current.value );
		}
		if ( inflight.current ) {
			return inflight.current;
		}

		// Stamped from the REQUEST: a mid-flight turnover leaves it stale.
		const generation = authGeneration();
		inflight.current = request( 'list' )
			.then( ( body ) => {
				if (
					! Array.isArray( body?.classes ) ||
					! Array.isArray( body?.formatters )
				) {
					throw new Error( 'Invalid classes.list response.' );
				}
				const value = {
					classes: body.classes,
					formatters: body.formatters,
				};
				cached.current = { generation, value };
				setClasses( value.classes );
				setFormatters( value.formatters );
				return value;
			} )
			.finally( () => {
				// Cleared either way: a failure must not be cached as one.
				inflight.current = null;
			} );
		return inflight.current;
	}, [ request ] );

	const { settled, error } = useReconcile( { load, enabled } );

	return {
		classes,
		formatters,
		loading: enabled && ! settled && ! error,
		error,
		load,
	};
}
