/**
 * useQueryParamState — dashboard state the address bar names.
 *
 * The URL twin of `usePersistedState`: the same restore and encode pair, with
 * `?param=` in place of localStorage, so a copied link reopens the same view.
 * The bar is the state's mirror, never its owner. It seeds the value once on
 * mount, and every later write goes through `setQueryParam`'s replaceState,
 * because a filter is state rather than navigation and earns no Back entry of
 * its own.
 *
 * A page can still push entries of its own — a `?url=`-style navigation — and
 * each carries the filters current when it was pushed. The view keeps its
 * filters across Back and Forward, so the hook writes the live value back over
 * the restored entry rather than let the bar name a view nobody is looking at.
 *
 * Canonical in newspack-nodes, consumed through the `@newspack-nodes/shared`
 * alias.
 */

import { useState, useEffect } from '@wordpress/element';
import { getQueryParam, setQueryParam } from '../utils/queryParams';

/**
 * Own a value mirrored into `?param=`.
 *
 * The write keys on the ENCODED string, so it fires when what the bar should
 * say changes, never on a bare re-render, and `encode` need not be stable. It
 * also runs on mount, which drops a value `restore` rejected and a default
 * written out longhand: a bare link means the dashboard's defaults.
 *
 * @template T
 * @param {string}                param   Query-string parameter name.
 * @param {(raw: ?string) => T}   restore Decode and validate the param's
 *                                        value; receives null when absent.
 * @param {(value: T) => ?string} encode  The param's value; null or '' omits it.
 * @return {[T, import('react').Dispatch<import('react').SetStateAction<T>>]}
 *   The value and React's own setter.
 */
export function useQueryParamState( param, restore, encode ) {
	const [ value, setValue ] = useState( () =>
		restore( getQueryParam( param ) )
	);
	const encoded = encode( value );

	useEffect( () => {
		const write = () => setQueryParam( param, encoded );
		write();
		window.addEventListener( 'popstate', write );
		return () => window.removeEventListener( 'popstate', write );
	}, [ param, encoded ] );

	return [ value, setValue ];
}

/**
 * Own a choice from a list, the shape of every dropdown and sort key.
 *
 * `values` is the validation whitelist, so a link naming a choice a fixed list
 * does not offer opens on `fallback`. A list that arrives with a reply passes
 * null until then, and the link is trusted meanwhile: the hook answers its
 * value at once, and drops it, bar and all, if the landed list lacks it. An
 * empty list judges nothing — a refused or empty reply is not a verdict — so
 * it is trusted the same way.
 *
 * @param {string}    param    Query-string parameter name.
 * @param {?string[]} values   Every choice the control offers; null or
 *                             empty while the list has not loaded.
 * @param {string}    fallback The default, which the bar leaves out.
 * @return {[string, import('react').Dispatch<import('react').SetStateAction<string>>]}
 *   The choice and its setter.
 */
export function useQueryParamChoice( param, values, fallback ) {
	const [ choice, setChoice ] = useQueryParamState(
		param,
		( raw ) => raw ?? fallback,
		( value ) => ( value === fallback ? null : value )
	);
	const shown =
		! values?.length || values.includes( choice ) ? choice : fallback;

	useEffect( () => {
		if ( shown !== choice ) {
			setChoice( shown );
		}
	}, [ shown, choice, setChoice ] );

	return [ shown, setChoice ];
}

/**
 * Own an off-by-default toggle, written `?param=1` while on.
 *
 * @param {string} param Query-string parameter name.
 * @return {[boolean, import('react').Dispatch<import('react').SetStateAction<boolean>>]}
 *   Whether it is on, and its setter.
 */
export function useQueryParamFlag( param ) {
	return useQueryParamState(
		param,
		( raw ) => '1' === raw,
		( on ) => ( on ? '1' : null )
	);
}
