/**
 * The `?param=` deep-link contract for a picker: seed the selection from the
 * URL once, then reflect every user pick back into the URL. The Log
 * Viewer uses it for `?log=`.
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
 *
 * The param is one of the bundle's bar store, which `useQueryParamState`
 * reads too: a pick pushes a Back entry, and a Back or Forward landing on an
 * entry that names a key the catalog holds selects that key.
 */

import {
	useCallback,
	useEffect,
	useRef,
	useSyncExternalStore,
} from '@wordpress/element';
import { openParam, setParam, subscribeParam } from '../utils/queryParams';

/**
 * The param's codec: the key as the bar spells it, null for none, and each
 * pick a Back entry.
 *
 * @type {import('../utils/queryParams').ParamCodec}
 */
const PICK = {
	parse: ( raw ) => raw || null,
	format: ( key ) => key,
	push: true,
};

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
	const entry = openParam( param, PICK );
	const linked = useSyncExternalStore(
		useCallback(
			( listener ) => subscribeParam( entry, listener ),
			[ entry ]
		),
		() => entry.value
	);
	// The bar's key last acted on; undefined until a catalog has loaded.
	const actedRef = useRef( undefined );

	useEffect( () => {
		if ( 0 === keys.length || linked === actedRef.current ) {
			return;
		}
		actedRef.current = linked;
		if ( linked && keys.includes( linked ) && linked !== selected ) {
			select( linked );
		}
	}, [ keys, linked, selected, select ] );

	return useCallback(
		( key ) => {
			select( key );
			setParam( entry, key );
		},
		[ entry, select ]
	);
}
