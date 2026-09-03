/**
 * The `?param=` deep-link contract for a picker: seed the selection from the
 * URL once, then reflect every user pick back into the URL. Both log-stream
 * dashboards use it — the Log Viewer for `?source=`, the Partition Viewer for
 * `?log=`.
 *
 * Seeding spends its one chance on the first NON-EMPTY catalog. An empty
 * catalog has not loaded, so seeding there would drop the link; a key that
 * arrives only in a later catalog must not override what the user has picked
 * in the meantime.
 *
 * The URL is an entry point, not the state: `select` owns the selection, and
 * only a user's pick is written back. A default the catalog picks for itself
 * stays out of the URL, so a bare link keeps meaning "whatever this dashboard
 * opens on".
 */

import { useCallback, useEffect, useRef } from '@wordpress/element';
import { getQueryParam, setQueryParam } from '../utils/queryParams';

/**
 * Own the URL half of a picker's selection.
 *
 * The returned callback replaces `select` at the call site, because it does
 * both jobs: a picker still wired to `select` alone changes the selection and
 * leaves the link pointing at the previous one.
 *
 * @param {Object}                props          Props.
 * @param {string}                props.param    The query-string parameter
 *                                               name, read on the first
 *                                               render.
 * @param {string[]}              props.keys     The catalog's selectable
 *                                               keys; empty until it loads.
 * @param {string}                props.selected The currently selected key.
 * @param {(key: string) => void} props.select   Switch the selection.
 * @return {(key: string) => void} Select the key and reflect it into
 *                                 `?param=`.
 */
export default function useDeepLinkedSelection( {
	param,
	keys,
	selected,
	select,
} ) {
	// Captured before the first pick can rewrite the param under it.
	const urlKeyRef = useRef( getQueryParam( param ) );
	const seededRef = useRef( false );

	useEffect( () => {
		if ( seededRef.current || 0 === keys.length ) {
			return;
		}
		seededRef.current = true;
		const urlKey = urlKeyRef.current;
		if ( urlKey && keys.includes( urlKey ) && urlKey !== selected ) {
			select( urlKey );
		}
	}, [ keys, selected, select ] );

	return useCallback(
		( key ) => {
			select( key );
			setQueryParam( param, key );
		},
		[ param, select ]
	);
}
