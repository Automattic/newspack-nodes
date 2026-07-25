/**
 * useDeepLinkedSelection — the `?param=` deep-link contract both log-stream
 * dashboards share: seed the selection from the URL exactly ONCE, on the first
 * non-empty catalog (a key that only arrives in a later catalog must not
 * override what the user has since picked), and reflect every user pick back
 * into the URL param.
 */

import { useCallback, useEffect, useRef } from '@wordpress/element';
import { getQueryParam, setQueryParam } from '../utils/queryParams';

/**
 * @param {Object}   props          Props.
 * @param {string}   props.param    The query-string parameter name.
 * @param {string[]} props.keys     The catalog's selectable keys.
 * @param {string}   props.selected The currently-selected key.
 * @param {Function} props.select   `(key) => void` — switch the selection.
 * @return {Function} `(key) => void` — select AND reflect into `?param=`.
 */
export default function useDeepLinkedSelection( {
	param,
	keys,
	selected,
	select,
} ) {
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
