import { useCallback, useEffect, useState } from '@wordpress/element';
import { INSPECTOR_COLLAPSED_STORAGE_KEY } from '../themes';

// Stored '0' = open, '1' = collapsed; absent/disabled storage uses the default.
function readStoredPaletteCollapsed( key, def ) {
	try {
		const stored = window.localStorage.getItem( key );
		if ( '0' === stored ) {
			return false;
		}
		if ( '1' === stored ) {
			return true;
		}
		return def;
	} catch ( _err ) {
		return def;
	}
}

// Boolean collapse-state persisted to localStorage ('0' open / '1' collapsed).
function usePersistedCollapse( key, def ) {
	const [ value, setValue ] = useState( () =>
		readStoredPaletteCollapsed( key, def )
	);
	const toggle = useCallback( () => {
		setValue( ( prev ) => {
			const next = ! prev;
			try {
				window.localStorage.setItem( key, next ? '1' : '0' );
			} catch ( _err ) {
				// localStorage disabled/quota'd; in-session only.
			}
			return next;
		} );
	}, [ key ] );
	return [ value, setValue, toggle ];
}

/**
 * Shared panel chrome for the debug overlay and topology console: the
 * palette-collapsed toggle + the inspector-collapsed toggle. The palette key is
 * injected so the console can pick the LIVE vs EDIT key by mode; the overlay
 * (live-only) passes the LIVE key. (The skin is NOT here — it's the global
 * `<html>.theme-<slug>` class, see shared/theme.js `applySkin`.)
 *
 * @param {Object}  opts                    Options.
 * @param {string}  opts.paletteKey         localStorage key for palette-collapsed.
 * @param {boolean} [opts.defaultCollapsed] Palette default when storage is empty (live: collapsed; edit: open).
 * @return {{ paletteCollapsed: boolean, togglePaletteCollapsed: Function, inspectorCollapsed: boolean, setInspectorCollapsed: Function, toggleInspectorCollapsed: Function }} Palette + inspector chrome.
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

	// Inspector collapse: global pref shared console+overlay; default collapsed.
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
