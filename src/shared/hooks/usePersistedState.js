/**
 * usePersistedState — state that outlives the page, in one place.
 *
 * A dashboard preference runs the same four steps: read the key, validate what
 * came back against what the UI still offers, fall back when nothing usable
 * survived, then write it back in an effect. Only the codec and the
 * cardinality differ, so both are the caller's: `restore` decodes and
 * validates, `encode` serializes.
 *
 * @package
 */

import { useState, useEffect } from '@wordpress/element';
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
