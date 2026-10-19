/**
 * useQueryParamState — dashboard state the address bar names.
 *
 * The URL twin of `usePersistedState`: the same restore and encode pair, with
 * `?param=` in place of localStorage, so a copied link reopens the same view.
 * The bar is the state's mirror, never its owner. It seeds the value once on
 * mount, and every later write goes through `setQueryParams`' replaceState,
 * because a filter is state rather than navigation and earns no Back entry of
 * its own. `useQueryParamList` is the twin for a list, written as one repeated
 * `?param=` per item. Every hook here takes a last `{ written }` option that
 * holds its value off the bar while the view it belongs to is shut, so no
 * caller hand-writes a gated encoder.
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
import {
	getQueryParam,
	getQueryParams,
	setQueryParams,
} from '../utils/queryParams';

/**
 * Own a value mirrored into `?param=`.
 *
 * @template T
 * @param {string}                param     Query-string parameter name.
 * @param {(raw: ?string) => T}   restore   Decode and validate the param's
 *                                          value; receives null when absent.
 * @param {(value: T) => ?string} encode    The param's value; null or ''
 *                                          omits it.
 * @param {{written?: boolean}}   [options] `written` false holds the value
 *                                          off the bar; true by default.
 * @return {[T, import('react').Dispatch<import('react').SetStateAction<T>>]}
 *   The value and React's own setter.
 */
export function useQueryParamState( param, restore, encode, options ) {
	return useMirroredParam(
		param,
		getQueryParam,
		null,
		restore,
		encode,
		options
	);
}

/**
 * Own a value mirrored into a repeated `?param=a&param=b`, one entry per item,
 * so an item may hold any character.
 *
 * @template T
 * @param {string}                 param     Query-string parameter name.
 * @param {(raw: string[]) => T}   restore   Decode and validate every value
 *                                           the param holds; receives [] when
 *                                           absent.
 * @param {(value: T) => string[]} encode    The param's values; [] omits it.
 * @param {{written?: boolean}}    [options] `written` false holds the list
 *                                           off the bar; true by default.
 * @return {[T, import('react').Dispatch<import('react').SetStateAction<T>>]}
 *   The value and React's own setter.
 */
export function useQueryParamList( param, restore, encode, options ) {
	return useMirroredParam(
		param,
		getQueryParams,
		[],
		restore,
		encode,
		options
	);
}

/**
 * Own a value the bar mirrors, read once on mount through `read` and written
 * back on mount, on each change and over every entry Back or Forward restores.
 *
 * The write keys on the ENCODED value as the bar would hold it, so it fires
 * when what the bar should say changes, never on a bare re-render, a fresh
 * array holding the same items or '' in place of null, and `encode` need not
 * be stable. The mount write drops a value `restore` rejected and a default
 * written out longhand: a bare link means the dashboard's defaults.
 *
 * `written` false holds the value off the bar, for state whose view is shut:
 * it is restored and kept as ever, the bar is handed `empty` in its place, and
 * the bar names it again once `written` turns true. A value naming nothing
 * keeps its key as `written` flips, so it neither writes nor re-subscribes.
 *
 * @template T
 * @param {string}                           param             Param name.
 * @param {(name: string) => *}              read              `getQueryParam`
 *                                                             or
 *                                                             `getQueryParams`.
 * @param {?(string[])}                      empty             What the bar is
 *                                                             handed while it
 *                                                             names nothing.
 * @param {(raw: *) => T}                    restore           Decode and
 *                                                             validate a read.
 * @param {(value: T) => ?(string|string[])} encode            The bar's value.
 * @param {Object}                           [options]         Options.
 * @param {boolean}                          [options.written] Whether the bar
 *                                                             names the value;
 *                                                             true by default.
 * @return {[T, import('react').Dispatch<import('react').SetStateAction<T>>]}
 *   The value and React's own setter.
 */
function useMirroredParam(
	param,
	read,
	empty,
	restore,
	encode,
	{ written = true } = {}
) {
	const [ value, setValue ] = useState( () => restore( read( param ) ) );
	const key = JSON.stringify( barValue( written ? encode( value ) : empty ) );

	useEffect( () => {
		const write = () => setQueryParams( { [ param ]: JSON.parse( key ) } );
		write();
		window.addEventListener( 'popstate', write );
		return () => window.removeEventListener( 'popstate', write );
	}, [ param, key ] );

	return [ value, setValue ];
}

/**
 * An encoded value as the bar would hold it: '' or a missing value is null,
 * and a list keeps only its non-empty strings, so every spelling of one bar
 * serializes alike and a missing entry never reaches the bar as `null`.
 *
 * @param {?(string|Array<?string>)} encoded What `encode` returned.
 * @return {?(string|string[])} The value the bar holds.
 */
function barValue( encoded ) {
	if ( Array.isArray( encoded ) ) {
		return encoded.filter(
			( entry ) => 'string' === typeof entry && '' !== entry
		);
	}
	return '' === encoded || undefined === encoded ? null : encoded;
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
 * `written` false holds the choice off the bar, as `useQueryParamState`
 * does, and the choice is still validated.
 *
 * @param {string}    param             Query-string parameter name.
 * @param {?string[]} values            Every choice the control offers; null
 *                                      or empty while the list has not loaded.
 * @param {string}    fallback          The default, which the bar leaves out.
 * @param {Object}    [options]         Options.
 * @param {boolean}   [options.written] Whether the bar names the choice;
 *                                      true by default.
 * @return {[string, import('react').Dispatch<import('react').SetStateAction<string>>]}
 *   The choice and its setter.
 */
export function useQueryParamChoice( param, values, fallback, options ) {
	const [ choice, setChoice ] = useQueryParamState(
		param,
		( raw ) => raw ?? fallback,
		( value ) => ( value === fallback ? null : value ),
		options
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
 * @param {string}  param             Query-string parameter name.
 * @param {Object}  [options]         Options.
 * @param {boolean} [options.written] Whether the bar names the toggle, as
 *                                    `useQueryParamState` reads it; true by
 *                                    default.
 * @return {[boolean, import('react').Dispatch<import('react').SetStateAction<boolean>>]}
 *   Whether it is on, and its setter.
 */
export function useQueryParamFlag( param, options ) {
	return useQueryParamState(
		param,
		( raw ) => '1' === raw,
		( on ) => ( on ? '1' : null ),
		options
	);
}
