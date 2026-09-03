/**
 * usePanelChrome — the collapse state of the two panels flanking a
 * ConsoleShell: the class palette and the node inspector. The topology console
 * and the debug overlay both mount that shell, and this hook is where they
 * share one implementation instead of keeping two.
 *
 * Each preference outlives the page in localStorage, and the two differ in
 * scope. The palette key arrives as a parameter, so the console hands over its
 * EDIT key or its LIVE key as the mode changes and each mode keeps its own
 * answer, while the overlay — live canvas only — always passes the LIVE key.
 * The inspector reads one key on every surface, because a reader who opens it
 * wants it open wherever the shell appears.
 *
 * The skin is not part of this chrome. It is the global `<html>.theme-<slug>`
 * class that `applySkin` sets, in `src/shared/theme.js`.
 */

import { useCallback, useEffect, useState } from '@wordpress/element';
import { INSPECTOR_COLLAPSED_STORAGE_KEY } from '../themes';
import { readStorage, writeStorage } from '../../shared/utils/storage';

/**
 * Decode a stored collapse flag.
 *
 * Two exact strings carry the preference: '0' is open and '1' is collapsed.
 * Anything else takes `def`. An unset key and storage the browser refuses are
 * one answer here, because a preference nobody can read is a preference nobody
 * has set.
 *
 * @param {string}  key Storage key.
 * @param {boolean} def Value to use when storage holds neither '0' nor '1'.
 * @return {boolean} True when the panel is collapsed.
 */
function readStoredPaletteCollapsed( key, def ) {
	const stored = readStorage( key );
	if ( '0' === stored ) {
		return false;
	}
	if ( '1' === stored ) {
		return true;
	}
	return def;
}

/**
 * Own one collapse flag, persisted under `key`.
 *
 * Only `toggle` writes. The setter changes state and stores nothing, which is
 * what lets selecting a node open the inspector without overwriting what the
 * reader last chose. The shared `usePersistedState` writes on every change,
 * mount included, so it would persist that auto-open.
 *
 * @param {string}  key Storage key.
 * @param {boolean} def Value to use when storage holds no answer.
 * @return {[boolean, import('react').Dispatch<import('react').SetStateAction<boolean>>, () => void]}
 *   The flag, a setter that does not persist, and a toggle that does.
 */
function usePersistedCollapse( key, def ) {
	const [ value, setValue ] = useState( () =>
		readStoredPaletteCollapsed( key, def )
	);
	const toggle = useCallback( () => {
		setValue( ( prev ) => {
			const next = ! prev;
			writeStorage( key, next ? '1' : '0' );
			return next;
		} );
	}, [ key ] );
	return [ value, setValue, toggle ];
}

/**
 * Own the palette and inspector collapse state for one ConsoleShell.
 *
 * @param {Object}  opts                    Options.
 * @param {string}  opts.paletteKey         Storage key for the palette flag; the console swaps it per mode.
 * @param {boolean} [opts.defaultCollapsed] Palette state when storage holds no answer. The overlay and the console's view mode start collapsed; edit mode starts open, where the palette is the source of new nodes.
 * @return {{paletteCollapsed: boolean, togglePaletteCollapsed: () => void, inspectorCollapsed: boolean, setInspectorCollapsed: import('react').Dispatch<import('react').SetStateAction<boolean>>, toggleInspectorCollapsed: () => void}} Palette and inspector chrome.
 */
export function usePanelChrome( { paletteKey, defaultCollapsed = true } ) {
	const [ paletteCollapsed, setPaletteCollapsed, togglePaletteCollapsed ] =
		usePersistedCollapse( paletteKey, defaultCollapsed );
	// Reload persisted state when the key changes (console mode switch).
	useEffect( () => {
		setPaletteCollapsed(
			readStoredPaletteCollapsed( paletteKey, defaultCollapsed )
		);
	}, [ paletteKey, defaultCollapsed, setPaletteCollapsed ] );

	const [
		inspectorCollapsed,
		setInspectorCollapsed,
		toggleInspectorCollapsed,
	] = usePersistedCollapse( INSPECTOR_COLLAPSED_STORAGE_KEY, true );

	return {
		paletteCollapsed,
		togglePaletteCollapsed,
		inspectorCollapsed,
		setInspectorCollapsed,
		toggleInspectorCollapsed,
	};
}
