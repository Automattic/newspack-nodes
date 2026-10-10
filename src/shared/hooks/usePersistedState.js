/**
 * usePersistedState — state that outlives the page, in one place.
 *
 * `usePersistedState` and `usePersistedChoice` run the same four steps: read
 * the key, validate what came back against what the UI still offers, fall
 * back when nothing usable survived, then write it back in an effect. Only
 * the codec and the cardinality differ, so both are the caller's: `restore`
 * decodes and validates, `encode` serializes. `usePersistedFlag` stores a
 * boolean only when the reader toggles it.
 *
 * @package
 */

import { useCallback, useEffect, useState } from '@wordpress/element';
import { readStorage, writeStorage } from '../utils/storage';

/**
 * Own a value persisted under `key`.
 *
 * The setter is React's own, so it takes either a value or an updater —
 * `useColumnPicker` toggles one column off the previous selection that way.
 *
 * `encode` joins the write effect's dependencies, so pass a stable reference
 * (`String`, `JSON.stringify`, a module-scope function) — an inline arrow
 * rewrites storage on every render.
 *
 * The effect also runs on mount, which writes the fallback back on a first
 * visit. Changing that fallback later therefore moves nobody who has already
 * loaded the page; only a value `restore` rejects sends them to the new one.
 * A boolean that should store nothing until the reader acts takes
 * `usePersistedFlag` instead.
 *
 * @template T
 * @param {string}               key     localStorage key.
 * @param {(raw: ?string) => T}  restore Decode and validate the stored string;
 *                                       receives null when nothing is stored.
 * @param {(value: T) => string} encode  Serialize for storage.
 * @return {[T, import('react').Dispatch<import('react').SetStateAction<T>>]}
 *   The value and its setter.
 */
export function usePersistedState( key, restore, encode ) {
	const [ value, setValue ] = useState( () => restore( readStorage( key ) ) );

	useEffect( () => {
		writeStorage( key, encode( value ) );
	}, [ key, value, encode ] );

	return [ value, setValue ];
}

/**
 * Own a choice from a fixed option list, the shape every refresh-interval
 * dropdown takes.
 *
 * Matching the stored text against each option's own `String( value )` is what
 * lets one hook serve both the Gyroscope's numeric seconds and the Performance
 * dashboard's string milliseconds: the restored value comes back in the
 * option's type, not storage's.
 *
 * `options` doubles as the validation whitelist, so a stored value the list no
 * longer offers takes `fallback` rather than selecting something the dropdown
 * cannot render.
 *
 * @template {string|number} T
 * @param {string}            key      localStorage key.
 * @param {Array<{value: T}>} options  The dropdown's options.
 * @param {T}                 fallback Choice to use when nothing usable is stored.
 * @return {[T, import('react').Dispatch<import('react').SetStateAction<T>>]}
 *   The choice and its setter.
 */
export function usePersistedChoice( key, options, fallback ) {
	return usePersistedState(
		key,
		( raw ) =>
			options.find( ( opt ) => String( opt.value ) === String( raw ) )
				?.value ?? fallback,
		String
	);
}

/**
 * Read a stored flag: '1' is true, '0' is false, anything else is `def`.
 *
 * @param {string}  key Storage key.
 * @param {boolean} def Value when storage holds neither '1' nor '0'.
 * @return {boolean} The flag.
 */
function readFlag( key, def ) {
	const stored = readStorage( key );
	if ( '1' === stored ) {
		return true;
	}
	return '0' === stored ? false : def;
}

/**
 * Own a boolean persisted under `key` as '1' or '0'.
 *
 * Only `toggle` stores, so an untouched flag keeps following `def`; the
 * setter changes state without storing it. A changed `key` or `def` re-reads
 * storage during render, so no render answers with the previous key's value
 * and nothing writes one key's value under another.
 *
 * @param {string}  key Storage key.
 * @param {boolean} def Value when storage holds no answer.
 * @return {[boolean, import('react').Dispatch<import('react').SetStateAction<boolean>>, () => void]}
 *   The flag, a setter that does not persist, and a toggle that does.
 */
export function usePersistedFlag( key, def ) {
	const [ state, setState ] = useState( () => ( {
		key,
		def,
		value: readFlag( key, def ),
	} ) );
	let current = state;
	if ( state.key !== key || state.def !== def ) {
		current = { key, def, value: readFlag( key, def ) };
		setState( current );
	}
	const { value } = current;
	const set = useCallback(
		( next ) =>
			setState( ( prev ) => ( {
				...prev,
				value: 'function' === typeof next ? next( prev.value ) : next,
			} ) ),
		[]
	);
	const toggle = useCallback( () => {
		writeStorage( key, value ? '0' : '1' );
		set( ! value );
	}, [ key, value, set ] );
	return [ value, set, toggle ];
}
